# tinytable SPEC

`tinytable` is a small, dependency-free, single-table SQL engine: it parses
and executes a subset of SQL (`CREATE TABLE`/`INSERT`/`UPDATE`/`DELETE`/
`SELECT` with `WHERE`/`ORDER BY`/`LIMIT`/`OFFSET`, `CREATE [UNIQUE] INDEX`,
and `SAVEPOINT`/`ROLLBACK TO`/`RELEASE`/`COMMIT`) against an in-memory table.

This document is the **sole arbiter of correct behavior**. `clean/` is a
reference implementation of everything below; a "defect" is any observable
deviation from this spec, nothing more and nothing less. Every SQL example
in this document is a literal, verified statement sequence, true of
`clean/tinytable` today - see "Test Script Format" below for how tests
(official and, later, golden) pin these down as runnable `.test` files.

```python
from tinytable import Database
db = Database()
db.execute("CREATE TABLE t (x)")
db.execute("INSERT INTO t VALUES (1)")
result = db.execute("SELECT x FROM t")   # QueryResult(columns=["x"], rows=[(1,)])
```

`Database` is the only thing a caller needs: one `Database()` per
independent dataset, `execute(sql)` runs exactly one statement and returns a
`QueryResult` (for `SELECT`) or `None` (for everything else). There is no
fixed row schema underneath - rows are plain dicts - but every table a SQL
script can see was `CREATE TABLE`'d, which is what gives `SELECT *` and
column-list-omitted `INSERT` a defined column order (see below).

## SQL Surface

Single table per statement - **no `JOIN`, no subqueries, no `GROUP BY`, no
mixing an aggregate with plain columns in one `SELECT`, no multiple
aggregates in one `SELECT`**. All of these raise `SqlError` with a clear
message rather than doing something unintended. Statements are
case-insensitive for keywords; identifiers are case-sensitive; string
literals use single quotes (`''` inside a literal is one literal `'`); a
trailing `;` is optional and ignored.

```
statement   := create_table | create_index | insert | update | delete
             | select | savepoint | rollback | release | commit

create_table := CREATE TABLE ident '(' ident (',' ident)* ')'
create_index  := CREATE [UNIQUE] INDEX ident ON ident '(' ident ')'
insert        := INSERT INTO ident ['(' ident (',' ident)* ')']
                 VALUES '(' value (',' value)* ')'
update        := UPDATE ident SET ident '=' value (',' ident '=' value)*
                 [WHERE condition]
delete        := DELETE FROM ident [WHERE condition]
select        := SELECT select_list FROM ident [WHERE condition]
                 [ORDER BY ident [ASC|DESC] [NULLS (FIRST|LAST)]]
                 [LIMIT number] [OFFSET number]
select_list   := '*' | select_item (',' select_item)*
select_item   := ident | COUNT '(' ('*' | ident) ')'
                       | MIN '(' ident ')' | MAX '(' ident ')'
savepoint     := SAVEPOINT ident
rollback      := ROLLBACK TO [SAVEPOINT] ident
release       := RELEASE [SAVEPOINT] ident
commit        := COMMIT

condition   := or_expr
or_expr     := and_expr (OR and_expr)*
and_expr    := not_expr (AND not_expr)*
not_expr    := [NOT] primary_cond
primary_cond := '(' or_expr ')' | comparison
comparison  := ident ( '=' value | ('!='|'<>') value
                      | '<' value | '<=' value | '>' value | '>=' value
                      | BETWEEN value AND value
                      | IN '(' value (',' value)* ')'
                      | IS NULL | IS NOT NULL )
value       := NUMBER | STRING | NULL
```

`CREATE TABLE t (a, b, c)` declares column *names* only - there is no type
system; a column holds whatever value was last written to it, or `None`/SQL
`NULL` if never written. This declared list is what `SELECT *` and a
column-list-omitted `INSERT INTO t VALUES (...)` use for positional
ordering; an explicit `INSERT INTO t (b) VALUES (5)` or `UPDATE ... SET
b = 5` may still name any column, declared or not - the underlying engine is
schemaless. `CREATE UNIQUE INDEX` both builds a secondary index and adds a
uniqueness constraint on that column (see "Uniqueness" below); a plain
`CREATE INDEX` only builds the index.

`SAVEPOINT`/`ROLLBACK TO`/`RELEASE`/`COMMIT` are **database-wide**: they
apply to every table that currently exists. A table `CREATE`'d after a
`SAVEPOINT` simply has nothing to roll back to for that name (rolling back
does not un-create it); `ROLLBACK TO`/`RELEASE` on a name no table currently
holds raises an error containing `no such savepoint`.

## NULL semantics (three-valued logic)

This is the single most important rule in this spec.

**`=`/`!=`/`<>`/`<`/`<=`/`>`/`>=`/`BETWEEN`/`IN` never match when either
side of the comparison is `NULL`** - including when *both* sides are
`NULL`. A `NULL` column value or a `NULL` literal makes the result
"unknown," not "true," even for `x = NULL` or `x != NULL` (which are not
useful ways to test for `NULL` - use `IS NULL`/`IS NOT NULL` instead).

```sql
CREATE TABLE t (x)
INSERT INTO t VALUES (NULL)
SELECT x FROM t WHERE x = NULL       -- returns 0 rows: NULL = NULL is NOT a match
SELECT x FROM t WHERE x != NULL      -- returns 0 rows: NULL != NULL is NOT a match either
SELECT x FROM t WHERE x IS NULL      -- returns 1 row: this is how you test for NULL
```

```sql
CREATE TABLE people (name, age)
INSERT INTO people VALUES ('Ann', NULL)
INSERT INTO people VALUES ('Bo', 30)
INSERT INTO people VALUES ('Cy', 25)
SELECT name FROM people WHERE age != 30    -- returns only 'Cy'
```

`age != 30` excludes Bo because Bo's age *does* equal 30, and - the easy
mistake - it **also** excludes Ann, because a `NULL` comparison never
matches; `age != 30` does **not** silently mean "every age other than 30,
including unknown ones." A caller who wants that must write
`age != 30 OR age IS NULL` explicitly.

`IN (...)`: if the list contains `NULL`, that `NULL` is inert - it can
never cause a `NULL`-valued row to match. `IS NULL` is the only way to
match `NULL`.

A column **never written on a given row** behaves identically to that
column holding `NULL`, for every rule above.

## `ORDER BY col [ASC|DESC] [NULLS FIRST|LAST]`

- **Stable**: rows whose `col` value compares equal keep their relative
  insertion order, in *both* ascending and `DESC` order - `DESC` is a true
  stable descending sort, not "sort ascending then reverse the whole
  result" (which would also reverse the relative order of tied rows).
- **`NULL` placement**: `NULL` rows are placed as a block, either after
  every non-`NULL` row (`NULLS LAST`, the default) or before every
  non-`NULL` row (`NULLS FIRST`) - **independent of `ASC`/`DESC`**. Flipping
  the sort direction reverses the order *within* the non-`NULL` rows; it
  never moves the `NULL` block to the other end.

```sql
CREATE TABLE t (k, tag)
INSERT INTO t VALUES (1, 'a')
INSERT INTO t VALUES (1, 'b')
SELECT tag FROM t ORDER BY k           -- 'a', 'b' (insertion order preserved)
SELECT tag FROM t ORDER BY k DESC      -- 'a', 'b' (still - stable, not reversed)
```

```sql
CREATE TABLE t2 (x)
INSERT INTO t2 VALUES (2)
INSERT INTO t2 VALUES (NULL)
INSERT INTO t2 VALUES (1)
SELECT x FROM t2 ORDER BY x NULLS LAST         -- 1, 2, NULL
SELECT x FROM t2 ORDER BY x NULLS FIRST        -- NULL, 1, 2
SELECT x FROM t2 ORDER BY x DESC NULLS LAST    -- 2, 1, NULL
SELECT x FROM t2 ORDER BY x DESC NULLS FIRST   -- NULL, 2, 1
```

## `LIMIT n` / `OFFSET n`

Applied in this order: **filter, then order, then offset, then limit** -
i.e. the result is `ordered_rows[offset : offset + limit]`. `OFFSET` skips
from the front of the already-ordered result; `LIMIT` caps how many rows
remain *after* that skip, not before it.

```sql
CREATE TABLE t (x)
INSERT INTO t VALUES (1)
INSERT INTO t VALUES (2)
INSERT INTO t VALUES (3)
INSERT INTO t VALUES (4)
SELECT x FROM t ORDER BY x LIMIT 2 OFFSET 1   -- 2, 3: skip 1, THEN take 2
```

A negative `LIMIT`/`OFFSET` is a syntax the grammar above doesn't even
allow (`number` is a non-negative literal); omitting `LIMIT` means
unlimited, omitting `OFFSET` means 0.

## Secondary index: `CREATE INDEX idx ON t(col)`

Builds an index on `col` from the table's current rows (or rebuilds it, if
issued again for the same column - `idx`'s own name is documentation only,
not tracked). An index is a pure performance optimization: **a query
against an indexed column must return exactly the same rows, in the same
cases, as the same query would against an unindexed column** - this is the
central invariant a range-scan bug would violate.

```sql
CREATE TABLE t (x)
INSERT INTO t VALUES (5)
CREATE INDEX idx ON t(x)
SELECT x FROM t WHERE x >= 5     -- still returns 5: the boundary is included
```

An index only accelerates `=`/`<`/`<=`/`>`/`>=`/`BETWEEN` against that
column (used alone or as one clause of an `AND`-combined `WHERE`); every
other predicate shape still works correctly, just without the index's help.

## Uniqueness: `CREATE UNIQUE INDEX idx ON t(col)`

Declares that `col` may hold at most one row with any given non-`NULL`
value. Checked immediately against the table's current rows (raises an
error containing `already present` if a duplicate already exists), then
enforced on every subsequent `INSERT`/`UPDATE`.

**`NULL` never participates in uniqueness**: any number of rows may hold
`NULL` in a unique column, simultaneously.

```sql
CREATE TABLE t (email)
CREATE UNIQUE INDEX uq ON t(email)
INSERT INTO t VALUES (NULL)
INSERT INTO t VALUES (NULL)     -- NOT a conflict
SELECT COUNT(*) FROM t          -- 2
```

```sql
CREATE TABLE t2 (email)
CREATE UNIQUE INDEX uq2 ON t2(email)
INSERT INTO t2 VALUES ('a@x.com')
INSERT INTO t2 VALUES ('a@x.com')   -- raises: unique constraint violated ... already present
```

### Uniqueness and `UPDATE`

`UPDATE` validates each matched row's *new* value against every *other*
row's *current* value, processing matched rows one at a time in ascending
row-id order. A row keeping its own existing value is never a
self-conflict:

```sql
CREATE TABLE t (email, n)
CREATE UNIQUE INDEX uq ON t(email)
INSERT INTO t VALUES ('a@x.com', 1)
UPDATE t SET n = 2 WHERE email = 'a@x.com'    -- fine - same row, same email
```

A single `UPDATE` cannot swap two rows' unique values in one statement
(giving row A row B's old value and vice versa) - this is explicitly
undefined/unsupported, not a scored behavior.

## `SAVEPOINT` / `ROLLBACK TO` / `RELEASE` / `COMMIT`

`SAVEPOINT name` snapshots **every table's entire state** - rows, every
secondary index's contents, and every unique constraint's contents - under
`name`.

`ROLLBACK TO name` restores that exact snapshot on every table that has it:
rows, index contents, and unique-constraint contents all revert together.
**A query against an indexed column immediately after `ROLLBACK TO` must
return the same result it would if the index had never existed and was
rebuilt from the restored rows from scratch** - this is the invariant a
"rollback leaves stale index entries" bug would violate. `name` remains
valid afterward (you may `ROLLBACK TO` it again); any savepoint created
after it is discarded.

```sql
CREATE TABLE t (x)
INSERT INTO t VALUES (1)
CREATE INDEX idx ON t(x)
SAVEPOINT s1
INSERT INTO t VALUES (2)
ROLLBACK TO s1
SELECT x FROM t WHERE x = 2   -- 0 rows: not a stale hit
SELECT x FROM t WHERE x = 1   -- still finds it, via the index
```

`RELEASE name` discards that savepoint, making changes since it was created
permanent (you can no longer roll back to it). `COMMIT` with no name
discards every open savepoint on every table.

## Aggregates: `COUNT(col)`, `COUNT(*)`, `MIN(col)`, `MAX(col)`

Exactly one aggregate per `SELECT`, never mixed with plain columns.
`WHERE`/`ORDER BY`/`LIMIT`/`OFFSET` still apply before the aggregate runs.

- **`COUNT(*)`**: the number of rows, **including** rows where every
  column is `NULL`.
- **`COUNT(col)`** for a real column name: the number of rows where
  `col IS NOT NULL` - `NULL` values are excluded, the same way SQL's
  `COUNT(col)` excludes `NULL`.

```sql
CREATE TABLE t (x)
INSERT INTO t VALUES (1)
INSERT INTO t VALUES (NULL)
SELECT COUNT(*) FROM t     -- 2: includes the NULL row
SELECT COUNT(x) FROM t     -- 1: excludes it
```

- **`MIN(col)` / `MAX(col)`**: ignore `NULL` values, like SQL's
  `MIN`/`MAX`. Return `NULL` if there are no non-`NULL` values to
  aggregate (including an empty result set).

## Errors

| when | message contains |
|---|---|
| a unique constraint is or would be violated | `already present` |
| `ROLLBACK TO`/`RELEASE` a name no table has | `no such savepoint` |
| a syntax error, or an unsupported statement shape (JOIN, mixed aggregates, missing table, etc.) | (implementation-specific `SqlError` message - not scored on exact wording, only that an error is raised) |

## Test Script Format

Official and (later) golden tests are `.test` files: a small,
sqllogictest-inspired subset, run by `run_sql_tests.py --root <tinytable
install> <file-or-dir>...`. Each `.test` file gets its own fresh `Database`;
statements within one file share state top to bottom.

A file is a sequence of **records**, separated by blank lines. `#`-prefixed
lines are comments (a `# name: ...` line immediately before a record is a
convention for a human-readable label - the runner ignores it as a comment
like any other). Two record kinds:

**`statement ok` / `statement error [substring]`** - every following
non-blank line up to the next blank line is the SQL text (may span multiple
lines). `ok` expects it to execute without raising; `error` expects it to
raise, optionally checking that `substring` appears in the raised message
(see the Errors table above for what to match on).

```
statement ok
INSERT INTO t VALUES (1)

statement error already present
INSERT INTO t VALUES ('a@x.com')
```

**`query <types> [nosort|rowsort]`** - `types` is one letter per expected
result column (`T` text, `I` integer, `R` real - purely documentation plus
a column-count check, tinytable itself has no type system). Lines up to a
line containing exactly `----` are the SQL text (a `SELECT`); lines after
`----` up to the next blank line are the expected result, **one value per
line**, flattened row-major (row 0's columns, then row 1's columns, ...).
`NULL` is written as the literal token `NULL`. An empty expected block
(`----` immediately followed by a blank line) means zero rows.

`nosort` (the default) requires the exact row/column order returned;
`rowsort` groups both the actual and expected flattened values back into
row-tuples and sorts them before comparing - use this whenever a query's
row order isn't itself the thing being tested (e.g. a plain filter with no
`ORDER BY`), so a test doesn't accidentally pin down an order the spec
never promised.

```
query T rowsort
SELECT name FROM people WHERE dept = 'eng'
----
Ann
Bo

query I nosort
SELECT x FROM t2 ORDER BY x NULLS LAST
----
1
2
NULL
```

This is a deliberately small **subset** of the real sqllogictest format
(no `hash-threshold`, no `skipif`/`onlyif` platform conditionals, no
multi-connection labels) purpose-built for tinytable's single dialect -
`run_sql_tests.py` is not a drop-in replacement for the reference
sqllogictest tooling.
