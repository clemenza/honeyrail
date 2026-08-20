# evals: "exam room" image for scored dsh-testengineer-trial runs (#105).
#
# Zone 2 of the #104/#105/#106/#109 three-zone eval isolation design: the
# only things a scored trial's agent process can ever see are (a) whatever
# is baked into this image (the runtime - Node, dsh, a non-root user) and
# (b) the seed-root directory the runner bind-mounts at /workspace. Nothing
# from the host - the honeyrail checkout, ~/.honeyrail, examples/tinytable-eval
# (mutants/golden tests/score.py), the operator's home directory - is ever
# mounted in, so there is no path from inside the container back to any
# answer material, regardless of what dsh's own `workspace-write` sandbox
# does or doesn't restrict (see #103: it does not restrict reads).
#
# Build:
#   docker build -t tinytable-exam-room:latest docker/tinytable-exam-room
#
# Run (see scripts/tinytable-exam-room.ts for the real runner - this is
# illustrative, not the exact invocation):
#   docker run --rm --network bridge --cap-drop=ALL --security-opt=no-new-privileges \
#     --pids-limit 256 --memory 2g --tmpfs /tmp:size=256m -e HOME=/tmp \
#     -v /path/to/seed-root:/workspace:rw -w /workspace \
#     -e DEEPSEEK_API_KEY -e DSH_PERMISSION_MODE \
#     tinytable-exam-room:latest dsh --profile headless "<prompt>"

FROM node:24-bookworm-slim

# Pin the exact dsh build docs/dsh-adapter-notes.md's spike verified,
# rather than trust `latest`/`next` dist-tags (the spike found 6 other
# 0.0.1-rc.*/0.1.0-rc.* releases on npm - "expect breakage between
# versions").
ARG DSH_VERSION=0.1.0-rc.7

RUN node -e "if (typeof require('zlib').createZstdDecompress !== 'function') { throw new Error('Node build lacks zlib.createZstdDecompress - dsh will fail to boot, see docs/dsh-adapter-notes.md'); }"

RUN npm install -g "@deepseek-ai/dsh@${DSH_VERSION}"

# dsh 0.1.0-rc.7's composed `headless` profile loads a cordis-plugin-hmr
# entry that throws "--expose-internals is required for HMR service" unless
# the node process itself was launched with that flag - the installed `dsh`
# bin shim (`#!/usr/bin/env node`) does not pass it, and it cannot be set via
# NODE_OPTIONS (node refuses --expose-internals there). Confirmed live in
# this image on both Node 22 and Node 24 - not a Node-version issue, a gap
# in dsh's own launcher. Replace the shim with a wrapper that adds the flag,
# so every caller in this image can keep invoking plain `dsh ...`.
RUN dsh_entry="$(readlink -f /usr/local/bin/dsh)" \
    && rm /usr/local/bin/dsh \
    && printf '#!/bin/sh\nexec node --expose-internals "%s" "$@"\n' "$dsh_entry" > /usr/local/bin/dsh \
    && chmod +x /usr/local/bin/dsh \
    && dsh --version

# Non-root by default; the runner overrides --user to the host uid/gid that
# owns the bind-mounted seed-root so the agent can write sql-tests/agent/
# and findings.json into it (see scripts/tinytable-exam-room.ts). $HOME is
# also overridden per-run (to a tmpfs) since dsh writes its own profile/
# session state under $HOME/.dsh, not under /workspace.
RUN useradd --create-home --uid 10001 --shell /bin/bash examroom
USER examroom
WORKDIR /workspace

ENTRYPOINT []
