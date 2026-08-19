# tinytable SPEC

`tinytable` is a small, dependency-free, in-memory Python table with a
WHERE/ORDER BY/LIMIT query surface, a secondary index, a unique constraint,
and nested savepoints.

This document is the **sole arbiter of correct behavior**. `clean/` is a
reference implementation of everything below; a "defect" is any observable
deviation from this spec, nothing more and nothing less. Every example in
this document is a literal Python snippet true of `clean/tinytable` today.

Rows are plain `dict`s with no fixed schema. A column absent from a row
behaves exactly like a column present with value `None` (see "NULL
semantics").

## Table

```python
from tinytable import Table

t = Table(name="people")  # name is optional/cosmetic, defaults to "table"
```

### `insert(row: dict) -> int`

Inserts a **copy** of `row` (later mutating the dict you passed in does not
affect the table) and returns a newly assigned integer row id. Row ids are
assigned in strictly increasing order starting at 0, and are never reused
even after `delete()`.

```python
t = Table()
a = t.insert({"x": 1})
b = t.insert({"x": 2})
assert a == 0 and b == 1
```

### `update(predicate, changes: dict) -> int`

Sets every key in `changes` on every row matching `predicate` (see
"Predicates" below), leaving columns not named in `changes` untouched.
Returns the number of rows updated.

```python
t = Table()
t.insert({"x": 1, "y": "keep"})
n = t.update(eq("x", 1), {"x": 2})
assert n == 1
assert t.where(eq("x", 2)).all() == [{"x": 2, "y": "keep"}]
```

Rows are processed one at a time, in ascending row-id order. This matters
only for `unique()` columns touched by the update (see "Uniqueness and
update()" below) - for everything else (query results, index contents)
`update()` behaves as if all matched rows changed atomically.

### `delete(predicate) -> int`

Deletes every row matching `predicate`. Returns the number of rows deleted.

### `create_index(column: str) -> None`

Builds a secondary index on `column` from the table's current rows (or
rebuilds it, if called again for the same column). An index is a pure
performance optimization: **a query against an indexed column must return
exactly the same rows, in the same cases, as the same query would against an
unindexed column** - this is the central invariant a range-scan bug would
violate.

```python
t = Table()
t.insert({"x": 5})
t.create_index("x")
assert [r["x"] for r in t.where(ge("x", 5)).all()] == [5]  # boundary included
```

`create_index` only accelerates `eq`/`lt`/`le`/`gt`/`ge`/`between` predicates
against that column (used alone or as one clause of an `&`-combined
predicate); every other predicate shape still works correctly, just without
the index's help.

### `unique(column: str) -> None`

Declares that `column` may hold at most one row with any given non-`None`
value. Checked immediately against the table's current rows (raises
`UniqueViolation` if a duplicate already exists), then enforced on every
subsequent `insert()`/`update()`.

**`None` never participates in uniqueness**: any number of rows may have
`None` in a `unique()` column, simultaneously.

```python
t = Table()
t.unique("email")
t.insert({"email": None})
t.insert({"email": None})  # NOT a conflict
assert len(t) == 2
```

```python
t = Table()
t.unique("email")
t.insert({"email": "a@x.com"})
t.insert({"email": "a@x.com"})  # raises UniqueViolation
```

#### Uniqueness and `update()`

`update()` validates each row's *new* value against every *other* row's
*current* value at the moment that row is processed (rows are processed in
ascending row-id order - see above). A row keeping its own existing value is
never a self-conflict:

```python
t = Table()
t.unique("email")
t.insert({"email": "a@x.com", "n": 1})
t.update(eq("email", "a@x.com"), {"n": 2})  # fine - same row, same value
```

A single `update()` call cannot swap two rows' unique values (e.g. giving
row A row B's old value and vice versa in one call) - this is explicitly
undefined/unsupported, not a scored behavior.

### `savepoint(name: str) -> None` / `rollback_to(name: str) -> None` / `commit(name=None) -> None`

`savepoint(name)` snapshots the table's **entire** state - every row, every
secondary index's contents, and every unique constraint's contents - under
`name`.

`rollback_to(name)` restores that exact snapshot: rows, index contents, and
unique-constraint contents all revert together. **A query against an
indexed column immediately after `rollback_to` must return the same result
it would if the index had never existed and was rebuilt from the restored
rows from scratch** - this is the invariant a "rollback leaves stale index
entries" bug would violate. `name` remains valid afterward (you may
`rollback_to` it again); any savepoint created after it is discarded.
Raises `NoSuchSavepoint` for an unknown name.

```python
t = Table()
t.insert({"x": 1})
t.create_index("x")
t.savepoint("s1")
t.insert({"x": 2})
t.rollback_to("s1")
assert [r["x"] for r in t.where(eq("x", 2)).all()] == []  # not a stale hit
assert [r["x"] for r in t.where(eq("x", 1)).all()] == [1]  # still found via the index
```

`commit(name)` discards that savepoint, making changes since it was created
permanent (you can no longer roll back to it). `commit()` with no argument
discards every open savepoint.

### `count(col="*")`, `min(col)`, `max(col)`

Shorthand for `select().count(col)` / `.min(col)` / `.max(col)` - see
"Aggregates" below.

## Predicates

Build predicates with these top-level functions, then pass one to
`where()`/`select()`:

| function | matches when |
|---|---|
| `eq(col, value)` | `row[col] == value` |
| `ne(col, value)` | `row[col] != value` |
| `lt(col, value)` | `row[col] < value` |
| `le(col, value)` | `row[col] <= value` |
| `gt(col, value)` | `row[col] > value` |
| `ge(col, value)` | `row[col] >= value` |
| `between(col, lo, hi)` | `lo <= row[col] <= hi` (inclusive both ends) |
| `in_(col, values)` | `row[col]` equals one of `values` |
| `is_null(col)` | `row[col] is None` |
| `not_null(col)` | `row[col] is not None` |

Combine predicates with `&` (AND), `|` (OR), and `~` (NOT):

```python
t = Table()
t.insert({"dept": "eng", "age": 30})
t.insert({"dept": "eng", "age": 22})
t.insert({"dept": "sales", "age": 40})
assert [r["age"] for r in t.where(eq("dept", "eng") & gt("age", 28)).all()] == [30]
assert sorted(r["age"] for r in t.where(eq("dept", "sales") | eq("age", 22)).all()) == [22, 40]
assert sorted(r["age"] for r in t.where(~eq("dept", "eng")).all()) == [40]
```

### NULL semantics (three-valued logic)

This is the single most important rule in this spec.

**`eq`/`ne`/`lt`/`le`/`gt`/`ge`/`between`/`in_` never match when either side
of the comparison is `None`** - including when *both* sides are `None`. A
`None` row value or a `None` comparison value makes the result "unknown,"
not "true," even for `eq(col, None)` or `ne(col, None)` (which are not
useful ways to test for NULL - use `is_null`/`not_null` instead).

```python
t = Table()
t.insert({"x": None})
assert t.where(eq("x", None)).all() == []   # None == None is NOT a match
assert t.where(ne("x", None)).all() == []   # None != None is NOT a match either
assert t.where(is_null("x")).all() == [{"x": None}]  # this is how you test for NULL
```

```python
t = Table()
t.insert({"age": None})
t.insert({"age": 30})
t.insert({"age": 25})
assert t.where(ne("age", 30)).all() == [{"age": 25}]
```

The `age=30` row fails `ne` because it *does* equal 30, and - the easy
mistake - the `age=None` row **also** fails `ne`, because NULL comparisons
never match; it does **not** silently count as "not equal to 30." A caller
who wants "every row where age isn't 30, including unknown ages" must write
`ne("age", 30) | is_null("age")` explicitly.

`in_(col, values)`: if `values` contains `None`, that `None` is simply
inert - it can never cause a `None`-valued row to match. `is_null(col)` is
the only way to match `None`.

A row with a column **missing entirely** is treated identically to that
column being present with value `None`, for every rule above.

## `where(predicate)` / `select(predicate=None)`

`where(predicate)` and `select(predicate)` both return a `Query`; `select()`
with no argument (or `select(None)`) matches every row. `Query` is
chainable:

```python
t = Table()
t.insert({"age": 30})
t.insert({"age": None})
rows = t.where(not_null("age")).order_by("age").limit(10).offset(0).all()
assert rows == [{"age": 30}]
```

Terminal operations: `.all()` (returns a new list of shallow-copied row
dicts, in the query's final order), iterating the `Query` directly
(`for row in t.where(...)`), `len(query)`, and the aggregates below.

## `order_by(col, desc=False, nulls_last=True)`

Sorts matched rows by `row[col]`.

- **Stable**: rows whose `col` value compares equal keep their relative
  insertion order, in *both* `desc=False` and `desc=True` - descending is a
  true stable descending sort, not "sort ascending then reverse the whole
  list" (which would also reverse the relative order of tied rows).
- **`None` placement**: `None` values are placed as a block, either after
  every non-`None` row (`nulls_last=True`, the default) or before every
  non-`None` row (`nulls_last=False`) - **independent of `desc`**. Flipping
  `desc` reverses the order *within* the non-`None` rows; it never moves the
  `None` block to the other end.

```python
t = Table()
t.insert({"k": 1, "tag": "a"})
t.insert({"k": 1, "tag": "b"})
assert [r["tag"] for r in t.select().order_by("k").all()] == ["a", "b"]
assert [r["tag"] for r in t.select().order_by("k", desc=True).all()] == ["a", "b"]
```

```python
t = Table()
t.insert({"x": 2}); t.insert({"x": None}); t.insert({"x": 1})
assert [r["x"] for r in t.select().order_by("x", nulls_last=True).all()] == [1, 2, None]
assert [r["x"] for r in t.select().order_by("x", nulls_last=False).all()] == [None, 1, 2]
assert [r["x"] for r in t.select().order_by("x", desc=True, nulls_last=True).all()] == [2, 1, None]
assert [r["x"] for r in t.select().order_by("x", desc=True, nulls_last=False).all()] == [None, 2, 1]
```

## `limit(n)` / `offset(n)`

Standard pagination, applied in this order: **filter, then order, then
offset, then limit** - i.e. the result is `ordered_rows[offset : offset + n]`.
`offset` skips from the front of the (already ordered) result; `limit`
caps how many rows remain *after* that skip, not before it.

```python
t = Table()
for x in [1, 2, 3, 4]:
    t.insert({"x": x})
rows = t.select().order_by("x").limit(2).offset(1).all()
assert [r["x"] for r in rows] == [2, 3]  # skip 1, then take 2 - not "take 2, then skip 1"
```

`limit(None)` means unlimited (the default). `offset(0)` is the default.
Both raise `ValueError` for a negative argument.

## Aggregates: `count(col="*")`, `min(col)`, `max(col)`

Available on both `Table` (over every row) and `Query` (over the query's
matched - and, if set, limited/offset/ordered - rows).

- **`count("*")`** (or `count()`/`count(None)`): the number of rows,
  **including** rows where every column is `None`.
- **`count(col)`** for a real column name: the number of rows where
  `row[col] is not None` - `None` values are excluded, the same way SQL's
  `COUNT(col)` excludes `NULL`.

```python
t = Table()
t.insert({"x": 1})
t.insert({"x": None})
assert t.count("*") == 2   # includes the NULL row
assert t.count("x") == 1   # excludes it
```

- **`min(col)` / `max(col)`**: ignore `None` values, like SQL's `MIN`/`MAX`.
  Return `None` if there are no non-`None` values to aggregate (including an
  empty query).

## Exceptions

| exception | raised by |
|---|---|
| `UniqueViolation` | `insert()`/`update()`/`unique()` when a unique constraint is or would be violated |
| `NoSuchSavepoint` | `rollback_to(name)`/`commit(name)` for a `name` with no open `savepoint(name)` |
| `ValueError` | `limit(n)`/`offset(n)` with a negative `n` |

Both `UniqueViolation` and `NoSuchSavepoint` are subclasses of
`TinyTableError`.
