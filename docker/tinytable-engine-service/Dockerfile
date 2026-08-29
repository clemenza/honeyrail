# evals: "engine-service" image for clemenza/honeyrail#168's oracle-container
# black-box eval mode.
#
# #158's `.pyc`-hiding MVP turned out not to be a real black-box boundary
# (#164: the agent imported the live `.pyc` and `dis.dis()`'d it straight
# to the correct defect - hiding source as a *file format* inside the
# agent's own process doesn't stop it introspecting anything importable).
# #166 concluded a real black box needs a process boundary. This image is
# that boundary's server side: it runs vendor/tinytable-evals's
# engine_service.py, which owns the real (possibly mutated) `tinytable`
# package and exposes only a narrow HTTP interface - no module object, no
# source, no bytecode, ever crosses it. See engine_service.py's own module
# docstring for the exact wire contract, and scripts/tinytable-engine-
# service.ts for how this image is actually launched (private Docker
# network, health check, cleanup) alongside #105's exam-room.
#
# Unlike docker/tinytable-exam-room/Dockerfile, this image DOES bake in
# repository content at build time - but deliberately only the four
# generic run_sql_tests.py support modules (admissibility/scheduler/
# substrate/trajectory) plus run_sql_tests.py and engine_service.py
# themselves. None of these contain mutant-specific or answer-revealing
# material - build_seed_root.py already ships all five of the non-
# engine_service.py files into every seed-root today, visible to the
# agent in every existing mode (source/bytecode). The one thing this image
# never bakes in is `tinytable/` itself (the real, possibly mutated
# engine) - that arrives only via a read-only bind mount at container run
# time (see scripts/tinytable-engine-service.ts), so no answer material
# ever sits in a built image layer.
#
# Build (context is the honeyrail repo root, not this directory, since it
# needs to reach vendor/tinytable-evals - unlike tinytable-exam-room's
# image, which bakes in no repo content at all):
#   docker build -f docker/tinytable-engine-service/Dockerfile \
#     -t tinytable-engine-service:latest .
#
# Run (see scripts/tinytable-engine-service.ts for the real runner - this
# is illustrative, not the exact invocation):
#   docker run --rm --network <private-network> --network-alias engine-service \
#     --cap-drop=ALL --security-opt=no-new-privileges --pids-limit 256 \
#     --memory 1g --read-only --tmpfs /tmp:size=64m \
#     -v /path/to/privateRoot/tinytable:/mutant/tinytable:ro \
#     tinytable-engine-service:latest \
#     python3 engine_service.py --root /mutant --host 0.0.0.0 --port 8765

FROM python:3.11-slim-bookworm

RUN useradd --create-home --uid 10002 --shell /usr/sbin/nologin engineservice
WORKDIR /app

# stdlib only (see engine_service.py's own module docstring) - nothing to
# pip install.
COPY vendor/tinytable-evals/engine_service.py \
     vendor/tinytable-evals/run_sql_tests.py \
     vendor/tinytable-evals/admissibility.py \
     vendor/tinytable-evals/scheduler.py \
     vendor/tinytable-evals/substrate.py \
     vendor/tinytable-evals/trajectory.py \
     /app/

USER engineservice

# No EXPOSE/default CMD: the runner always passes an explicit --host/--port
# (see scripts/tinytable-engine-service.ts) and the mutant's mount point is
# chosen by the caller, not baked in here.
ENTRYPOINT ["python3", "/app/engine_service.py"]
