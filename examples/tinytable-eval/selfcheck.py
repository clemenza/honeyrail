#!/usr/bin/env python3
"""Standalone self-check for the tinytable-eval fixtures (mutants/ + golden/
- see SPEC.md and issue #90). Verifies:

  (a) the official test suite (sql-tests/official/) passes on `clean` and on
      every mutant in mutants/ - a mutant that fails the official suite
      isn't "sneaky", it's just broken and would give itself away.
  (b) each mutant's tinytable/ differs from clean/tinytable/ by exactly one
      contiguous source diff (one file, one hunk) - the single injected
      defect, nothing more.
  (c) each mutant's sql-tests/official/ is byte-identical to clean's (the
      "same official test suite copied in" requirement).
  (d) golden/mNN.test is green on `clean` and kills (fails on) mutants/mNN.

Run standalone: `python3 selfcheck.py` (paths are resolved relative to this
file, so the working directory doesn't matter). Exit code 0 iff every check
passes.
"""

from __future__ import annotations

import difflib
import filecmp
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
CLEAN = HERE / "clean"
MUTANTS_DIR = HERE / "mutants"
GOLDEN_DIR = HERE / "golden"
OFFICIAL = CLEAN / "sql-tests" / "official"
RUNNER = HERE / "run_sql_tests.py"

MUTANT_IDS = [f"m{i:02d}" for i in range(1, 9)]

_failures: list[str] = []


def fail(msg: str) -> None:
    _failures.append(msg)
    print(f"FAIL {msg}")


def ok(msg: str) -> None:
    print(f"ok   {msg}")


def run_suite(root: pathlib.Path, *paths: pathlib.Path) -> tuple[bool, str]:
    """Run run_sql_tests.py --root <root> <paths...> in a fresh subprocess
    (one process per root, per run_sql_tests.py's own docstring - this
    avoids Python's module cache reusing a previous root's `tinytable`).
    """
    proc = subprocess.run(
        [sys.executable, str(RUNNER), "--root", str(root), *[str(p) for p in paths]],
        capture_output=True,
        text=True,
    )
    return proc.returncode == 0, proc.stdout + proc.stderr


def check_official_suite_passes() -> None:
    passed, output = run_suite(CLEAN, OFFICIAL)
    if passed:
        ok("official suite passes on clean")
    else:
        fail(f"official suite fails on clean:\n{output}")

    for mid in MUTANT_IDS:
        root = MUTANTS_DIR / mid
        if not root.is_dir():
            fail(f"mutants/{mid} is missing")
            continue
        passed, output = run_suite(root, root / "sql-tests" / "official")
        if passed:
            ok(f"official suite passes on mutants/{mid} (defect stays hidden from it)")
        else:
            fail(f"official suite fails on mutants/{mid} - defect is not sneaky:\n{output}")


def _all_files(root: pathlib.Path) -> set[pathlib.Path]:
    return {p.relative_to(root) for p in root.rglob("*") if p.is_file() and "__pycache__" not in p.parts}


def check_exactly_one_diff() -> None:
    for mid in MUTANT_IDS:
        mutant_root = MUTANTS_DIR / mid
        if not mutant_root.is_dir():
            continue

        clean_tt = CLEAN / "tinytable"
        mutant_tt = mutant_root / "tinytable"
        clean_files = _all_files(clean_tt)
        mutant_files = _all_files(mutant_tt)
        if clean_files != mutant_files:
            fail(f"mutants/{mid}/tinytable has a different file set than clean/tinytable: "
                 f"{clean_files.symmetric_difference(mutant_files)}")
            continue

        differing = [f for f in sorted(clean_files) if not filecmp.cmp(clean_tt / f, mutant_tt / f, shallow=False)]
        if len(differing) != 1:
            fail(f"mutants/{mid}/tinytable differs from clean in {len(differing)} file(s), expected exactly 1: {differing}")
            continue

        changed_file = differing[0]
        clean_lines = (clean_tt / changed_file).read_text().splitlines(keepends=True)
        mutant_lines = (mutant_tt / changed_file).read_text().splitlines(keepends=True)
        # A generous context (well beyond difflib's default of 3) so a
        # single logical edit that touches a few nearby lines - e.g. three
        # short guard clauses removed from three adjacent methods - reads
        # as one hunk instead of splitting on the unchanged lines between
        # them; a change that touches truly unrelated regions still won't
        # merge into one hunk at this window.
        diff = list(difflib.unified_diff(clean_lines, mutant_lines, n=6))
        hunks = [line for line in diff if line.startswith("@@")]
        if len(hunks) != 1:
            fail(f"mutants/{mid}/tinytable/{changed_file} differs from clean in {len(hunks)} hunks, expected exactly 1")
            continue

        ok(f"mutants/{mid} differs from clean by exactly one source diff (in {changed_file})")

        # (c) the official test suite copied into the mutant must be an
        # untouched copy of clean's - no per-mutant hints via test edits.
        clean_official = _all_files(OFFICIAL)
        mutant_official_dir = mutant_root / "sql-tests" / "official"
        mutant_official = _all_files(mutant_official_dir)
        if clean_official != mutant_official:
            fail(f"mutants/{mid}/sql-tests/official has a different file set than clean's: "
                 f"{clean_official.symmetric_difference(mutant_official)}")
            continue
        official_differing = [f for f in sorted(clean_official) if not filecmp.cmp(OFFICIAL / f, mutant_official_dir / f, shallow=False)]
        if official_differing:
            fail(f"mutants/{mid}/sql-tests/official is not an untouched copy of clean's: {official_differing}")
        else:
            ok(f"mutants/{mid}/sql-tests/official is an untouched copy of clean's")


def check_golden_tests() -> None:
    for mid in MUTANT_IDS:
        golden_file = GOLDEN_DIR / f"{mid}.test"
        mutant_root = MUTANTS_DIR / mid
        if not golden_file.is_file():
            fail(f"golden/{mid}.test is missing")
            continue
        if not mutant_root.is_dir():
            continue

        passed, output = run_suite(CLEAN, golden_file)
        if passed:
            ok(f"golden/{mid}.test is green on clean")
        else:
            fail(f"golden/{mid}.test is NOT green on clean:\n{output}")

        passed, output = run_suite(mutant_root, golden_file)
        if not passed:
            ok(f"golden/{mid}.test kills mutants/{mid}")
        else:
            fail(f"golden/{mid}.test does NOT kill mutants/{mid} (mutant passed it)")


def main() -> int:
    if not RUNNER.is_file():
        print(f"cannot find run_sql_tests.py at {RUNNER}", file=sys.stderr)
        return 1

    check_official_suite_passes()
    check_exactly_one_diff()
    check_golden_tests()

    print()
    if _failures:
        print(f"{len(_failures)} check(s) failed")
        return 1
    print("all selfcheck.py checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
