#!/usr/bin/env python3
"""Standalone self-check for score.py (issue #91), exercising it exactly the
way a future driver's `--seed-root` worktree is expected to: a fresh git
repo containing a `tinytable/` package, `sql-tests/official/*.test`, and an
empty `sql-tests/agent/` for an "agent" (a black-box tester, not a dev - see
task-prompt.md) to fill in with its own `.test` files.

Builds one ephemeral worktree per mutant (mutants/mNN) plus one for `clean`
itself, in a temp directory, and runs score.py against each under a few
scenarios - see the Acceptance Criteria in issue #91:

  1. sql-tests/agent/ seeded with every golden test (golden/mNN.test,
     copied in verbatim - these already are exactly the kind of black-box
     .test file a tester would write) -> for every mutant, expect
     killed=true, false_alarms=0, contract_ok=true (score.py exits 0); for
     `clean` itself (no defect to kill), expect killed=false.
  2. sql-tests/agent/ left empty -> expect contract_ok=false (score.py
     exits 1).
  3. sql-tests/agent/ seeded with a single no-op test -> expect
     killed=false (score.py exits 1) even though contract_ok is true.
  4. sql-tests/agent/ seeded like (1), but the "agent" also edits
     tinytable/core.py -> expect contract_ok=false regardless of killed.
  5. sql-tests/agent/ seeded like (1), but the "agent" also edits an
     official test file -> expect contract_ok=false regardless of killed.

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


_FINDINGS_JSON = json.dumps(
    [
        {
            "id": mid,
            "summary": f"see golden/{mid}.test",
            "spec_section": "SPEC.md",
            "repro_test": f"sql-tests/agent/{mid}.test",
        }
        for mid in MUTANT_IDS
    ],
    indent=2,
)

_NOOP_TEST = """\
# a no-op that passes against anything - proves score.py reports
# killed=false rather than a false "success" when an agent submits
# something that finds nothing.
statement ok
CREATE TABLE t (x INTEGER)

query I nosort
SELECT x FROM t
----
"""


def _git(*args: str, cwd: pathlib.Path) -> None:
    subprocess.run(["git", *args], cwd=str(cwd), check=True, capture_output=True, text=True)


def build_worktree(source_tinytable_root: pathlib.Path, dest: pathlib.Path) -> None:
    """Assemble a worktree at `dest`: tinytable/ (from `source_tinytable_root`),
    sql-tests/official/ (shared eval fixture), run_sql_tests.py + SPEC.md
    (for the agent's own local use - score.py itself always uses its own
    colocated run_sql_tests.py, never a worktree-local copy), and an empty
    sql-tests/agent/ - then git init + commit it as the pristine baseline a
    future agent starts from.
    """
    dest.mkdir(parents=True)
    shutil.copytree(source_tinytable_root / "tinytable", dest / "tinytable")
    shutil.copytree(source_tinytable_root / "sql-tests" / "official", dest / "sql-tests" / "official")
    shutil.copy2(HERE / "run_sql_tests.py", dest / "run_sql_tests.py")
    shutil.copy2(HERE / "SPEC.md", dest / "SPEC.md")
    (dest / "sql-tests" / "agent").mkdir()
    (dest / "sql-tests" / "agent" / ".gitkeep").write_text("")

    _git("init", "-q", cwd=dest)
    _git("config", "user.email", "selfcheck@example.com", cwd=dest)
    _git("config", "user.name", "selfcheck", cwd=dest)
    _git("add", "-A", cwd=dest)
    _git("commit", "-q", "-m", "seed", cwd=dest)


def seed_golden_suite(worktree: pathlib.Path) -> None:
    for mid in MUTANT_IDS:
        shutil.copy2(GOLDEN_DIR / f"{mid}.test", worktree / "sql-tests" / "agent" / f"{mid}.test")
    (worktree / "findings.json").write_text(_FINDINGS_JSON)


def run_score(
    worktree: pathlib.Path,
    clean_root: pathlib.Path,
    kill_matrix_pool: pathlib.Path | None = None,
    agent_blocked_reason: str | None = None,
) -> tuple[int, dict]:
    cmd = [sys.executable, str(SCORE_PY), "--worktree", str(worktree), "--clean", str(clean_root), "--out", "score.json"]
    if kill_matrix_pool is not None:
        cmd += ["--kill-matrix-pool", str(kill_matrix_pool)]
    if agent_blocked_reason is not None:
        cmd += ["--agent-blocked-reason", agent_blocked_reason]
    proc = subprocess.run(cmd, capture_output=True, text=True)
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
        seed_golden_suite(worktree)

        code, data = run_score(worktree, clean_root)
        if code == 0 and data.get("killed") and data.get("false_alarms") == 0 and data.get("contract_ok"):
            ok(f"score.py: golden-seeded suite kills {mid} (killed=true, false_alarms=0, contract_ok=true)")
        else:
            fail(f"score.py against {mid} with the golden-seeded suite: expected a clean kill, got {data}")
            continue
        expect_prefix = f"sql-tests/agent/{mid}.test:"
        killed_tests = data.get("killed_tests") or []
        if not killed_tests or not all(t.startswith(expect_prefix) for t in killed_tests):
            fail(f"score.py against {mid}: expected killed_tests all prefixed {expect_prefix!r}, got {killed_tests}")


def scenario_clean_is_not_killed(tmp: pathlib.Path, clean_root: pathlib.Path) -> None:
    worktree = tmp / "killed-clean"
    build_worktree(CLEAN, worktree)
    seed_golden_suite(worktree)

    code, data = run_score(worktree, clean_root)
    if code == 1 and not data.get("killed") and data.get("false_alarms") == 0 and data.get("contract_ok"):
        ok("score.py: golden-seeded suite against clean-as-worktree correctly reports killed=false (nothing to kill)")
    else:
        fail(f"score.py against clean-as-worktree: expected killed=false, false_alarms=0, contract_ok=true, got {data}")


def scenario_empty_agent_dir_fails_contract(tmp: pathlib.Path, clean_root: pathlib.Path) -> None:
    worktree = tmp / "empty-agent"
    build_worktree(MUTANTS_DIR / "m01", worktree)
    (worktree / "findings.json").write_text("[]")
    (worktree / "sql-tests" / "agent" / ".gitkeep").unlink()

    code, data = run_score(worktree, clean_root)
    if code == 1 and not data.get("contract_ok"):
        ok("score.py: empty sql-tests/agent/ reports contract_ok=false (failing gate)")
    else:
        fail(f"score.py against empty sql-tests/agent/: expected a failing gate via contract_ok=false, got {data}")


def scenario_noop_test_is_not_killed(tmp: pathlib.Path, clean_root: pathlib.Path) -> None:
    worktree = tmp / "noop-agent"
    build_worktree(MUTANTS_DIR / "m01", worktree)
    (worktree / "sql-tests" / "agent" / "noop.test").write_text(_NOOP_TEST)
    (worktree / "findings.json").write_text("[]")

    code, data = run_score(worktree, clean_root)
    if code == 1 and not data.get("killed") and data.get("contract_ok"):
        ok("score.py: no-op sql-tests/agent/ reports killed=false (failing gate) despite contract_ok=true")
    else:
        fail(f"score.py against a no-op sql-tests/agent/: expected killed=false with contract_ok=true, got {data}")


def scenario_editing_tinytable_fails_contract(tmp: pathlib.Path, clean_root: pathlib.Path) -> None:
    worktree = tmp / "cheat-edit-source"
    build_worktree(MUTANTS_DIR / "m01", worktree)
    seed_golden_suite(worktree)
    core_py = worktree / "tinytable" / "core.py"
    core_py.write_text(core_py.read_text() + "\n# an agent should never get away with editing this file\n")

    code, data = run_score(worktree, clean_root)
    if code == 1 and not data.get("contract_ok") and any("tinytable/" in e for e in data.get("contract_errors", [])):
        ok("score.py: an edit to tinytable/ is caught via git status -> contract_ok=false")
    else:
        fail(f"score.py against a tinytable/-edited worktree: expected contract_ok=false, got {data}")


def scenario_editing_official_tests_fails_contract(tmp: pathlib.Path, clean_root: pathlib.Path) -> None:
    worktree = tmp / "cheat-edit-official"
    build_worktree(MUTANTS_DIR / "m01", worktree)
    seed_golden_suite(worktree)
    official_file = next((worktree / "sql-tests" / "official").glob("*.test"))
    official_file.write_text(official_file.read_text() + "\n# tampered\n")

    code, data = run_score(worktree, clean_root)
    if code == 1 and not data.get("contract_ok") and any("sql-tests/official/" in e for e in data.get("contract_errors", [])):
        ok("score.py: an edit to sql-tests/official/ is caught via git status -> contract_ok=false")
    else:
        fail(f"score.py against a sql-tests/official/-edited worktree: expected contract_ok=false, got {data}")


def scenario_blocked_agent_gets_contract_credit(tmp: pathlib.Path, clean_root: pathlib.Path) -> None:
    # #108: an agent that hit a genuinely broken environment and correctly
    # stopped per UNATTENDED_PREAMBLE - no sql-tests/agent/, no
    # findings.json - must not be penalized the same way a lazy/failed
    # agent that submitted nothing for no stated reason would be.
    worktree = tmp / "blocked-agent"
    build_worktree(MUTANTS_DIR / "m01", worktree)
    (worktree / "sql-tests" / "agent" / ".gitkeep").unlink()

    code, data = run_score(worktree, clean_root, agent_blocked_reason="target database is unreachable from this sandbox")
    if data.get("contract_ok") and data.get("agent_blocked") and not data.get("killed") and not data.get("passed"):
        ok("score.py: a correctly-BLOCKED agent gets contract_ok=true credit despite an empty submission (still not `passed`, since it killed nothing)")
    else:
        fail(f"score.py with --agent-blocked-reason and an empty submission: expected contract_ok=true, agent_blocked=true, killed=false, passed=false, got {data}")


def scenario_blocked_agent_still_fails_on_protected_path_tampering(tmp: pathlib.Path, clean_root: pathlib.Path) -> None:
    # The #108 credit must never become a loophole for the #103 failure
    # mode: claiming BLOCKED does not excuse having also touched tinytable/.
    worktree = tmp / "blocked-but-tampered"
    build_worktree(MUTANTS_DIR / "m01", worktree)
    (worktree / "sql-tests" / "agent" / ".gitkeep").unlink()
    core_py = worktree / "tinytable" / "core.py"
    core_py.write_text(core_py.read_text() + "\n# tampered despite claiming BLOCKED\n")

    code, data = run_score(worktree, clean_root, agent_blocked_reason="claims it's broken")
    if not data.get("contract_ok") and any("tinytable/" in e for e in data.get("contract_errors", [])):
        ok("score.py: --agent-blocked-reason never waives the protected-path check")
    else:
        fail(f"score.py with --agent-blocked-reason against a tampered worktree: expected contract_ok=false via a tinytable/ error, got {data}")


def scenario_blocked_agent_with_malformed_findings_still_flagged(tmp: pathlib.Path, clean_root: pathlib.Path) -> None:
    # If a blocked agent wrote *something* anyway, that something is still
    # validated normally - blocking only waives the "must submit" rule, not
    # the format of whatever was actually submitted.
    worktree = tmp / "blocked-malformed-findings"
    build_worktree(MUTANTS_DIR / "m01", worktree)
    (worktree / "sql-tests" / "agent" / ".gitkeep").unlink()
    (worktree / "findings.json").write_text("not valid json")

    code, data = run_score(worktree, clean_root, agent_blocked_reason="partially explored, then hit a wall")
    if not data.get("contract_ok") and any("findings.json" in e for e in data.get("contract_errors", [])):
        ok("score.py: --agent-blocked-reason still validates a findings.json the agent did write")
    else:
        fail(f"score.py with --agent-blocked-reason and malformed findings.json: expected contract_ok=false, got {data}")


def scenario_pycache_from_running_tests_is_not_flagged_as_tampering(tmp: pathlib.Path, clean_root: pathlib.Path) -> None:
    # Regression: an agent that actually runs `python3 run_sql_tests.py`
    # (per task-prompt.md's own instructions - and the whole point of #115
    # fixing dsh's bash tool inside the exam room) makes Python write
    # tinytable/__pycache__/*.pyc as an unavoidable side effect of merely
    # importing the package. A freshly seeded worktree has no .gitignore of
    # its own to make git status ignore that, so this must be filtered
    # explicitly - not flagged as tampering with a protected path.
    worktree = tmp / "pycache-from-real-run"
    build_worktree(MUTANTS_DIR / "m01", worktree)
    seed_golden_suite(worktree)
    subprocess.run(
        [sys.executable, "run_sql_tests.py", "--root", ".", "sql-tests/official"],
        cwd=str(worktree), check=True, capture_output=True, text=True
    )
    if not any((worktree / "tinytable" / "__pycache__").glob("*.pyc")):
        fail("scenario setup: expected tinytable/__pycache__/*.pyc to exist after actually running the tests")
        return

    code, data = run_score(worktree, clean_root)
    if code == 0 and data.get("contract_ok") and not data.get("contract_errors"):
        ok("score.py: tinytable/__pycache__ generated by actually running the tests is not flagged as tampering")
    else:
        fail(f"score.py against a worktree with real __pycache__ from running tests: expected contract_ok=true, got {data}")


def scenario_kill_matrix_absent_without_the_flag(tmp: pathlib.Path, clean_root: pathlib.Path) -> None:
    worktree = tmp / "kill-matrix-absent"
    build_worktree(MUTANTS_DIR / "m01", worktree)
    seed_golden_suite(worktree)

    code, data = run_score(worktree, clean_root)
    if code == 0 and data.get("kill_matrix") is None:
        ok("score.py: kill_matrix is absent (null) when --kill-matrix-pool isn't passed")
    else:
        fail(f"score.py without --kill-matrix-pool: expected kill_matrix=null, got {data.get('kill_matrix')!r}")


# #107: a suite comprehensive enough to correctly kill every seeded defect
# (the golden suite) necessarily also kills every mutant in the pool when
# run against each of them in turn - the kill matrix can't distinguish that
# from indiscriminate over-broad hedging by itself (that's a judgment call
# for whoever reads the report), but it must at least report the true,
# consistent signal: every pool member killed=true, matching selfcheck.py's
# own independent "golden/mNN.test kills mutants/mNN" check for each NN.
def scenario_kill_matrix_with_golden_suite(tmp: pathlib.Path, clean_root: pathlib.Path) -> None:
    worktree = tmp / "kill-matrix-golden"
    build_worktree(MUTANTS_DIR / "m01", worktree)
    seed_golden_suite(worktree)

    code, data = run_score(worktree, clean_root, kill_matrix_pool=MUTANTS_DIR)
    kill_matrix = data.get("kill_matrix") or {}
    expected = {mid: True for mid in MUTANT_IDS}
    if code == 0 and kill_matrix == expected:
        ok(f"score.py: --kill-matrix-pool with the golden suite kills every pool member: {kill_matrix}")
    else:
        fail(f"score.py --kill-matrix-pool with the golden suite: expected {expected}, got {kill_matrix}")


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
        scenario_editing_official_tests_fails_contract(tmp, CLEAN)
        scenario_blocked_agent_gets_contract_credit(tmp, CLEAN)
        scenario_blocked_agent_still_fails_on_protected_path_tampering(tmp, CLEAN)
        scenario_blocked_agent_with_malformed_findings_still_flagged(tmp, CLEAN)
        scenario_pycache_from_running_tests_is_not_flagged_as_tampering(tmp, CLEAN)
        scenario_kill_matrix_absent_without_the_flag(tmp, CLEAN)
        scenario_kill_matrix_with_golden_suite(tmp, CLEAN)

    print()
    if _failures:
        print(f"{len(_failures)} check(s) failed")
        return 1
    print("all score_selfcheck.py checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
