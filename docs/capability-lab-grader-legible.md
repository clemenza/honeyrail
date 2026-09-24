# Capability Lab: grader-legible observable and reproducer-output construction

Tracking issue: [#237](https://github.com/clemenza/honeyrail/issues/237). Protocol: [evaluation-report-v1](evaluation-protocol.md).

## The observed gap

Three formal Historical PostgreSQL studies — [#216](https://github.com/clemenza/honeyrail/issues/216)/[#220](https://github.com/clemenza/honeyrail/issues/220), [#222](https://github.com/clemenza/honeyrail/issues/222)/[#224](https://github.com/clemenza/honeyrail/issues/224), [#233](https://github.com/clemenza/honeyrail/issues/233)/[#236](https://github.com/clemenza/honeyrail/issues/236) — showed the same downstream failure shape: a trajectory can reach plausible or precise localization and still submit a reproducer whose discriminating signal is consumed inside the script rather than surfaced as a minimal external observable. Self-asserting procedural blocks, swallowed errors, message text in place of the raw behavior, extra diagnostic output, internal pass/fail branching.

That is three recurrences across two causal families and two grading protocols — not three independent family observations. It is enough to justify a narrowly scoped Capability Lab intervention; it is not enough to claim a general capability law.

The capability under test is the downstream transformation, not PostgreSQL diagnosis:

```text
behavioral hypothesis -> discriminating experiment -> minimal observable
  -> externally machine-checkable reproducer
```

## TRAIN / FRONTIER / HOLDOUT discipline

The exact historical cases are TRAIN evidence for *identifying* the gap only. Nothing here is tuned on `#16867`, `#18574` or `#18118`; their frozen graders are untouched; family-003 and the reserved family-004 are not consumed. Every archetype is a neutral synthetic fixture that preserves the output-shape challenge without reproducing a historical bug, SQL snippet, state name or grader-private tuple.

Transfer validation of the frozen intervention belongs on the separately reserved unseen family-004 path defined by [#229](https://github.com/clemenza/honeyrail/issues/229)/[#230](https://github.com/clemenza/honeyrail/issues/230)/[#232](https://github.com/clemenza/honeyrail/issues/232), after the freeze. [#232](https://github.com/clemenza/honeyrail/issues/232) remains an information-context experiment and must not consume this intervention in C0–C3.

## The TRAIN archetype set

Six archetypes, one per output-shape failure class, in `server/capability/grader-legible-archetypes.ts`. Identities are opaque (`cap-glo-001` … `cap-glo-006`) so the class name — which names the very mistake under test — never reaches the agent.

| Archetype | Failure class | What the reproducer must expose |
|---|---|---|
| `cap-glo-001` | swallowed raw error | the fixture's own raw error line and exit status, unmodified |
| `cap-glo-002` | self-asserting procedural wrapper | the raw value, not a computed verdict |
| `cap-glo-003` | extra diagnostic rows/output | the signal alone, with no surrounding dump |
| `cap-glo-004` | wrong observable channel | the channel that discriminates, not the one that always speaks |
| `cap-glo-005` | overfit internal branching | both raw sides, leaving the comparison to the external observer |
| `cap-glo-006` | nondeterministic / multi-row shape | a deterministic projection of an unstably ordered result |

Each archetype carries a grader-private expected observation contract and at least one bad-but-plausible self-asserting solution shape. The bad shapes exist so CI can prove the grader distinguishes them; they are never materialized into an agent workspace.

Each fixture is a small deterministic POSIX-sh program with no network and no external dependencies, so the whole set runs in seconds with no Docker, no PostgreSQL and no model.

## Task surface and grading

Materialization (`grader-legible-fixture.ts`) splits agent-visible from operator-side material:

```text
<root>/
  archetype-manifest.json   operator-side identity + hashes (never truth)
  bin/<fixtureCommand>      the synthetic system under test (host-side only)
  facade-bin/<fixtureCommand>  the generic facade client the agent gets on PATH
  state/                    grader-owned fixture state (invocations.log, counters)
  workspace/                the agent-visible workspace
    BRIEF.md
    SUBMISSION-CONTRACT.md
    INTERVENTION.md         candidate condition only
  runs/<index>/             raw stdout.txt, stderr.txt, exit-status.txt per execution
  attempt.json              retained attempt record
```

This layout describes the split; it does not enforce it. A working directory is not a filesystem boundary, so how real the separation is depends entirely on where the agent runs:

- **Isolated (`HONEYRAIL_CAP_GLO_AGENT_IMAGE` set).** `grader-legible-container.ts` runs the agent in a Docker container built from the shared `containerHardeningArgs()` primitive, with exactly three bind mounts: `workspace/` read-write at `/workspace`, `facade-bin/` read-only at `/workspace/bin`, and the attempt's request/response channel read-write at `/workspace/.facade`. The real `bin/` is **not** mounted. Read-only prevents writing, not reading, and the fixture's source is the discriminating truth the task exists to make the agent discover by experiment — `cat "$(command -v meter)"` would end the task. Instead the agent's PATH entry is the generic facade client from `grader-legible-facade.ts`, byte-identical for every archetype; the fixture runs on the host and is reached over a polled file channel. `archetype-manifest.json`, `state/`, `runs/` and the sibling condition's tree are absent from the container's mount namespace entirely. Two Docker-gated tests probe for all of them from inside a container, using the same PATH the agent has, rather than asserting on the argv the harness itself built; they skip, never pull, when the daemon or the stub image is missing.
- **Unisolated (no image).** The agent runs on the host with `workspace/` as its cwd and the real `bin/` on its PATH. `bin/`, `state/` and the manifest are one `..` away. This mode is for operator smoke tests; a run made this way is not capability evidence and the report says so.

The agent writes one file, `workspace/reproducer.sh`. The harness executes it with `/bin/sh` twice, in fresh scratch directories sharing one fixture state directory, with a constructed (not inherited) environment. Raw stdout, stderr and exit status are captured outside the agent and retained before grading.

`grader-legible-grader.ts` then compares those raw channels against the private observation contract. It never parses the submitted script, never reads prose, and never honours an agent-asserted verdict: a self-asserting submission fails because the raw differential is absent from every channel, not because the grader pattern-matched the word "PASS". The expected observation is never written to disk — `archetype-manifest.json` records only its hash — and grader diagnostics do not echo expected values.

### Outcomes and attribution

`completed` is the only status that carries a capability outcome. `invalid_submission`, `integrity_error` and `infrastructure_error` are retained separately, so retry and infrastructure failures never read as capability misses.

Every attempt also carries a `primaryCause` in [evaluation-report-v1](evaluation-protocol.md) vocabulary — `agent_budget_exhausted`, `agent_invalid_submission`, `agent_resource_limit`, `external_block`, `harness_or_evaluator`, `infrastructure`, `isolation_or_integrity`, `unknown` — plus two values for attempts that reached a grade and therefore sit outside the protocol's failure vocabulary: `completed_success` and `completed_capability_miss`. Status alone cannot carry this. An agent that exhausted its budget and an agent that simply wrote nothing both end with no submission on disk, and only the cause distinguishes them. `causeCounts` sums to `A`.

Within a completed attempt, failure-stage attribution runs in this order, which is what lets a paired comparison say *where* improvement happened:

1. `no_discriminating_experiment` — the fixture's own invocation log shows the discriminating experiment never ran; the miss is upstream of output-shape construction.
2. `nondeterministic_output` — repeated executions disagreed.
3. `exit_status_mismatch`, `stdout_shape_mismatch`, `stderr_signal_missing` — the experiment ran and the observable was encoded badly.

Secondary diagnostics (discriminating-observable selection, determinism, per-channel matches, submission bytes, fixture invocation count) are reported, never graded.

Primary endpoint: **end-to-end budget success (`D/A`)** — grader-legible successes over *every formal attempt*, reported per condition. Conditional rediscovery (`D/E`, successes over completed attempts) is reported beside it and never alone: it excludes everything that failed before grading, so an agent that times out nine times in ten and succeeds on the tenth scores `1.0` on it. The CLI prints `D/A` first for that reason.

## The intervention

`server/capability/grader-legible-intervention.ts` holds one methodology card plus its content hash. It is not a framework, a profile system or a prompt optimizer. It states reusable principles only — external observer owns pass/fail, expose the smallest raw differential, do not catch or translate the target signal, pick the channel that discriminates, stabilize cardinality/order/format, separate exploration from the final artifact, validate against the declared contract rather than hidden truth. A test asserts it mentions no PostgreSQL, case, family or fixture-specific term.

The baseline condition is the empty intervention, so paired conditions differ in exactly one materialized file. `runGraderLegiblePairedExperiment()` records each attempt's as-presented task-surface hash and refuses to report a comparison when the two conditions diverge anywhere but `INTERVENTION.md`.

## Running it

```sh
# Unit + integration tests (no Docker, no PostgreSQL, no model)
npm run test:capability-glo-237

# Paired baseline-vs-candidate run.
# Default provider is scripted: harness validation, NOT capability evidence.
HONEYRAIL_CAP_GLO_EXPERIMENT_ID=<id> \
HONEYRAIL_CAP_GLO_ARTIFACT_DIR=output/capability-grader-legible/<id> \
  npm run capability-glo-237

# Real-agent run. Capability evidence requires all three of: a command
# provider, an isolation image, and a declared identity.
HONEYRAIL_CAP_GLO_PROVIDER=command \
HONEYRAIL_CAP_GLO_AGENT_COMMAND=<agent> \
HONEYRAIL_CAP_GLO_AGENT_ARGS='["--flag","value"]' \
HONEYRAIL_CAP_GLO_AGENT_TIMEOUT_MS=600000 \
HONEYRAIL_CAP_GLO_AGENT_IMAGE=<image already present locally> \
HONEYRAIL_CAP_GLO_AGENT_NETWORK=none \
HONEYRAIL_CAP_GLO_AGENT_IDENTITY='{"model":"...","agentName":"...","agentVersion":"...","commandIdentity":"...","repositoryCommit":"..."}' \
  npm run capability-glo-237

# Freeze the candidate intervention before any family-004 transfer validation
npm run capability-glo-237-freeze
```

`HONEYRAIL_CAP_GLO_AGENT_IMAGE` must already exist locally. Before the first attempt runs, `runGraderLegiblePairedExperiment()` resolves it through the shared `resolveImageIdentity()` and aborts the whole experiment if it is absent; it never pulls, because which image the agent ran in is part of the evidence and therefore the operator's to place.

A capability outcome stands on a chain of three separately established links — the image resolved, container isolation established, agent execution established — and only then the agent's own outcome. They are checked separately because each boundary is a place where a harness failure looks exactly like an agent failure on disk.

Resolving the image is not establishing isolation. An image can exist and `docker run` still fail before any container is created — an undefined network, a daemon fault — and that failure is indistinguishable from an agent that ran and submitted nothing. So each attempt proves its own container: an in-container wrapper touches a marker file in the bind-mounted facade channel before it looks for the agent at all, and the host reads it back as `telemetry.isolationEstablished`.

Establishing isolation is not establishing that the agent ran. The wrapper can start, write that marker and still fail to `exec` the configured command — not found, or present but not executable — exiting nonzero with no timeout and no spawn error the host can see, which again looks like an agent that submitted nothing. So the wrapper writes a second marker only once the command resolves, immediately before `exec`ing it, read back as `telemetry.agentExecutionEstablished`. The resolvability check is `command -v`: it proves the program was found and executable, not that `exec` could not fail for some other reason (a corrupt binary, a missing shared library), which is the smallest reliable check that does not put a process supervisor inside the container.

An attempt whose container never started is attributed `isolation_or_integrity` / `infrastructure_error`; one whose agent never launched is `infrastructure` / `infrastructure_error`. Neither is ever `agent_invalid_submission`. An agent that *did* launch keeps its own attribution unchanged: a timeout is `agent_resource_limit`, and having run and written nothing usable is `agent_invalid_submission`.

Reading the image's declared ENTRYPOINT also fails closed, for the same reason. The wrapper takes the `--entrypoint` slot and so must re-exec whatever the image declared; an inspect or parse that failed used to be indistinguishable from an image that declared none, which would silently run `command` as its own program — a different agent than the operator configured, reported as the configured one. Only a genuinely absent entrypoint is empty now; anything unreadable fails that attempt as infrastructure with no container started at all.

`HONEYRAIL_CAP_GLO_AGENT_IDENTITY` is recorded into the report as `realAgentIdentity`, including the isolation policy actually applied, the budgets actually enforced, and — for an isolated run — the `imageReference` requested, the content-addressed `resolvedImageId` it resolved to, and the `network` policy applied. The tag alone would not identify the agent, since a rebuild can move it. `commandIdentity` is stored as a basename only, and the provider environment is never copied into the report — a run's credentials are not part of who the agent was, and retained evidence travels further than the host does.

`capabilityEvidenceEligible` is `true` only when a command provider carried a declared identity, requested isolation, resolved its image, and no attempt's container failed to start. A scripted run is always `false`; so is a bare command provider, which was equally true of a provider pointed at `/bin/false` with no isolation and no attribution. Per the [evaluation protocol](evaluation-protocol.md#evidence-levels-and-claims), a scripted agent validates the instrument and says nothing about model capability.

Reruns fail closed, with no exception. `runGraderLegiblePairedExperiment()` refuses an artifact root that holds *any* entry — including one written by an identical earlier run of the same experiment id — before it creates the root, materializes anything, or invokes the provider. Nothing under a used root is ever deleted or rewritten. A retry means a fresh root and a new experiment id; the CLI's default root is per-experiment for exactly this reason. (This does not constrain `npm run capability-glo-237-freeze`, which writes to `corpus/`, a different path with its own refuse-on-drift check.)

## Freeze and transfer

`npm run capability-glo-237-freeze` writes `corpus/capability-grader-legible-intervention-v1.json`: the intervention id, body and hash, plus the archetype set hash and per-archetype hashes. It is idempotent and refuses to overwrite a differing freeze. A later unseen-family run re-derives the hash with `assertFrozenGraderLegibleIntervention()` and refuses a body that has drifted, so "validated the frozen intervention" cannot quietly become "validated a tweaked one".

## Limitations

- The archetypes are synthetic. They reproduce the output-shape challenge, not real subsystem complexity; success here is not evidence of Historical PostgreSQL capability.
- The gap evidence is three recurrences across two causal families, one of them a within-family sibling replication.
- Harness validation with scripted shapes demonstrates that the instrument separates self-asserting from grader-legible output. It is not a measurement of whether the intervention helps a model; that requires a real-agent paired run under a registered plan.
- Six archetypes is a small, non-probabilistic sample. Counts, not rates with confidence claims, until repetitions are predeclared.
- Isolation is opt-in and Docker-only. Without an image the agent runs on the host, where the harness's private material is one `..` away; such a run is excluded from capability evidence rather than silently reported as isolated.
