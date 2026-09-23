#!/bin/sh
# Deterministic stand-in for a real agent. See this directory's Dockerfile.
#
# Usage: stub-agent <fixture-command> [fixture-args...]
#
# Runs in the container with cwd=/workspace. Every path probed below is spelled
# exactly the way an unisolated agent would reach the harness's private material
# from its own cwd - one `..` - which is the reachability this image exists to
# test for absence.
set -u

fixture="${1:?stub-agent requires the fixture command name}"
shift

# 1. Solve the task. The fixture is on PATH via /workspace/bin, and
#    HONEYRAIL_FIXTURE_STATE points at the investigation state directory the
#    harness created inside the workspace.
"$fixture" "$@" >/tmp/fixture-stdout.txt 2>/tmp/fixture-stderr.txt
fixture_status=$?

cat >reproducer.sh <<EOF
#!/bin/sh
# Submitted by the #237 stub agent.
$fixture $* 2>&1 | sort
EOF

# 2. Probe for the three things that must not be reachable. Each probe records
#    "readable" only if the read actually succeeded and produced bytes.
probe() {
  if [ -r "$1" ] && [ -s "$1" ] && cat "$1" >/dev/null 2>&1; then
    printf 'readable'
  else
    printf 'absent'
  fi
}

fixture_source=$(probe "../bin/$fixture")
manifest=$(probe "../archetype-manifest.json")
state_log=$(probe "../state/invocations.log")
# A directory listing is a weaker read but still a leak, so it is probed
# separately: `cat` on a directory fails even when the directory is mounted.
if ls ../state >/dev/null 2>&1; then state_dir=readable; else state_dir=absent; fi

cat >probe-results.json <<EOF
{
  "fixtureExitStatus": $fixture_status,
  "fixtureSource": "$fixture_source",
  "archetypeManifest": "$manifest",
  "graderStateLog": "$state_log",
  "graderStateDir": "$state_dir"
}
EOF

exit 0
