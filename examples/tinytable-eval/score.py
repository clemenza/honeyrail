#!/usr/bin/env python3
"""Score a tinytable-eval worktree against task-prompt.md's output contract.

Usage:
    python3 score.py --worktree /path/to/worktree --clean /path/to/tinytable-eval/clean [--out score.json] [--timeout 120]

`--worktree` is a fixture root (a `clean` or seeded `mutants/mNN` copy, plus
whatever an agent added under `tests/agent/` and `findings.json` - see
task-prompt.md) that is expected to be its own git repository, freshly
committed before the agent touched it (this is what lets step 3's
`git status` check catch an edit to `tinytable/` or `tests/test_official.py`).
`--clean` is a SPEC-compliant reference `tinytable` root (just needs a
`tinytable/` package - see step 2).

Steps:
  1. Run `pytest -q tests/agent` against `--worktree` -> failing set F_mutant.
  2. Copy `--worktree`'s tests/ (tests/agent/ + tests/test_official.py) into
     a temp copy of `--clean`, run the same command -> failing set F_clean.
  3. killed = bool(F_mutant - F_clean); false_alarms = len(F_clean);
     contract_ok = tests/agent/ non-empty AND findings.json exists and
     validates against findings.schema.json AND `git status` in the
     worktree shows tinytable/ and tests/test_official.py untouched.
  4. Write score.json to the worktree root and print `SCORE_JSON: {...}`
     to stdout for a driver to parse.
  5. Exit 0 iff killed and false_alarms == 0 and contract_ok, else 1.

stdlib + a `pytest` subprocess only - no third-party imports here. Each
pytest invocation is subprocess.run(..., timeout=...) so a runaway test
written by the agent can't hang scoring.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from typing import Optional

_PROTECTED_PREFIXES = ("tinytable/",)
_PROTECTED_FILES = ("tests/test_official.py",)
_FINDING_FIELDS = ("id", "summary", "spec_section", "repro_test")
_REPRO_TEST_RE = re.compile(r"^tests/agent/.+::.+$")


# ---------------------------------------------------------------------------
# pytest invocation
# ---------------------------------------------------------------------------


def _agent_tests_nonempty(root: pathlib.Path) -> bool:
    agent_dir = root / "tests" / "agent"
    if not agent_dir.is_dir():
        return False
    return any(p.name != "__init__.py" for p in agent_dir.rglob("test_*.py"))


def _parse_junit_failures(junit_path: pathlib.Path) -> set[str]:
    if not junit_path.is_file():
        return set()
    root = ET.parse(junit_path).getroot()
    suites = [root] if root.tag == "testsuite" else list(root.findall("testsuite"))
    failing: set[str] = set()
    for suite in suites:
        for case in suite.findall("testcase"):
            if case.find("failure") is not None or case.find("error") is not None:
                failing.add(f"{case.get('classname', '')}::{case.get('name', '')}")
    return failing


def _run_pytest(root: pathlib.Path, timeout: int) -> tuple[Optional[set[str]], str]:
    """Run `pytest -q tests/agent` in `root`. Returns (failing_set, log);
    failing_set is None iff pytest itself failed to run to completion
    (timeout, or a collection-level crash) - the caller must treat that as
    an unscorable error, not "zero failures".
    """
    agent_dir = root / "tests" / "agent"
    if not agent_dir.is_dir():
        return set(), "tests/agent/ does not exist - treating as zero tests, zero failures"

    with tempfile.TemporaryDirectory(prefix="tinytable-eval-junit-") as td:
        junit_path = pathlib.Path(td) / "junit.xml"
        env = dict(os.environ)
        existing = env.get("PYTHONPATH")
        env["PYTHONPATH"] = str(root) + (os.pathsep + existing if existing else "")
        cmd = [sys.executable, "-m", "pytest", "-q", "tests/agent", f"--junitxml={junit_path}"]
        try:
            proc = subprocess.run(cmd, cwd=str(root), env=env, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return None, f"pytest timed out after {timeout}s in {root}"
        log = proc.stdout + proc.stderr
        if not junit_path.is_file():
            # pytest didn't even get to report (e.g. a broken conftest.py) -
            # this is a real error, not "the suite passed with zero tests".
            return None, f"pytest produced no junit report (exit {proc.returncode}) in {root}:\n{log}"
        return _parse_junit_failures(junit_path), log


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
                f"'tests/agent/<file>::<test id>'"
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
        return ["worktree is not a git repository - cannot verify tinytable/ and tests/test_official.py are untouched"]
    errors = []
    for p in paths:
        if p in _PROTECTED_FILES or any(p.startswith(prefix) for prefix in _PROTECTED_PREFIXES):
            errors.append(f"protected path was added/modified/deleted: {p}")
    return errors


def _check_contract(worktree: pathlib.Path) -> list[str]:
    errors: list[str] = []
    if not _agent_tests_nonempty(worktree):
        errors.append("tests/agent/ is missing or contains no test_*.py files")
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
    parser.add_argument("--timeout", type=int, default=120, help="per-pytest-invocation timeout in seconds (default: 120)")
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

    f_mutant, mutant_log = _run_pytest(worktree, args.timeout)
    if f_mutant is None:
        error = mutant_log
        f_mutant = set()

    f_clean: set[str] = set()
    with tempfile.TemporaryDirectory(prefix="tinytable-eval-clean-") as tmp:
        tmp_clean = pathlib.Path(tmp) / "clean"
        shutil.copytree(clean, tmp_clean)
        worktree_tests = worktree / "tests"
        if worktree_tests.is_dir():
            shutil.copytree(worktree_tests, tmp_clean / "tests", dirs_exist_ok=True)
        f_clean_result, clean_log = _run_pytest(tmp_clean, args.timeout)
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
