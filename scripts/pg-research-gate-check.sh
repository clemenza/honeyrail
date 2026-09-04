#!/usr/bin/env bash
# Fails if any given `node --test` log reports itself skipped.
#
# Extracted out of .github/workflows/pg-research-integration.yml's "Fail if
# any required test skipped" step (#197 round 2 review) so the exact same
# logic is what the real merge gate runs *and* what
# test/pg-research-integration-gate.test.ts exercises against fixture logs -
# the two cannot drift apart the way an inline YAML step and a hand-copied
# test double would.
#
# `node --test`'s TAP-ish summary reports a skipped count; anything above
# zero here means a required test did not actually run, which is a failure
# and not a pass (#182 fourth review: "a required validation that skips is a
# failure").
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <log-file> [<log-file> ...]" >&2
  exit 2
fi

status=0
for log in "$@"; do
  if [ ! -f "$log" ]; then
    echo "$log: missing" >&2
    status=1
    continue
  fi
  # `node --test`'s summary line is "<glyph> skipped <n>"; take the last
  # field of the last such line so the glyph's encoding is irrelevant. An
  # unparseable summary counts as a failure, not as a zero - and the
  # trailing `|| true` matters under `set -e`: a log with no matching line at
  # all makes `grep` exit 1, which pipefail would otherwise propagate straight
  # out of this assignment and abort the script before it ever prints the
  # diagnostic below (still a non-zero exit either way, but a silent one).
  skipped=$( (grep -E 'skipped [0-9]+$' "$log" | tail -1 | awk '{print $NF}') || true)
  echo "$log: skipped=${skipped:-unparseable}"
  if [ "${skipped:-1}" != "0" ]; then
    echo "::error file=$log::a required PostgreSQL research test skipped; a skip is not a pass"
    grep -nE '^.\s' "$log" | grep -i 'skip' || true
    status=1
  fi
done
exit $status
