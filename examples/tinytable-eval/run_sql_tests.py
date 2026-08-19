#!/usr/bin/env python3
"""Run .test files (a small sqllogictest-inspired subset - see SPEC.md's
"Test Script Format" section for the exact record grammar) against one
tinytable install.

Usage:
    python3 run_sql_tests.py --root clean sql-tests/official
    python3 run_sql_tests.py --root path/to/mutant path/to/golden/m03.test

One process per --root by design (mirrors score.py's own external,
subprocess-per-target invocation elsewhere in this eval suite) - this avoids
Python's module cache making a second `import tinytable` silently reuse the
first root's code if this were ever asked to compare two roots in one run.

Exit code 0 iff every record in every file passed.
"""

from __future__ import annotations

import argparse
import pathlib
import sys
from dataclasses import dataclass
from typing import Optional, Union


@dataclass
class StatementRecord:
    kind: str  # "ok" | "error"
    error_pattern: Optional[str]
    sql: str
    line: int


@dataclass
class QueryRecord:
    types: str
    sort_mode: str
    sql: str
    expected: list[str]
    line: int


Record = Union[StatementRecord, QueryRecord]


class TestFileError(Exception):
    pass


def _is_blank(line: str) -> bool:
    return line.strip() == ""


def parse_test_file(path: pathlib.Path) -> list[Record]:
    lines = path.read_text().splitlines()
    records: list[Record] = []
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        if _is_blank(line) or line.lstrip().startswith("#"):
            i += 1
            continue
        header_line_no = i + 1
        parts = line.split()
        if parts[0] == "statement":
            if len(parts) < 2 or parts[1] not in ("ok", "error"):
                raise TestFileError(f"{path}:{header_line_no}: expected 'statement ok' or 'statement error ...'")
            kind = parts[1]
            error_pattern = " ".join(parts[2:]) if kind == "error" and len(parts) > 2 else None
            i += 1
            sql_lines = []
            while i < n and not _is_blank(lines[i]):
                sql_lines.append(lines[i])
                i += 1
            if not sql_lines:
                raise TestFileError(f"{path}:{header_line_no}: 'statement' record has no SQL text")
            records.append(StatementRecord(kind=kind, error_pattern=error_pattern, sql="\n".join(sql_lines), line=header_line_no))
        elif parts[0] == "query":
            types = parts[1] if len(parts) > 1 else ""
            sort_mode = parts[2] if len(parts) > 2 else "nosort"
            if sort_mode not in ("nosort", "rowsort"):
                raise TestFileError(f"{path}:{header_line_no}: unknown sort mode {sort_mode!r} (expected nosort/rowsort)")
            i += 1
            sql_lines = []
            while i < n and lines[i] != "----":
                if _is_blank(lines[i]):
                    raise TestFileError(f"{path}:{i + 1}: 'query' record hit a blank line before '----'")
                sql_lines.append(lines[i])
                i += 1
            if i >= n:
                raise TestFileError(f"{path}:{header_line_no}: 'query' record missing '----' terminator")
            i += 1  # skip "----"
            expected = []
            while i < n and not _is_blank(lines[i]):
                expected.append(lines[i])
                i += 1
            records.append(QueryRecord(types=types, sort_mode=sort_mode, sql="\n".join(sql_lines), expected=expected, line=header_line_no))
        else:
            raise TestFileError(f"{path}:{header_line_no}: unrecognized record header {line!r}")
    return records


def _render(value) -> str:
    return "NULL" if value is None else str(value)


def _check_query(record: QueryRecord, columns: list[str], rows: list[tuple]) -> Optional[str]:
    if len(columns) != len(record.types):
        return f"column count mismatch: types={record.types!r} implies {len(record.types)}, got {len(columns)} columns {columns}"
    width = len(record.types)
    rendered_actual = [_render(v) for row in rows for v in row]
    if record.sort_mode == "rowsort":
        def grouped(flat: list[str]) -> list[tuple]:
            return sorted(tuple(flat[i : i + width]) for i in range(0, len(flat), width))

        actual_g = grouped(rendered_actual)
        expected_g = grouped(record.expected)
        if actual_g != expected_g:
            return f"rowsort mismatch:\n    expected: {expected_g}\n    actual:   {actual_g}"
    else:
        if rendered_actual != record.expected:
            return f"nosort mismatch:\n    expected: {record.expected}\n    actual:   {rendered_actual}"
    return None


def run_file(path: pathlib.Path, tinytable) -> list[tuple[int, str]]:
    records = parse_test_file(path)
    db = tinytable.Database()
    failures: list[tuple[int, str]] = []
    for record in records:
        if isinstance(record, StatementRecord):
            try:
                db.execute(record.sql)
                error: Optional[Exception] = None
            except Exception as exc:  # noqa: BLE001 - deliberately broad, this is a test harness
                error = exc
            if record.kind == "ok" and error is not None:
                failures.append((record.line, f"expected to succeed but raised {type(error).__name__}: {error}\n    sql: {record.sql}"))
            elif record.kind == "error" and error is None:
                failures.append((record.line, f"expected to raise but succeeded\n    sql: {record.sql}"))
            elif record.kind == "error" and error is not None and record.error_pattern and record.error_pattern not in str(error):
                failures.append(
                    (record.line, f"raised {type(error).__name__}({error!r}) but that does not contain expected text {record.error_pattern!r}\n    sql: {record.sql}")
                )
        else:
            try:
                result = db.execute(record.sql)
            except Exception as exc:  # noqa: BLE001
                failures.append((record.line, f"query raised {type(exc).__name__}: {exc}\n    sql: {record.sql}"))
                continue
            problem = _check_query(record, result.columns, result.rows)
            if problem:
                failures.append((record.line, f"{problem}\n    sql: {record.sql}"))
    return failures


def collect_test_files(paths: list[str]) -> list[pathlib.Path]:
    files: list[pathlib.Path] = []
    for raw in paths:
        p = pathlib.Path(raw)
        if p.is_dir():
            files.extend(sorted(p.rglob("*.test")))
        else:
            files.append(p)
    return files


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", required=True, help="directory containing a tinytable/ package to test")
    parser.add_argument("paths", nargs="+", help="*.test files, or directories to search for them")
    args = parser.parse_args()

    root = pathlib.Path(args.root).resolve()
    sys.path.insert(0, str(root))
    import tinytable  # local import: must happen after sys.path is set up

    files = collect_test_files(args.paths)
    if not files:
        print("no .test files found", file=sys.stderr)
        return 1

    total_failures = 0
    for path in files:
        try:
            failures = run_file(path, tinytable)
        except TestFileError as exc:
            print(f"FAIL {path} (malformed test file)")
            print(f"  {exc}")
            total_failures += 1
            continue
        if failures:
            total_failures += len(failures)
            print(f"FAIL {path} ({len(failures)} failure(s))")
            for line, message in failures:
                print(f"  line {line}: {message}")
        else:
            print(f"ok   {path}")

    print()
    if total_failures:
        print(f"{total_failures} failure(s) across {len(files)} file(s)")
        return 1
    print(f"all {len(files)} file(s) passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
