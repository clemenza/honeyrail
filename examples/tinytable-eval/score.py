#!/usr/bin/env python3
"""Score a tinytable-eval worktree against task-prompt.md's output contract.

Usage:
    python3 score.py --worktree /path/to/worktree --clean /path/to/tinytable-eval/clean [--out score.json] [--timeout 120]

`--worktree` is a fixture root (a `clean` or seeded `mutants/mNN` copy, plus
whatever an agent added under `sql-tests/agent/` and `findings.json` - see
task-prompt.md) that is expected to be its own git repository, freshly
committed before the agent touched it (this is what lets step 3's
`git status` check catch an edit to `tinytable/` or `sql-tests/official/`).
`--clean` is a SPEC-compliant reference `tinytable` root (just needs a
`tinytable/` package - see step 2).

Agent tests are `.test` files (SPEC.md's "Test Script Format" - the same
black-box, SQL-in/rows-out format as sql-tests/official/*.test), scored via
this file's own colocated run_sql_tests.py - never whatever copy, if any,
happens to sit inside the worktree - so an agent can't influence scoring by
touching the runner.

Steps:
  1. Run run_sql_tests.py against `--worktree`'s sql-tests/agent/ -> failing
     set F_mutant (one entry per failing record: "<path>:<line>").
  2. Copy `--worktree`'s sql-tests/ (sql-tests/agent/ + sql-tests/official/)
     onto a temp copy of `--clean`, run the same command -> F_clean.
  3. killed = bool(F_mutant - F_clean); false_alarms = len(F_clean);
     contract_ok = sql-tests/agent/ has at least one *.test file AND
     findings.json exists and validates against findings.schema.json AND
     `git status` in the worktree shows tinytable/ and sql-tests/official/
     untouched.
  4. Write score.json to the worktree root and print `SCORE_JSON: {...}`
     to stdout for a driver to parse.
  5. Exit 0 iff killed and false_alarms == 0 and contract_ok, else 1.

stdlib only (run_sql_tests.py, invoked as a subprocess, is itself stdlib -
no pytest, no third-party imports anywhere in this pipeline). Each
run_sql_tests.py invocation is subprocess.run(..., timeout=...) so a
runaway or looping test written by the agent can't hang scoring.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
from typing import Optional

HERE = pathlib.Path(__file__).resolve().parent
RUNNER = HERE / "run_sql_tests.py"

_PROTECTED_PREFIXES = ("tinytable/", "sql-tests/official/")
_FINDING_FIELDS = ("id", "summary", "spec_section", "repro_test")
_REPRO_TEST_RE = re.compile(r"^sql-tests/agent/.+\.test(:[0-9]+)?$")

_FAIL_HEADER_RE = re.compile(r"^FAIL (?P<path>\S.*?) \((?P<detail>.+)\)$")
_FAIL_LINE_RE = re.compile(r"^  line (?P<line>\d+): ")


# ---------------------------------------------------------------------------
# run_sql_tests.py invocation
# ---------------------------------------------------------------------------


def _agent_tests_nonempty(root: pathlib.Path) -> bool:
    agent_dir = root / "sql-tests" / "agent"
    if not agent_dir.is_dir():
        return False
    return any(agent_dir.rglob("*.test"))


def _parse_failing_ids(output: str) -> set[str]:
    """Parse run_sql_tests.py's stdout into a set of "<path>:<line>"
    failing-record identifiers (":0" for a whole file that failed to parse -
    see the "malformed test file" case in run_sql_tests.py's own output).
    `path` is exactly the token run_sql_tests.py printed, which - since we
    always invoke it with a path relative to `root` while cwd=root - is
    already relative and directly comparable between two different roots.
    """
    failing: set[str] = set()
    current: Optional[str] = None
    for line in output.splitlines():
        header = _FAIL_HEADER_RE.match(line)
        if header:
            current = header.group("path")
            if "malformed test file" in header.group("detail"):
                failing.add(f"{current}:0")
            continue
        record = _FAIL_LINE_RE.match(line)
        if record and current is not None:
            failing.add(f"{current}:{record.group('line')}")
    return failing


def _run_sql_tests(root: pathlib.Path, subdir: str, timeout: int) -> tuple[Optional[set[str]], str]:
    """Run run_sql_tests.py --root `root` `subdir` (cwd=root, so `subdir`
    stays relative in the output). Returns (failing_set, log); failing_set
    is None iff the runner itself failed to run to completion (timeout, or
    a crash) - the caller must treat that as an unscorable error, not "zero
    failures".
    """
    target_dir = root / subdir
    if not target_dir.is_dir():
        return set(), f"{subdir}/ does not exist - treating as zero tests, zero failures"

    cmd = [sys.executable, str(RUNNER), "--root", str(root), subdir]
    try:
        proc = subprocess.run(cmd, cwd=str(root), capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, f"run_sql_tests.py timed out after {timeout}s in {root}"
    log = proc.stdout + proc.stderr
    if "Traceback (most recent call last):" in proc.stderr:
        return None, f"run_sql_tests.py crashed in {root}:\n{log}"
    return _parse_failing_ids(proc.stdout), log


# ---------------------------------------------------------------------------
# contract checks
# ---------------------------------------------------------------------------


def _validate_findings(path: pathlib.Path) -> list[str]:
    if not path.is_file():
        return ["findings.json does not exist"]
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        return [f"findings.json is not valid JSON: {exc}"]
    if not isinstance(data, list):
        return ["findings.json must be a JSON array"]

    errors: list[str] = []
    for i, entry in enumerate(data):
        if not isinstance(entry, dict):
            errors.append(f"findings.json[{i}] is not an object")
            continue
        extra = sorted(set(entry.keys()) - set(_FINDING_FIELDS))
        if extra:
            errors.append(f"findings.json[{i}] has unexpected field(s): {extra}")
        for field in _FINDING_FIELDS:
            value = entry.get(field)
            if field not in entry:
                errors.append(f"findings.json[{i}] missing required field {field!r}")
            elif not isinstance(value, str) or not value:
                errors.append(f"findings.json[{i}].{field} must be a non-empty string")
        repro_test = entry.get("repro_test")
        if isinstance(repro_test, str) and repro_test and not _REPRO_TEST_RE.match(repro_test):
            errors.append(
                f"findings.json[{i}].repro_test {repro_test!r} does not look like "
                f"'sql-tests/agent/<file>.test' (optionally ':<line>')"
            )
    return errors


def _git_status_paths(root: pathlib.Path) -> Optional[list[str]]:
    """List of paths git considers changed (modified, added, deleted, or
    untracked) in `root`. None if `root` isn't a git repo at all.
    """
    check = subprocess.run(
        ["git", "-C", str(root), "rev-parse", "--is-inside-work-tree"],
        capture_output=True, text=True,
    )
    if check.returncode != 0:
        return None
    proc = subprocess.run(
        ["git", "-C", str(root), "status", "--porcelain=v1", "--untracked-files=all"],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"git status failed in {root}: {proc.stderr.strip()}")
    paths: list[str] = []
    for line in proc.stdout.splitlines():
        if not line.strip():
            continue
        entry = line[3:].strip().strip('"')
        if " -> " in entry:  # rename/copy: "old -> new"
            old, _, new = entry.partition(" -> ")
            paths.extend([old, new])
        else:
            paths.append(entry)
    return paths


def _check_protected_paths_untouched(root: pathlib.Path) -> list[str]:
    paths = _git_status_paths(root)
    if paths is None:
        return ["worktree is not a git repository - cannot verify tinytable/ and sql-tests/official/ are untouched"]
    errors = []
    for p in paths:
        if any(p.startswith(prefix) for prefix in _PROTECTED_PREFIXES):
            errors.append(f"protected path was added/modified/deleted: {p}")
    return errors


def _check_contract(worktree: pathlib.Path) -> list[str]:
    errors: list[str] = []
    if not _agent_tests_nonempty(worktree):
        errors.append("sql-tests/agent/ is missing or contains no *.test files")
    errors.extend(_validate_findings(worktree / "findings.json"))
    errors.extend(_check_protected_paths_untouched(worktree))
    return errors


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--worktree", required=True, help="fixture root to score (clean or a seeded mutant, plus the agent's changes)")
    parser.add_argument("--clean", required=True, help="SPEC-compliant reference tinytable root (e.g. tinytable-eval/clean)")
    parser.add_argument("--out", default="score.json", help="output filename, written under --worktree (default: score.json)")
    parser.add_argument("--timeout", type=int, default=120, help="per-run_sql_tests.py-invocation timeout in seconds (default: 120)")
    args = parser.parse_args()

    worktree = pathlib.Path(args.worktree).resolve()
    clean = pathlib.Path(args.clean).resolve()
    if not worktree.is_dir():
        parser.error(f"--worktree {worktree} is not a directory")
    if not (clean / "tinytable").is_dir():
        parser.error(f"--clean {clean} has no tinytable/ package")

    contract_errors = _check_contract(worktree)
    contract_ok = not contract_errors

    error: Optional[str] = None

    f_mutant, mutant_log = _run_sql_tests(worktree, "sql-tests/agent", args.timeout)
    if f_mutant is None:
        error = mutant_log
        f_mutant = set()

    f_clean: set[str] = set()
    with tempfile.TemporaryDirectory(prefix="tinytable-eval-clean-") as tmp:
        tmp_clean = pathlib.Path(tmp) / "clean"
        shutil.copytree(clean, tmp_clean)
        worktree_sql_tests = worktree / "sql-tests"
        if worktree_sql_tests.is_dir():
            shutil.copytree(worktree_sql_tests, tmp_clean / "sql-tests", dirs_exist_ok=True)
        f_clean_result, clean_log = _run_sql_tests(tmp_clean, "sql-tests/agent", args.timeout)
        if f_clean_result is None:
            error = f"{error}\n{clean_log}" if error else clean_log
        else:
            f_clean = f_clean_result

    killed_tests = sorted(f_mutant - f_clean)
    killed = bool(killed_tests)
    false_alarms = len(f_clean)
    passed = killed and false_alarms == 0 and contract_ok and error is None

    result = {
        "worktree": str(worktree),
        "clean": str(clean),
        "killed": killed,
        "killed_tests": killed_tests,
        "false_alarms": false_alarms,
        "contract_ok": contract_ok,
        "contract_errors": contract_errors,
        "f_mutant": sorted(f_mutant),
        "f_clean": sorted(f_clean),
        "error": error,
        "passed": passed,
    }

    out_path = pathlib.Path(args.out)
    if not out_path.is_absolute():
        out_path = worktree / out_path
    out_path.write_text(json.dumps(result, indent=2) + "\n")

    print(f"SCORE_JSON: {json.dumps(result)}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
