# tinytable test-engineering task

You are a senior test engineer. Your target is this repository's
`tinytable` package (`tinytable/`) - a small SQL engine whose complete,
sole-arbiter behavioral contract is `SPEC.md` in this same directory. Read
`SPEC.md` before writing anything.

## Context

`tests/test_official.py` already exists and passes against this
`tinytable`. That does **not** mean the implementation is correct: it may
still deviate from `SPEC.md` in ways the official suite doesn't happen to
exercise. Your job is to find any such deviation, if one exists, and prove
it with a failing test - not to extend or duplicate the official suite.

## What to do

1. Read `SPEC.md` in full, then read `tinytable/`'s source.
2. Look for behavior that deviates from `SPEC.md`.
3. Write pytest tests under `tests/agent/` (you may add multiple files)
   that pin down the *correct*, SPEC-compliant behavior for anything you
   suspect is wrong - each test should fail against this `tinytable` if,
   and only if, the behavior it checks is actually wrong per `SPEC.md`.
4. Write `findings.json` at the repository root (schema:
   `findings.schema.json`): a JSON array of
   `{id, summary, spec_section, repro_test}` objects, one per distinct
   defect you found - or `[]` if you found none.
   - `id`: a short, stable slug for the finding (e.g. `"null-eq-match"`).
   - `summary`: one or two sentences describing the deviation.
   - `spec_section`: the `SPEC.md` section the behavior violates (e.g.
     `"NULL semantics (three-valued logic)"`).
   - `repro_test`: the pytest node id of the specific test under
     `tests/agent/` that reproduces this exact finding (e.g.
     `tests/agent/test_where.py::test_eq_excludes_null`).

## Hard constraints

- Do **not** modify anything under `tinytable/`.
- Do **not** modify `tests/test_official.py`.
- All new tests go under `tests/agent/` - nowhere else.

Violating any of the above invalidates your submission regardless of what
your tests find.

## Anti-cheat / fairness notice

Your `tests/agent/` suite will also be run, unmodified, against a
SPEC-compliant reference implementation of `tinytable`. **Any test that
fails against that reference implementation does not count as a finding** -
whether because it encodes a misreading of `SPEC.md`, or because it's
flaky, order-dependent, or otherwise incorrect regardless of the target
implementation. Write tests you are confident are correct per `SPEC.md`
itself, not tests that merely happen to fail here. A test suite that only
passes because it was overfit to this specific implementation's bugs will
be scored as if it found nothing.
