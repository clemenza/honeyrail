# Derived research-agent image for the #184 real-agent vertical slice.
#
# docker/postgres-research/Dockerfile deliberately ships no agent CLI - "which
# agent runs is the driver's choice" - and asks derived images to add one
# rather than growing the base. This adds exactly one: mini-agent.mjs, a
# small driver that makes genuine calls to an OpenAI-compatible chat
# completions API (no scripted/known-answer path) and drives psql through a
# run_shell tool. Everything else about the container boundary (mounts,
# non-root user, no baked network access) is unchanged from the base image.
#
# Build:
#   docker build -t honeyrail-postgres-research-184-agent:latest docker/postgres-research-agent-184
FROM honeyrail-postgres-research:latest

COPY --chown=pgresearch:pgresearch mini-agent.mjs finding-validation.mjs /opt/agent/
