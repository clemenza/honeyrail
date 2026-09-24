#!/bin/sh
# Deterministic stand-in for a real agent. See this directory's Dockerfile.
#
# Usage: stub-agent <fixture-command> [fixture-args...]
#
# The invocation is supplied in full by the caller, and the test supplies the
# archetype's real public discriminating invocation (for cap-glo-002:
# `stub-agent meter read adjusted`). The stub never guesses it and never reads
# a reference solution: a stub that knew the answer independently of the
# fixture would pass this test even if the mounted surface were useless.
#
# Runs in the container with cwd=/workspace.
set -u

fixture="${1:?stub-agent requires the fixture command name}"
shift

# 1. Solve the task, using only the surface a confined agent actually has: the
#    PATH entry at /workspace/bin, which is the generic facade client. If the
#    facade did not work, this produces nothing and the run is a capability
#    miss rather than a silent pass.
"$fixture" "$@" >/tmp/fixture-stdout.txt 2>/tmp/fixture-stderr.txt
fixture_status=$?

# The reproducer is derived from this process's own argv and nothing else.
{
  printf '#!/bin/sh\n'
  printf '# Submitted by the #237 stub agent.\n'
  printf 'exec %s' "$fixture"
  for arg in "$@"; do
    printf " '%s'" "$arg"
  done
  printf '\n'
} >reproducer.sh

# 2. Probe the surface from inside, which is the only check that means
#    anything: asserting on the docker argv we built ourselves would pass just
#    as happily if the mount semantics were wrong.
probe() {
  if [ -r "$1" ] && [ -s "$1" ] && cat "$1" >/dev/null 2>&1; then
    printf 'readable'
  else
    printf 'absent'
  fi
}

probe_dir() {
  if ls "$1" >/dev/null 2>&1; then printf 'readable'; else printf 'absent'; fi
}

# What the agent finds on PATH. Readable by design - it is the facade client,
# byte-identical for every archetype. The test asserts that this exact text
# carries none of the archetype's private discriminating values.
path_entry=$(command -v "$fixture" || printf '')
if [ -n "$path_entry" ] && [ -r "$path_entry" ]; then
  cp "$path_entry" path-entry-source.txt
  path_entry_readable=readable
else
  : >path-entry-source.txt
  path_entry_readable=absent
fi

# The channel itself. Request/response files only; never fixture source.
ls -a "${HONEYRAIL_FACADE_DIR:-/workspace/.facade}" >facade-listing.txt 2>&1 || printf 'unlistable\n' >facade-listing.txt

# Every spelling of the harness's private material an agent could try from
# here. `..` from /workspace is the container root, so these are also the
# absolute paths; they are listed separately because a future mount mistake
# would show up in exactly one of them. The harness's `bin/` is probed only
# through the fixture name: the container root has its own `/bin`, so a bare
# directory probe there would report the image rather than a leak.
fixture_source=$(probe "../bin/$fixture")
fixture_source_abs=$(probe "/bin/$fixture")
manifest=$(probe "../archetype-manifest.json")
manifest_abs=$(probe "/archetype-manifest.json")
state_log=$(probe "../state/invocations.log")
state_dir=$(probe_dir "../state")
runs_dir=$(probe_dir "../runs")

cat >probe-results.json <<EOF
{
  "fixtureExitStatus": $fixture_status,
  "pathEntry": "$path_entry",
  "pathEntryReadable": "$path_entry_readable",
  "fixtureSource": "$fixture_source",
  "fixtureSourceAbsolute": "$fixture_source_abs",
  "archetypeManifest": "$manifest",
  "archetypeManifestAbsolute": "$manifest_abs",
  "graderStateLog": "$state_log",
  "graderStateDir": "$state_dir",
  "graderRunsDir": "$runs_dir"
}
EOF

exit 0
