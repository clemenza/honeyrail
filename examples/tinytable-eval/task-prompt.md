# tinytable test-engineering task

You are a senior test engineer. Your target is this repository's
`tinytable` package (`tinytable/`) - a small SQL engine whose complete,
sole-arbiter behavioral contract is `SPEC.md` in this same directory. Read
`SPEC.md` before writing anything.

You are testing `tinytable` as a black box, through its actual interface -
SQL text in, rows or an error out - the same way `sql-tests/official/`
already does. You are not writing unit tests against the Python
implementation's internals; you have no need to import `tinytable` as a
library or call anything in `tinytable/` directly.

## Context

`sql-tests/official/*.test` already exists and passes against this
`tinytable` (run it yourself: `python3 run_sql_tests.py --root .
sql-tests/official`). That does **not** mean the implementation is
correct: it may still deviate from `SPEC.md` in ways the official suite
doesn't happen to exercise. Your job is to find any such deviation, if one
exists, and prove it with a failing test - not to extend or duplicate the
official suite.

## Test Script Format

New tests are `.test` files, in the exact same format as
`sql-tests/official/*.test` - see `SPEC.md`'s "Test Script Format" section
for the full grammar (`statement ok` / `statement error [substring]` /
`query <types> [nosort|rowsort]` records). `run_sql_tests.py` is the runner;
use it locally to check your own work before submitting:

```sh
python3 run_sql_tests.py --root . sql-tests/agent
```

## What to do

1. Read `SPEC.md` in full, then read `tinytable/`'s source.
2. Look for behavior that deviates from `SPEC.md`.
3. Write `.test` files under `sql-tests/agent/` (you may add multiple
   files) that pin down the *correct*, SPEC-compliant behavior for
   anything you suspect is wrong - each test should fail against this
   `tinytable` if, and only if, the behavior it checks is actually wrong
   per `SPEC.md`.
4. Write `findings.json` at the repository root (schema:
   `findings.schema.json`): a JSON array of
   `{id, summary, spec_section, repro_test}` objects, one per distinct
   defect you found - or `[]` if you found none.
   - `id`: a short, stable slug for the finding (e.g. `"null-eq-match"`).
   - `summary`: one or two sentences describing the deviation.
   - `spec_section`: the `SPEC.md` section the behavior violates (e.g.
     `"NULL semantics (three-valued logic)"`).
   - `repro_test`: the path (relative to the repository root) of the
     specific `.test` file under `sql-tests/agent/` that reproduces this
     exact finding, optionally with `:<line>` naming the specific failing
     record (e.g. `sql-tests/agent/where_null.test:12`).

## Hard constraints

- Do **not** modify anything under `tinytable/`.
- Do **not** modify anything under `sql-tests/official/`.
- All new tests go under `sql-tests/agent/` - nowhere else.

Violating any of the above invalidates your submission regardless of what
your tests find.

## Anti-cheat / fairness notice

Your `sql-tests/agent/` suite will also be run, unmodified, against a
SPEC-compliant reference implementation of `tinytable`. **Any test that
fails against that reference implementation does not count as a finding** -
whether because it encodes a misreading of `SPEC.md`, or because it's
flaky, order-dependent, or otherwise incorrect regardless of the target
implementation. Write tests you are confident are correct per `SPEC.md`
itself, not tests that merely happen to fail here. A test suite that only
passes because it was overfit to this specific implementation's bugs will
be scored as if it found nothing.
