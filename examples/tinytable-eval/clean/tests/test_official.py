"""Official tinytable test suite (see ../../SPEC.md).

This suite is shared, byte-for-byte, across `clean` and every seeded mutant
(see the mutants issue in this eval's sequence) - it is expected to pass on
ALL of them. It therefore deliberately does not probe the exact handful of
boundary behaviors that distinguish `clean` from a mutant (those live in
golden/, one hand-written test per mutant, never copied into a fixture).
Specifically this file never:
  - calls eq()/ne() with a literal None value,
  - issues a `ge` comparison through an indexed column,
  - checks index consistency right after an update() to an indexed column,
  - checks sort stability (duplicate sort keys) or nulls_last combined with
    desc=True,
  - checks index consistency right after rollback_to(),
  - combines limit() and offset() in the same query,
  - inserts two NULLs into the same unique() column,
  - calls count(col) on a column that contains a None value.
Every one of those behaviors is still fully pinned down in SPEC.md - this
file just isn't where that pinning happens.
"""

import pytest

from tinytable import (
    NoSuchSavepoint,
    Table,
    UniqueViolation,
    between,
    eq,
    ge,
    gt,
    in_,
    is_null,
    le,
    lt,
    ne,
    not_null,
)


def make_people():
    t = Table("people")
    t.insert({"id": 1, "name": "Ann", "age": 30, "dept": "eng"})
    t.insert({"id": 2, "name": "Bo", "age": 25, "dept": "eng"})
    t.insert({"id": 3, "name": "Cy", "age": 40, "dept": "sales"})
    t.insert({"id": 4, "name": "Di", "age": None, "dept": "sales"})
    t.insert({"id": 5, "name": "Ev", "age": 35, "dept": None})
    return t


# -- insert/update/delete ---------------------------------------------------


def test_insert_returns_increasing_row_ids():
    t = Table()
    a = t.insert({"x": 1})
    b = t.insert({"x": 2})
    assert b > a
    assert len(t) == 2


def test_insert_does_not_alias_caller_dict():
    t = Table()
    row = {"x": 1}
    t.insert(row)
    row["x"] = 999
    assert t.where(eq("x", 1)).all() == [{"x": 1}]


def test_update_changes_matching_rows_and_returns_count():
    t = make_people()
    updated = t.update(eq("dept", "eng"), {"dept": "engineering"})
    assert updated == 2
    names = sorted(r["name"] for r in t.where(eq("dept", "engineering")).all())
    assert names == ["Ann", "Bo"]
    assert t.where(eq("dept", "eng")).all() == []


def test_update_only_touches_named_columns():
    t = Table()
    t.insert({"x": 1, "y": "keep"})
    t.update(eq("x", 1), {"x": 2})
    assert t.where(eq("x", 2)).all() == [{"x": 2, "y": "keep"}]


def test_delete_removes_matching_rows_and_returns_count():
    t = make_people()
    deleted = t.delete(eq("dept", "sales"))
    assert deleted == 2
    assert t.where(eq("dept", "sales")).all() == []
    assert len(t) == 3


# -- where(): comparisons ----------------------------------------------------


def test_eq_matches_only_exact_value():
    t = make_people()
    assert [r["name"] for r in t.where(eq("age", 30)).all()] == ["Ann"]


def test_ne_excludes_exact_value_but_also_excludes_null_rows():
    t = make_people()
    # Three-valued logic: a NULL age is neither "= 30" nor "!= 30" - ne(30)
    # must not pull in Di (age=None). See SPEC.md NULL semantics section.
    names = sorted(r["name"] for r in t.where(ne("age", 30)).all())
    assert "Ann" not in names
    assert "Di" not in names
    assert names == ["Bo", "Cy", "Ev"]


def test_lt_le_gt_bounds_are_exact_and_null_never_matches():
    t = make_people()
    assert sorted(r["name"] for r in t.where(lt("age", 30)).all()) == ["Bo"]
    assert sorted(r["name"] for r in t.where(le("age", 30)).all()) == ["Ann", "Bo"]
    assert sorted(r["name"] for r in t.where(gt("age", 30)).all()) == ["Cy", "Ev"]
    for pred in (lt("age", 100), le("age", 100), gt("age", -100)):
        assert "Di" not in [r["name"] for r in t.where(pred).all()]


def test_ge_full_scan_boundary_is_inclusive():
    # No index here - this exercises `ge`'s own boundary logic, but via a
    # full scan, not the secondary-index scan path.
    t = make_people()
    assert sorted(r["name"] for r in t.where(ge("age", 30)).all()) == ["Ann", "Cy", "Ev"]
    assert sorted(r["name"] for r in t.where(ge("age", 41)).all()) == []


def test_between_is_inclusive_on_both_ends():
    t = make_people()
    names = sorted(r["name"] for r in t.where(between("age", 25, 35)).all())
    assert names == ["Ann", "Bo", "Ev"]
    assert "Di" not in names


def test_in_matches_any_listed_value_and_ignores_none():
    t = make_people()
    names = sorted(r["name"] for r in t.where(in_("dept", ["eng", "sales", None])).all())
    assert names == ["Ann", "Bo", "Cy", "Di"]
    assert "Ev" not in names  # Ev's dept is None; None in the list doesn't match it


def test_is_null_and_not_null():
    t = make_people()
    assert [r["name"] for r in t.where(is_null("age")).all()] == ["Di"]
    names = sorted(r["name"] for r in t.where(not_null("age")).all())
    assert names == ["Ann", "Bo", "Cy", "Ev"]


def test_missing_column_behaves_as_null():
    t = Table()
    t.insert({"x": 1})
    t.insert({"x": 2, "y": 5})
    assert [r["x"] for r in t.where(is_null("y")).all()] == [1]
    assert [r["x"] for r in t.where(eq("y", 5)).all()] == [2]


def test_and_or_not_compose_predicates():
    t = make_people()
    both = t.where(eq("dept", "eng") & gt("age", 28)).all()
    assert [r["name"] for r in both] == ["Ann"]

    either = sorted(r["name"] for r in t.where(eq("dept", "sales") | eq("age", 25)).all())
    assert either == ["Bo", "Cy", "Di"]

    not_eng = sorted(r["name"] for r in t.where(~eq("dept", "eng")).all())
    assert "Ann" not in not_eng and "Bo" not in not_eng


# -- secondary index: must agree with a full scan ---------------------------


def test_index_eq_matches_full_scan():
    t = make_people()
    expected = sorted(r["name"] for r in t.where(eq("dept", "eng")).all())
    t.create_index("dept")
    assert sorted(r["name"] for r in t.where(eq("dept", "eng")).all()) == expected


def test_index_lt_gt_le_match_full_scan_including_exact_boundary():
    t = make_people()
    t.create_index("age")
    assert sorted(r["name"] for r in t.where(lt("age", 35)).all()) == ["Ann", "Bo"]
    assert sorted(r["name"] for r in t.where(le("age", 35)).all()) == ["Ann", "Bo", "Ev"]
    assert sorted(r["name"] for r in t.where(gt("age", 35)).all()) == ["Cy"]


def test_index_between_matches_full_scan_including_exact_boundaries():
    t = make_people()
    t.create_index("age")
    names = sorted(r["name"] for r in t.where(between("age", 25, 35)).all())
    assert names == ["Ann", "Bo", "Ev"]
    # exact-boundary values are included
    assert [r["name"] for r in t.where(between("age", 30, 30)).all()] == ["Ann"]


def test_index_and_combined_predicate_still_applies_full_filter():
    t = make_people()
    t.create_index("dept")
    rows = t.where(eq("dept", "eng") & gt("age", 28)).all()
    assert [r["name"] for r in rows] == ["Ann"]


def test_index_reflects_inserts_and_deletes():
    t = Table()
    t.create_index("x")
    t.insert({"x": 1})
    t.insert({"x": 2})
    assert sorted(r["x"] for r in t.where(ge("x", 0)).all()) == [1, 2]
    t.delete(eq("x", 1))
    assert [r["x"] for r in t.where(ge("x", 0)).all()] == [2]


def test_create_index_on_existing_data_is_usable_immediately():
    t = make_people()
    t.create_index("age")
    assert [r["name"] for r in t.where(eq("age", 40)).all()] == ["Cy"]


# -- unique() ----------------------------------------------------------------


def test_unique_rejects_duplicate_non_null_value():
    t = Table()
    t.unique("email")
    t.insert({"email": "a@example.com"})
    with pytest.raises(UniqueViolation):
        t.insert({"email": "a@example.com"})


def test_unique_allows_a_null_value():
    t = Table()
    t.unique("email")
    t.insert({"email": "a@example.com"})
    row_id = t.insert({"email": None})  # a single NULL never conflicts
    assert row_id is not None
    assert len(t) == 2


def test_unique_checked_on_existing_data_when_declared():
    t = Table()
    t.insert({"email": "a@example.com"})
    t.insert({"email": "a@example.com"})
    with pytest.raises(UniqueViolation):
        t.unique("email")


def test_unique_update_to_new_value_is_checked():
    t = Table()
    t.unique("email")
    t.insert({"email": "a@example.com"})
    t.insert({"email": "b@example.com"})
    with pytest.raises(UniqueViolation):
        t.update(eq("email", "b@example.com"), {"email": "a@example.com"})


def test_unique_update_keeping_same_value_does_not_self_conflict():
    t = Table()
    t.unique("email")
    t.insert({"email": "a@example.com", "n": 1})
    t.update(eq("email", "a@example.com"), {"n": 2})
    assert [r["n"] for r in t.where(eq("email", "a@example.com")).all()] == [2]


# -- order_by ------------------------------------------------------------


def test_order_by_ascending_and_descending_with_distinct_keys():
    t = Table()
    for x in [3, 1, 2]:
        t.insert({"x": x})
    assert [r["x"] for r in t.select().order_by("x").all()] == [1, 2, 3]
    assert [r["x"] for r in t.select().order_by("x", desc=True).all()] == [3, 2, 1]


def test_order_by_nulls_last_true_and_false_with_ascending_sort():
    t = Table()
    t.insert({"x": 2})
    t.insert({"x": None})
    t.insert({"x": 1})
    last = [r["x"] for r in t.select().order_by("x", nulls_last=True).all()]
    assert last == [1, 2, None]
    first = [r["x"] for r in t.select().order_by("x", nulls_last=False).all()]
    assert first == [None, 1, 2]


def test_order_by_after_where_orders_only_the_matched_rows():
    t = make_people()
    rows = t.where(not_null("age")).order_by("age").all()
    assert [r["name"] for r in rows] == ["Bo", "Ann", "Ev", "Cy"]


# -- limit / offset (tested independently, never combined) -------------------


def test_limit_alone_takes_the_first_n_in_query_order():
    t = Table()
    for x in [1, 2, 3, 4]:
        t.insert({"x": x})
    rows = t.select().order_by("x").limit(2).all()
    assert [r["x"] for r in rows] == [1, 2]


def test_offset_alone_skips_the_first_n_in_query_order():
    t = Table()
    for x in [1, 2, 3, 4]:
        t.insert({"x": x})
    rows = t.select().order_by("x").offset(2).all()
    assert [r["x"] for r in rows] == [3, 4]


def test_limit_larger_than_result_set_returns_everything():
    t = Table()
    t.insert({"x": 1})
    assert len(t.select().limit(50).all()) == 1


# -- aggregates ----------------------------------------------------------


def test_count_star_counts_every_row_including_nulls():
    t = make_people()
    assert t.count("*") == 5
    assert t.select().count() == 5


def test_count_column_on_fully_populated_column():
    t = Table()
    t.insert({"x": 1})
    t.insert({"x": 2})
    t.insert({"x": 3})
    assert t.count("x") == 3


def test_count_after_filtering():
    t = make_people()
    assert t.where(eq("dept", "eng")).count() == 2


def test_min_and_max_ignore_null_values():
    t = make_people()
    assert t.min("age") == 25
    assert t.max("age") == 40


def test_min_max_on_empty_query_is_none():
    t = Table()
    t.insert({"x": 1})
    assert t.where(eq("x", 999)).min("x") is None
    assert t.where(eq("x", 999)).max("x") is None


# -- savepoint / rollback_to / commit (no index involved) --------------------


def test_rollback_to_restores_row_data():
    t = Table()
    t.insert({"x": 1})
    t.savepoint("s1")
    t.insert({"x": 2})
    t.delete(eq("x", 1))
    assert sorted(r["x"] for r in t.select().all()) == [2]

    t.rollback_to("s1")
    assert [r["x"] for r in t.select().all()] == [1]


def test_rollback_to_same_savepoint_twice():
    t = Table()
    t.insert({"x": 1})
    t.savepoint("s1")
    t.insert({"x": 2})
    t.rollback_to("s1")
    t.insert({"x": 3})
    t.rollback_to("s1")
    assert [r["x"] for r in t.select().all()] == [1]


def test_rollback_to_discards_later_savepoints():
    t = Table()
    t.insert({"x": 1})
    t.savepoint("s1")
    t.insert({"x": 2})
    t.savepoint("s2")
    t.insert({"x": 3})
    t.rollback_to("s1")
    with pytest.raises(NoSuchSavepoint):
        t.rollback_to("s2")


def test_commit_named_discards_that_savepoint_but_keeps_changes():
    t = Table()
    t.insert({"x": 1})
    t.savepoint("s1")
    t.insert({"x": 2})
    t.commit("s1")
    assert sorted(r["x"] for r in t.select().all()) == [1, 2]
    with pytest.raises(NoSuchSavepoint):
        t.rollback_to("s1")


def test_commit_with_no_name_clears_all_savepoints():
    t = Table()
    t.savepoint("s1")
    t.savepoint("s2")
    t.commit()
    with pytest.raises(NoSuchSavepoint):
        t.rollback_to("s1")
    with pytest.raises(NoSuchSavepoint):
        t.rollback_to("s2")


def test_rollback_to_unknown_savepoint_raises():
    t = Table()
    with pytest.raises(NoSuchSavepoint):
        t.rollback_to("nope")
