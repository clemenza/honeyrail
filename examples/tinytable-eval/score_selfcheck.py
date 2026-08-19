#!/usr/bin/env python3
"""Standalone self-check for score.py (issue #91), exercising it exactly the
way a future driver's `--seed-root` worktree is expected to: a fresh git
repo containing a `tinytable/` package, `tests/test_official.py` (a pytest
wrapper around sql-tests/official/*.test), and an empty `tests/agent/` for
an "agent" to fill in.

Builds one ephemeral worktree per mutant (mutants/mNN) plus one for `clean`
itself, in a temp directory, and runs score.py against each under a few
scenarios - see the Acceptance Criteria in issue #91:

  1. tests/agent/ seeded with a pytest translation of every golden test
     (golden/mNN.test) -> for every mutant, expect killed=true,
     false_alarms=0, contract_ok=true (score.py exits 0); for `clean`
     itself (no defect to kill), expect killed=false.
  2. tests/agent/ left empty -> expect contract_ok=false (score.py exits 1).
  3. tests/agent/ seeded with a single no-op test -> expect killed=false
     (score.py exits 1) even though contract_ok is true.
  4. tests/agent/ seeded like (1), but the "agent" also edits
     tinytable/core.py -> expect contract_ok=false regardless of killed.

Run standalone: `python3 score_selfcheck.py`. Exit code 0 iff every
scenario matches its expectation.
"""

from __future__ import annotations

import json
import pathlib
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
CLEAN = HERE / "clean"
MUTANTS_DIR = HERE / "mutants"
GOLDEN_DIR = HERE / "golden"
SCORE_PY = HERE / "score.py"

MUTANT_IDS = [f"m{i:02d}" for i in range(1, 9)]

_failures: list[str] = []


def fail(msg: str) -> None:
    _failures.append(msg)
    print(f"FAIL {msg}")


def ok(msg: str) -> None:
    print(f"ok   {msg}")


# ---------------------------------------------------------------------------
# tests/agent/ fixture: a native-pytest translation of golden/*.test, one
# test function per mutant's defect (see golden/mNN.test for the original
# sqllogictest-style version each of these mirrors).
# ---------------------------------------------------------------------------

_AGENT_TEST_SUITE = '''\
"""pytest translation of tinytable-eval/golden/*.test, used by
score_selfcheck.py to prove score.py correctly kills every seeded mutant.
"""
from tinytable import Database


def test_eq_null_never_matches_null():
    db = Database()
    db.execute("CREATE TABLE t (x INTEGER)")
    db.execute("INSERT INTO t VALUES (NULL)")
    db.execute("INSERT INTO t VALUES (1)")
    result = db.execute("SELECT x FROM t WHERE x = NULL")
    assert result.rows == []


def test_indexed_ge_includes_boundary():
    db = Database()
    db.execute("CREATE TABLE t (x INTEGER)")
    db.execute("INSERT INTO t VALUES (5)")
    db.execute("CREATE INDEX idx ON t(x)")
    result = db.execute("SELECT x FROM t WHERE x >= 5")
    assert result.rows == [(5,)]


def test_update_refreshes_index():
    db = Database()
    db.execute("CREATE TABLE t (x INTEGER)")
    db.execute("INSERT INTO t VALUES (1)")
    db.execute("INSERT INTO t VALUES (10)")
    db.execute("CREATE INDEX idx ON t(x)")
    db.execute("UPDATE t SET x = 20 WHERE x = 1")
    result = db.execute("SELECT x FROM t WHERE x >= 15")
    assert result.rows == [(20,)]


def test_order_by_desc_is_stable_and_nulls_last_independent_of_desc():
    db = Database()
    db.execute("CREATE TABLE t (k INTEGER, tag TEXT)")
    db.execute("INSERT INTO t VALUES (1, 'a')")
    db.execute("INSERT INTO t VALUES (1, 'b')")
    result = db.execute("SELECT tag FROM t ORDER BY k DESC")
    assert result.rows == [("a",), ("b",)]

    db2 = Database()
    db2.execute("CREATE TABLE t2 (x INTEGER)")
    db2.execute("INSERT INTO t2 VALUES (2)")
    db2.execute("INSERT INTO t2 VALUES (NULL)")
    db2.execute("INSERT INTO t2 VALUES (1)")
    result2 = db2.execute("SELECT x FROM t2 ORDER BY x DESC NULLS LAST")
    assert result2.rows == [(2,), (1,), (None,)]


def test_rollback_restores_index_contents():
    db = Database()
    db.execute("CREATE TABLE t (x INTEGER)")
    db.execute("INSERT INTO t VALUES (1)")
    db.execute("CREATE INDEX idx ON t(x)")
    db.execute("SAVEPOINT s1")
    db.execute("UPDATE t SET x = 99 WHERE x = 1")
    db.execute("ROLLBACK TO s1")
    result = db.execute("SELECT x FROM t WHERE x = 1")
    assert result.rows == [(1,)]


def test_offset_applies_before_limit():
    db = Database()
    db.execute("CREATE TABLE t (x INTEGER)")
    for v in (1, 2, 3, 4):
        db.execute(f"INSERT INTO t VALUES ({v})")
    result = db.execute("SELECT x FROM t ORDER BY x LIMIT 2 OFFSET 1")
    assert result.rows == [(2,), (3,)]


def test_unique_null_never_conflicts():
    db = Database()
    db.execute("CREATE TABLE t (email TEXT)")
    db.execute("CREATE UNIQUE INDEX uq ON t(email)")
    db.execute("INSERT INTO t VALUES (NULL)")
    db.execute("INSERT INTO t VALUES (NULL)")
    result = db.execute("SELECT COUNT(*) FROM t")
    assert result.rows == [(2,)]


def test_count_col_excludes_null():
    db = Database()
    db.execute("CREATE TABLE t (x INTEGER)")
    db.execute("INSERT INTO t VALUES (1)")
    db.execute("INSERT INTO t VALUES (NULL)")
    result = db.execute("SELECT COUNT(x) FROM t")
    assert result.rows == [(1,)]
'''

_MUTANT_TO_REPRO_TEST = {
    "m01": "tests/agent/test_defects.py::test_eq_null_never_matches_null",
    "m02": "tests/agent/test_defects.py::test_indexed_ge_includes_boundary",
    "m03": "tests/agent/test_defects.py::test_update_refreshes_index",
    "m04": "tests/agent/test_defects.py::test_order_by_desc_is_stable_and_nulls_last_independent_of_desc",
    "m05": "tests/agent/test_defects.py::test_rollback_restores_index_contents",
    "m06": "tests/agent/test_defects.py::test_offset_applies_before_limit",
    "m07": "tests/agent/test_defects.py::test_unique_null_never_conflicts",
    "m08": "tests/agent/test_defects.py::test_count_col_excludes_null",
}

# score.py's F_mutant/F_clean entries come straight off junit's `classname`
# (dotted module path) - this is the same identifier, just not in pytest's
# own slash-path node-id spelling (findings.json's repro_test uses that
# spelling instead, per findings.schema.json's pattern).
_MUTANT_TO_JUNIT_ID = {
    mid: repro.replace("tests/agent/test_defects.py::", "tests.agent.test_defects::")
    for mid, repro in _MUTANT_TO_REPRO_TEST.items()
}

_FINDINGS_JSON = json.dumps(
    [
        {
            "id": mid,
            "summary": f"see golden/{mid}.test",
            "spec_section": "SPEC.md",
            "repro_test": repro,
        }
        for mid, repro in _MUTANT_TO_REPRO_TEST.items()
    ],
    indent=2,
)


def _build_official_test_wrapper() -> str:
    return '''\
"""pytest wrapper around sql-tests/official/*.test - do not edit. See
../SPEC.md's "Test Script Format" section; this reuses run_sql_tests.py's
own record parser/runner so there is exactly one source of truth for what
"official" means.
"""
import pathlib
import sys

import pytest

_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))

from run_sql_tests import collect_test_files, run_file  # noqa: E402
import tinytable  # noqa: E402

_FILES = collect_test_files([str(_ROOT / "sql-tests" / "official")])


@pytest.mark.parametrize("path", _FILES, ids=[p.name for p in _FILES])
def test_official(path):
    failures = run_file(path, tinytable)
    assert not failures, "\\n".join(f"line {ln}: {msg}" for ln, msg in failures)
'''


def _git(*args: str, cwd: pathlib.Path) -> None:
    subprocess.run(["git", *args], cwd=str(cwd), check=True, capture_output=True, text=True)


def build_worktree(source_tinytable_root: pathlib.Path, dest: pathlib.Path) -> None:
    """Assemble a worktree at `dest`: tinytable/ (from `source_tinytable_root`),
    run_sql_tests.py + sql-tests/official/ + SPEC.md (shared eval fixtures),
    tests/test_official.py (generated), and an empty tests/agent/ - then git
    init + commit it as the pristine baseline a future agent starts from.
    """
    dest.mkdir(parents=True)
    shutil.copytree(source_tinytable_root / "tinytable", dest / "tinytable")
    shutil.copytree(source_tinytable_root / "sql-tests" / "official", dest / "sql-tests" / "official")
    shutil.copy2(HERE / "run_sql_tests.py", dest / "run_sql_tests.py")
    shutil.copy2(HERE / "SPEC.md", dest / "SPEC.md")
    (dest / "tests").mkdir()
    (dest / "tests" / "test_official.py").write_text(_build_official_test_wrapper())
    (dest / "tests" / "agent").mkdir()
    (dest / "tests" / "agent" / ".gitkeep").write_text("")

    _git("init", "-q", cwd=dest)
    _git("config", "user.email", "selfcheck@example.com", cwd=dest)
    _git("config", "user.name", "selfcheck", cwd=dest)
    _git("add", "-A", cwd=dest)
    _git("commit", "-q", "-m", "seed", cwd=dest)


def run_score(worktree: pathlib.Path, clean_root: pathlib.Path) -> tuple[int, dict]:
    proc = subprocess.run(
        [sys.executable, str(SCORE_PY), "--worktree", str(worktree), "--clean", str(clean_root), "--out", "score.json"],
        capture_output=True, text=True,
    )
    score_path = worktree / "score.json"
    data = json.loads(score_path.read_text()) if score_path.is_file() else {}
    if proc.returncode not in (0, 1):
        print(proc.stdout)
        print(proc.stderr, file=sys.stderr)
    return proc.returncode, data


def scenario_killed_by_golden_suite(tmp: pathlib.Path, clean_root: pathlib.Path) -> None:
    for mid in MUTANT_IDS:
        mutant_root = MUTANTS_DIR / mid
        if not mutant_root.is_dir():
            fail(f"mutants/{mid} is missing")
            continue
        worktree = tmp / f"killed-{mid}"
        build_worktree(mutant_root, worktree)
        (worktree / "tests" / "agent" / "test_defects.py").write_text(_AGENT_TEST_SUITE)
        (worktree / "findings.json").write_text(_FINDINGS_JSON)

        code, data = run_score(worktree, clean_root)
        expect_id = _MUTANT_TO_JUNIT_ID[mid]
        if code == 0 and data.get("killed") and data.get("false_alarms") == 0 and data.get("contract_ok"):
            ok(f"score.py: golden-seeded suite kills {mid} (killed=true, false_alarms=0, contract_ok=true)")
        else:
            fail(f"score.py against {mid} with the golden-seeded suite: expected a clean kill, got {data}")
            continue
        if data.get("killed_tests") != [expect_id]:
            fail(f"score.py against {mid}: expected killed_tests == [{expect_id!r}], got {data.get('killed_tests')}")


def scenario_clean_is_not_killed(tmp: pathlib.Path, clean_root: pathlib.Path) -> None:
    worktree = tmp / "killed-clean"
    build_worktree(CLEAN, worktree)
    (worktree / "tests" / "agent" / "test_defects.py").write_text(_AGENT_TEST_SUITE)
    (worktree / "findings.json").write_text(_FINDINGS_JSON)

    code, data = run_score(worktree, clean_root)
    if code == 1 and not data.get("killed") and data.get("false_alarms") == 0 and data.get("contract_ok"):
        ok("score.py: golden-seeded suite against clean-as-worktree correctly reports killed=false (nothing to kill)")
    else:
        fail(f"score.py against clean-as-worktree: expected killed=false, false_alarms=0, contract_ok=true, got {data}")


def scenario_empty_agent_dir_fails_contract(tmp: pathlib.Path, clean_root: pathlib.Path) -> None:
    worktree = tmp / "empty-agent"
    build_worktree(MUTANTS_DIR / "m01", worktree)
    (worktree / "findings.json").write_text("[]")
    (worktree / "tests" / "agent" / ".gitkeep").unlink()

    code, data = run_score(worktree, clean_root)
    if code == 1 and not data.get("contract_ok"):
        ok("score.py: empty tests/agent/ reports contract_ok=false (failing gate)")
    else:
        fail(f"score.py against empty tests/agent/: expected a failing gate via contract_ok=false, got {data}")


def scenario_noop_test_is_not_killed(tmp: pathlib.Path, clean_root: pathlib.Path) -> None:
    worktree = tmp / "noop-agent"
    build_worktree(MUTANTS_DIR / "m01", worktree)
    (worktree / "tests" / "agent" / "test_noop.py").write_text("def test_noop():\n    assert True\n")
    (worktree / "findings.json").write_text("[]")

    code, data = run_score(worktree, clean_root)
    if code == 1 and not data.get("killed") and data.get("contract_ok"):
        ok("score.py: no-op tests/agent/ reports killed=false (failing gate) despite contract_ok=true")
    else:
        fail(f"score.py against a no-op tests/agent/: expected killed=false with contract_ok=true, got {data}")


def scenario_editing_tinytable_fails_contract(tmp: pathlib.Path, clean_root: pathlib.Path) -> None:
    worktree = tmp / "cheat-edit-source"
    build_worktree(MUTANTS_DIR / "m01", worktree)
    (worktree / "tests" / "agent" / "test_defects.py").write_text(_AGENT_TEST_SUITE)
    (worktree / "findings.json").write_text(_FINDINGS_JSON)
    core_py = worktree / "tinytable" / "core.py"
    core_py.write_text(core_py.read_text() + "\n# an agent should never get away with editing this file\n")

    code, data = run_score(worktree, clean_root)
    if code == 1 and not data.get("contract_ok") and any("tinytable/" in e for e in data.get("contract_errors", [])):
        ok("score.py: an edit to tinytable/ is caught via git status -> contract_ok=false")
    else:
        fail(f"score.py against a tinytable/-edited worktree: expected contract_ok=false, got {data}")


def main() -> int:
    if not MUTANTS_DIR.is_dir():
        print("mutants/ is missing - run this after issue #90's fixtures exist", file=sys.stderr)
        return 1

    with tempfile.TemporaryDirectory(prefix="tinytable-eval-score-selfcheck-") as td:
        tmp = pathlib.Path(td)
        scenario_killed_by_golden_suite(tmp, CLEAN)
        scenario_clean_is_not_killed(tmp, CLEAN)
        scenario_empty_agent_dir_fails_contract(tmp, CLEAN)
        scenario_noop_test_is_not_killed(tmp, CLEAN)
        scenario_editing_tinytable_fails_contract(tmp, CLEAN)

    print()
    if _failures:
        print(f"{len(_failures)} check(s) failed")
        return 1
    print("all score_selfcheck.py checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
