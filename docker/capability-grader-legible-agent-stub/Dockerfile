# Test-only stub agent for the #237 grader-legible Capability Lab isolation path.
#
# This is not an agent. It is a deterministic shell program that stands in for
# one, so the isolation contract in server/capability/grader-legible-container.ts
# can be tested for what it actually claims rather than for what its flags say.
# A real agent's behavior is model-dependent and therefore useless as an
# assertion: "the model did not read ../bin/fixture this time" proves nothing
# about whether it could.
#
# The stub does two things on every run, and records both:
#
#   1. Solves the task honestly - invokes the fixture that is on PATH and
#      writes a reproducer.sh that projects its output. This proves the mounted
#      surface is sufficient: an agent confined this way can still do the work,
#      so a capability miss under isolation is a real miss and not a harness
#      that starved the agent of the task.
#
#   2. Probes the surface from inside and writes what it found to
#      probe-results.json, path-entry-source.txt and facade-listing.txt in the
#      workspace. The test asserts that the harness's private material - the
#      real bin/ holding the fixture source, state/, archetype-manifest.json
#      and runs/ - is unreachable by every spelling, and that the PATH entry
#      the agent *can* read is the generic facade client and carries none of
#      the archetype's discriminating values. Probing from inside is the only
#      check that means anything: the alternative is asserting on the docker
#      argv we ourselves built, which would pass just as happily if the mount
#      semantics were wrong.
#
# The fixture is not in this container at all. It runs on the host, reached
# over the request/response channel bind-mounted at /workspace/.facade, so the
# image needs `base64` and `sed` on PATH for the facade client - both are in
# any Debian-derived base, including the one below.
#
# It is never pulled and never used by a scored run. Tests that need it check
# `docker image inspect` and skip when it is absent, matching this repo's
# no-implicit-pull rule.
#
# The base matches docker/postgres-research: bookworm, with a Node runtime
# present so this image can stand in for the shape of a real agent image
# without the test depending on a second base.
#
# Build (both tags; the second is needed by the launch-attribution tests):
#   docker build -t honeyrail-cap-glo-agent-stub:latest docker/capability-grader-legible-agent-stub
#   docker build --target no-entrypoint -t honeyrail-cap-glo-no-entrypoint-stub:latest \
#     docker/capability-grader-legible-agent-stub

FROM node:24-bookworm-slim AS base

# The stub is baked in rather than bind-mounted. A mounted stub would be a
# fourth mount, and the thing under test is precisely which mounts exist.
COPY stub-agent.sh /usr/local/bin/stub-agent
RUN chmod 0755 /usr/local/bin/stub-agent

# A second tag that declares no entrypoint, so `provider.command` is the program
# actually exec'd rather than an argument to one. The isolated runner's wrapper
# checks the program it is about to exec, which with an ENTRYPOINT is the
# entrypoint - correct, but it leaves no way to test a *provider command* that
# does not exist. This stage gives the tests an image where the provider command
# is the exec target: pointed at a nonexistent path it proves the container
# started and the agent did not launch; pointed at /bin/true it proves an agent
# that did launch and submitted nothing is still the agent's own outcome;
# pointed at /bin/sleep it proves a timeout is a resource limit. `node:24`
# declares ENTRYPOINT ["docker-entrypoint.sh"], so clearing it is the point.
FROM base AS no-entrypoint
ENTRYPOINT []

# Last, so the plain `docker build` above still produces the stub agent.
#
# containerHardeningArgs() runs the container --read-only with a non-root
# --user, so nothing here may assume a writable image filesystem or a home
# directory; the stub writes only into /workspace and /tmp.
FROM base AS stub
ENTRYPOINT ["/usr/local/bin/stub-agent"]
