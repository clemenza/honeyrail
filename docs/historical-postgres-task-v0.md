# Historical PostgreSQL task v0

Issue #184 adds one local task contract for a historical PostgreSQL correctness regression. It uses the existing PostgreSQL research environment; it does not introduce another executor or orchestration layer.

## Layout and boundary

```text
case/
  task/
    source/                 # historical snapshot, no .git
    prompt.md
    task-manifest.json       # agent-visible: opaque id, hashes, execution settings only
    source-manifest.json     # agent-visible: sanitized {schemaVersion, sourceHash, gitDirPresent}
    workspace/               # agent-owned finding and repro files
  reference/                 # grader-owned only, never mounted into an agent
    reference-manifest.json  # protocol-level metadata (no revisions, no bug identity)
    truth.json                # the one place the bug identity and both revisions live
    source-manifest.json     # full PostgresSourceManifest: repoPath, ref, resolvedCommit, sourceDir
    expected-behavior/
      fix-evidence            # operator-supplied (truth.knownFixEvidencePath)
      fix-evidence.diff       # auto-generated git diff, when an oracle is declared and no override was supplied
    verification/
      canonical-reproducer.sql # retained only when truth.knownReproducerPath was supplied
```

The agent receives the historical source, prompt, live local instance, and writable workspace. It does not receive the reference bundle, the corrected source, either pinned revision, the original bug identity, a canonical reproducer, a local filesystem path, or anything else under `reference/`.

`task-manifest.json` is schema version 1. It carries only the opaque `taskId`, `database`/`taskType`, scaffolding/budget/build-profile settings, and SHA-256 hashes (`sourceTree`, `prompt`, `taskDefinition`, `truthBundle`) - no revision strings and no bug identity. `task/source-manifest.json` is likewise sanitized: `materializePostgresSource()` returns a full `PostgresSourceManifest` (`repoPath`, `ref`, `resolvedCommit`, `sourceDir`, `sourceHash`, `gitDirPresent`) which directly names the historical revision and a local grader-only mirror path, so only `{schemaVersion, sourceHash, gitDirPresent}` is written into `task/`; the full manifest is retained at `reference/source-manifest.json` instead. `reference-manifest.json` is grader-private protocol metadata (grading protocol, `taskDefinitionHash`, and a pointer hash to the truth bundle) and likewise carries no revisions or bug identity. `reference/truth.json` is the one artifact that records the original bug identity (`upstreamBug`, `commitFest`), both pinned revisions (`historicalRevision`, `referenceRevision`), and - when a canonical verification reproducer was supplied - the reproducer itself, physically retained at `reference/verification/canonical-reproducer.sql` (never the original host path), plus its grader-private relative path (`canonicalReproducer`) and SHA-256 (`canonicalReproducerSha256`); provenance only, the grader never executes it as part of grading. When no canonical reproducer was supplied, both `canonicalReproducer` and `canonicalReproducerSha256` are `null` and no file is created. Its `bundleHash` is computed over all of those fields plus a hash of the `expected-behavior`/`verification` material (so the retained reproducer file itself also moves the bundle hash), and is computed before `truth.json` is written, so the bundle's own hash is real provenance rather than a hash of unrelated shape metadata or of itself; `test/historical-postgres-task.test.ts` proves this by re-materializing the bundle with each field changed in turn and asserting the hash actually moves, not by comparing a fabricated tampered copy.

A dedicated test (`"no file anywhere under task/ leaks..."`) walks the entire `task/` tree recursively and asserts no file's text contains either revision, the upstream bug id, the CommitFest id, the local mirror path, the canonical reproducer's contents, relative path, or hash, or the canonical reproducer's original host path - so a future field added to any file under `task/` is covered automatically, not just `task-manifest.json`.

Three local cases exist. The first has the opaque id `postgres-historical-001` (`historicalPostgres001TaskSpec()`, #184); its truth bundle records the real upstream bug and both pinned revisions, but neither this document nor any agent-visible artifact does. The second has the opaque id `postgres-historical-002` (`historicalPostgres002TaskSpec()`, #200 - Bug 2 of the corpus tracked in #185); it follows the identical boundary and grading contract. Its descriptive corpus slot id, `pg-hist-plpgsql-call-stale-plan-002`, names PL/pgSQL, `CALL`, and "stale plan" outright, so it is used only in source comments and this document for administrative traceability back to #185 - it is never the agent-visible `taskId`, never written into `task-manifest.json`, and never reaches `HONEYRAIL_TASK_ID`. Its upstream bug was reported directly to pgsql-bugs rather than submitted through a CommitFest, so it has no CommitFest identity at all: `HistoricalPostgresTaskSpec.truth.commitFest` is optional, and `reference/truth.json` records `commitFest: null` rather than a fabricated number whenever a case has none. Every other truth field (`upstreamBug`, both revisions, the canonical-reproducer provenance) is still recorded and still covered by `bundleHash` exactly as before; `commitFest`'s presence or absence is just one more fact the hash covers, not a hole in it. The third has the opaque id `postgres-historical-003` (`historicalPostgres003TaskSpec()`, #199 - Bug 3 of the corpus tracked in #185). Like case 002, its upstream bug was reported directly to pgsql-bugs with no CommitFest identity. Unlike case 002 (which uses a behavioral/regex oracle on captured stderr), case 003 uses the new **structured-output oracle** (`grading-protocol: "submitted-reproducer-structured-oracle-v1"`, see "Structured-output oracle" below): the grader compares the submitted reproducer's own captured stdout (tuples-only, already guaranteed by `psqlArgs()` in `runtime.ts`) against an exact set of declared tuples, per revision. Its descriptive corpus slot id, `pg-hist-xact-chain-savepoint-003`, names the transaction-chain and savepoint mechanism directly, so it is used only in source comments and this document - never the agent-visible `taskId`. The specific failure mechanism and expected tuples are operator-supplied at runtime via `loadHistoricalPostgres003PrivateTruth()` / `HONEYRAIL_PG_199_PRIVATE_TRUTH` and are grader-private (`reference/truth.json`'s `structuredOracle` field); they are never committed to the repository.

**Evaluation-partition note for case 003.** Because the real answer material (upstream bug id, both pinned revisions, and the expected oracle tuples) was previously committed to the public PR history of this repository (PR #204) before the corrected operator-supplied private-truth path was established, this specific case should be treated as a **historical/frontier regression case, not a pristine HOLDOUT case**, for strict evaluation-partition purposes. The framework's ability to materialize and grade a real third bug via the structured-output oracle is still valid evidence; the evaluation-partition status of the specific case is simply narrowed by its history. Future true-HOLDOUT cases must use the corrected operator-supplied private-truth path (via `HONEYRAIL_PG_199_PRIVATE_TRUTH` / `loadHistoricalPostgres003PrivateTruth()`) from the start, so no real answer material is ever committed to the public repository.

**Case 001 backward compatibility (Policy A).** `truth.behavioralOracle` and `truth.knownFixEvidencePath`/auto-generated fix evidence are both brand-new, optional additions: for a spec that declares neither (case 001, and any synthetic/unit-test spec that doesn't opt in), **both** the `behavioralOracle` key and the `fixEvidence`/`fixEvidenceSha256` keys are omitted from the serialized truth bundle entirely - not written as `null` - so case 001's serialized bytes, and therefore its hashes, are unaffected by either field's existence. (An earlier round added `behavioralOracle` unconditionally as `null` and a later round added `fixEvidence`/`fixEvidenceSha256` the same way, on the mistaken reasoning that "brand new to this PR" meant "safe to add unconditionally" - it doesn't: a legacy spec never had either key before either field existed, so unconditional `null` still moves its hash for zero behavioral reason. Both have been corrected to the same conditional-omission treatment.) `test/historical-postgres-002-task.test.ts`'s `"postgres-historical-001 still materializes and hashes under the widened truth schema"` test proves both keys are genuinely absent, not merely null, and its `"Policy A: a legacy truth bundle ... is byte-for-byte identical to the pristine pre-#200 schema"` test goes further: it reconstructs the exact pre-#200 (commit `7815901`) `truthShape` key set and values literally and proves the current legacy-path bundle - and its `bundleHash`, independently re-derived with the same canonicalize+sha256 algorithm - matches it exactly, not merely "looks the same shape".

`truth.knownFixEvidencePath` is an operator override: a private host path (never committed, same discipline as `knownReproducerPath`) to grader-private fix/reference evidence - notes on the upstream fix, a diff, release-note excerpts, whatever an operator has. When supplied, it's copied byte-identical to `reference/expected-behavior/fix-evidence` (a fixed name, regardless of the source file's own name) and hashed (`fixEvidence`/`fixEvidenceSha256` in the truth bundle, covered by `expectedBehaviorSha256`/`bundleHash`). It is never read by the grader during scoring - purely provenance.

**Auto-generated fix evidence.** When no override is supplied and the task declares `truth.behavioralOracle`, `materializeHistoricalPostgresTask()` generates real evidence itself: a `git diff` between `historicalRevision` and `referenceRevision` in `repoPath` - the local mirror this task type already requires makes this available for free, so a real historical task never depends on a manually maintained extra private file. The diff is written to `reference/expected-behavior/fix-evidence.diff` and hashed the same way. Generation failure is loud: if `referenceRevision` can't actually be diffed against `historicalRevision` in the given repo (e.g. it doesn't resolve there), `materializeHistoricalPostgresTask()` throws rather than silently omitting the evidence - a real historical task's fix evidence is required, not best-effort. A legacy task (no oracle declared, e.g. case 001) attempts neither path, matching the Policy A guarantee above. `historicalPostgres002TaskSpec()`'s real usage against the actual PostgreSQL mirror therefore gets real fix evidence automatically, with no manual authoring step.

### Behavioral oracle: attributing a rediscovery to the specific bug, not just to a revision-discriminating script

An exit-status differential alone - the submitted reproducer exits 0 on the historical ref and non-zero on the reference ref - proves only that the script distinguishes *some* difference between the two builds, not that the agent actually rediscovered the specific regression a task is about. `HistoricalPostgresTaskSpec.truth.behavioralOracle` (`server/postgres/historical-behavioral-oracle.ts`) closes that gap with a small, generic, declarative mechanism any historical task can opt into - not a bug-specific executor branch:

```ts
behavioralOracle?: {
  historical: { label: string; matches: string }[]; // ordered patterns the buggy ref's captured output must match
  reference: { label: string; matches: string }[];  // ordered patterns the fixed ref's captured output is expected to match
}
```

When a task declares one, `resolveOracleReproduction()` first calls `classifyExecutionValidity()`, which decides whether the captured execution is even interpretable **authoritatively from `execution.exitCode` alone**, using psql's own real, documented, stable exit-status contract - not stderr text-matching. This is an **allow-list**, not a deny-list of known-bad codes: only `0` (success, or "no fatal client-level error" with tolerated SQL errors present) and `3` (a SQL/script-level error occurred *and* `ON_ERROR_STOP` was in effect) are ever `valid` - the only two possible outcomes of actual SQL-content execution under psql's documented contract. Everything else is unconditionally invalid, whether or not it's one of the specifically-named failure codes below:

- `1` - a fatal **client-side** error (out of memory, could not open the script, bad invocation) - never caused by SQL content. `docker exec`'s own transport failures (a dead container, an OCI runtime failure) sometimes also surface as this same code.
- `2` - a **connection failure** - psql's own documented meaning; also never caused by SQL content.
- `"ETIMEDOUT"` - `execWithInput()`'s own timeout path (`runtime-container.ts`); never a SQL-content outcome either.
- anything else (e.g. Docker/OCI's own commonly-reserved `125`-`127` for "container command could not be invoked/found", or any other exit code neither psql nor Docker conventions named here) - unrecognized, and therefore invalid by the allow-list, not assumed valid by default.

(An earlier round of this work matched a fixed list of stderr phrases instead; the review that followed correctly flagged this as fragile - real failures have forms a phrase list can miss, and ordinary SQL/application text could coincidentally match one - so it was replaced with the exit-code contract above. A later round found that the *first* version of the exit-code contract was itself a deny-list of only `1`/`2`/`"ETIMEDOUT"`, which would have silently treated an unrecognized Docker/OCI transport-failure code as `valid: true` - fixed by inverting to the `0`/`3` allow-list described here, which has no such gap regardless of what exit code an unanticipated transport failure happens to use.) `validity` is deliberately **not** based on how many observations were captured: a genuine SQL-level error, however unexpected, is still a valid, interpretable execution (exit `0` or `3`) - only `evaluateOracleAttribution()` decides whether it matches anything declared.

Only when execution is valid does `resolveOracleReproduction()` extract the ordered sequence of psql `ERROR` message records from the submitted reproducer's own captured stderr - `extractPsqlErrorMessages()`, structurally preserving severity and (when psql's `VERBOSITY` is `verbose`) SQLSTATE, anchored to the real psql/libpq message-record shape (`LEVEL:  message`, canonical two-space formatting, optional SQLSTATE token, optional leading `psql:<file>:<line>:` label - stripped, so source path/line never enters an observation and never needs separate normalization) so `WARNING`/`NOTICE`/`DETAIL`/`HINT`/`CONTEXT`/`STATEMENT`/`LOG`/`INFO`/`DEBUG*` records and any arbitrary text merely *containing* the substring "ERROR:" are never mistaken for a real error record - and calls `evaluateOracleAttribution()`, which matches those observations against **both** halves of the declared oracle and returns a structural `HistoricalPostgresOracleAttribution`:

```ts
type HistoricalPostgresOracleAttribution = {
  validity: { valid: true } | { valid: false; reason: string };  // was execution even interpretable?
  historicalMatch: HistoricalPostgresOracleResult;  // matched against behavioralOracle.historical
  referenceMatch: HistoricalPostgresOracleResult;   // matched against behavioralOracle.reference
  attributedTo: "historical" | "reference" | "unattributed";
};
```

`validity`, "matches the known regression", "matches the declared expected/fixed behavior", and the overall attribution are four separate, structurally-represented facts - not one boolean and a diagnostic string. A client/transport/runtime failure (`validity.valid: false`) is always `attributedTo: "unattributed"` regardless of what, if anything, was captured - it must never read as "the bug is absent" or count toward a miss just because it happened to produce no usable observations. Given a valid execution, `attributedTo` is `"historical"` when only `historicalMatch` is satisfied, `"reference"` when only `referenceMatch` is satisfied, and `"unattributed"` whenever *neither* is satisfied (or, pathologically, both are - a task-authoring bug in the declared patterns, which must also fail closed rather than pick a side arbitrarily). This "unattributed" case is the fix for a real gap: a reference-ref run that fails for some unrelated, unattributed-but-valid reason used to read as plain "not reproduced" - indistinguishable from a reference run that correctly confirmed the fix.

`gradeHistoricalPostgresSubmission()` classifies an oracle-declared task in four parts:

1. either side's execution being invalid (`validity.valid === false`) is always `infrastructure_error`, checked first;
2. `historical.attribution.attributedTo !== "historical"` is `miss` - the captured behavior doesn't match the target regression at all;
3. `reference.attribution.attributedTo !== "reference"` is `invalid_submission` - a positive match on the expected/fixed baseline is required, not merely "didn't match historical"; this is what stops both "reference still shows the historical signature" and "unattributed" from ever reaching `rediscovered`;
4. the submitted reproducer's own exit status must still be consistent with the public self-asserting contract (below) - `execution.ok` true only on the historical ref, false only on the reference ref - or it is also `invalid_submission`, even though the captured text matched everywhere it needed to.

Only when all four checks pass is the result `rediscovered`. `reproduced` (`attributedTo === "historical"`) is retained on each revision's observation only as an informational summary field; the classifier consumes `attribution`/`validity`/`execution.ok` directly, not `reproduced`.

A dynamic value like the stale-plan failure's OID is matched structurally (`matches: "^cache lookup failed for function \\d+$"`), never stripped out of the observation with a broad transform - a targeted, anchored pattern in the declared expectation is what keeps a meaningful difference elsewhere in a message from ever being silently erased.

**Fabrication resistance (SQLSTATE) - a real but partial mitigation, stated honestly.** The submitted reproducer controls its own psql session, so it can emit arbitrary text to stderr - a plain `DO $$ BEGIN RAISE EXCEPTION 'cache lookup failed for function 99999'; END $$;` produces a completely authentic-looking `ERROR:` line with attacker-chosen text, without the real bug ever occurring. `HistoricalPostgresObservationPattern.sqlstate`, when declared, requires an observation's structural SQLSTATE (captured only when psql's `VERBOSITY` is `verbose`) to exactly match, in addition to `matches` passing. A plain `RAISE EXCEPTION` with no explicit `USING ERRCODE = ...` always gets SQLSTATE `P0001` - meaningfully distinct from a genuine internal-error SQLSTATE - so this raises the bar against naive text-only fabrication once a task's oracle opts in. `historicalPostgres002TaskSpec()`'s own patterns do **not** declare `sqlstate` yet: the real SQLSTATE values for its two error conditions have not been verified against an actual PostgreSQL 14 build in this sandbox, and a wrong hardcoded value would make the oracle permanently unsatisfiable even for a genuine correct reproduction - worse than not checking it at all. This is a concrete, scoped follow-up for an operator with the real mirror (verify the SQLSTATEs, then add `sqlstate` to the two patterns that need it); `test/historical-behavioral-oracle.test.ts`'s SQLSTATE test proves the mechanism works, using a synthetic oracle, independent of whether task 002 uses it yet.

This is **not** a claim of full tamper-proofing. `validity` (exit-code-derived) is authoritative and structural - a real signal from the layer that ran the command. Message/SQLSTATE matching against declared patterns, however, is still fundamentally interpreting psql's own rendered text, not an independent grader-owned wire-protocol capture. SQLSTATE checking meaningfully raises the bar against naive fabrication when a task's oracle opts into it; it does not make fabrication impossible for a sufficiently deliberate adversarial submission. `defaultGradeRevision()`'s `attribution-result.json` records `validity` as the authoritative gate and the full `historicalMatch`/`referenceMatch` detail as the (psql-text-derived) evidence behind `attributedTo`, so this distinction is visible in retained evidence, not just in this document.

**Considered and deliberately not implemented: reading the PostgreSQL server log instead of psql's client stderr (#200 fifth review round, Blocking 2).** A fifth review round proposed making the server-side log - rather than the submitted reproducer's own captured client stderr - the authoritative evidence channel, reasoning that a submitted script "controls its own psql session" and so shouldn't be trusted as final truth. That's a real category of concern, but the *specific* mitigation doesn't close the *specific* gap it was proposed for: a fabricated `DO $$ BEGIN RAISE EXCEPTION 'cache lookup failed for function 99999'; END $$;` is not a client-side lie a server log could catch - `RAISE EXCEPTION` is PostgreSQL's own real, server-side `ereport()` mechanism, and it writes *the same* severity/SQLSTATE/message to the server log as it sends to the client, via the identical code path. There is no discrepancy between the two channels for this attack to expose; reading the log instead of stderr would only help against a *differently-behaving client* (e.g. a tampered psql binary that prints something other than what the server actually said), which is not a threat this benchmark is concerned with - the submitted artifact is a SQL script, not a modified client binary. Building session-correlated server-log capture was therefore not implemented: it would be real, non-trivial new infrastructure (unique execution identity, log-offset/PID correlation, a new observation type) in exchange for no actual improvement against the stated threat model. A mitigation that *would* meaningfully help against `RAISE EXCEPTION`-style fabrication - a small, generic, declarative "grader-side post-execution verification query" (e.g., for this specific bug, confirming the OID named in the second observation genuinely no longer exists in `pg_proc`, something a fabricated message can't satisfy without the agent already knowing a real dangling OID) - was identified as a better-targeted alternative and left as an explicit, undesigned future-work item rather than implemented in this PR, to avoid open-ended expansion of reward-hacking mitigations at this stage.

Absent a declared oracle (case 001, and any synthetic/unit-test spec), `reproduced` is exactly the legacy `execution.ok` exit-status differential and the classifier takes its original, untouched branch - zero behavior change.

**The behavioral oracle is additional to the public reproducer contract, not a replacement for it.** The agent-visible prompt (`historicalPostgres002TaskPrompt()`, unchanged from case 001) still promises: "the reproducer must encode its own assertion and exit successfully only when the observed behavior violates that assertion." A submission whose captured text happens to match the declared oracle but whose own exit status doesn't follow that contract must not be credited either - see step 4 above and "Submission and deterministic grade" below.

### Structured-output oracle: attributing a rediscovery via exact query output (case 003)

A third oracle family complements the exit-status oracle (case 001) and the behavioral/regex oracle (case 002). `HistoricalPostgresTaskSpec.truth.structuredOracle` (`server/postgres/historical-structured-oracle.ts`) declares the exact tuples the submitted reproducer's own captured stdout must return, per revision:

```ts
structuredOracle?: {
  historical: { rows: string[][]; ordered?: boolean };  // exact rows the buggy ref's stdout must match
  reference:  { rows: string[][]; ordered?: boolean };  // exact rows the fixed ref's stdout must match
};
```

The executor (`psqlArgs()` in `runtime.ts`) already bakes `-X -t -A` (no psqlrc, tuples-only, unaligned) into every `psqlFile()` invocation, so machine-stable query output is already captured in `execution.stdout` with no new runtime changes. The grader compares the captured tuples against the declared expectations using `parseTuplesOnlyOutput()` (splits on `\r?\n`, drops one trailing newline, splits each line on `|`) and `evaluateStructuredOracle()` (exact row count, exact field count per row, exact field values; row order enforced unless `ordered: false` selects multiset comparison). Malformed truth (`expected.rows` not a non-empty array of non-empty string arrays) throws rather than silently failing — task-authoring bugs must be loud.

`evaluateStructuredOracleAttribution()` evaluates captured rows against *both* halves of the declared oracle and returns the same structural `{ validity, historicalMatch, referenceMatch, attributedTo }` shape as the behavioral oracle's `HistoricalPostgresOracleAttribution`, making it duck-type-compatible with `gradeHistoricalPostgresSubmission()`'s existing 4-step classifier — no oracle-specific branching in the classifier. Execution validity is determined from `execution.exitCode` alone using the same `classifyExecutionValidity()` allow-list (`0`/`3` only) as the behavioral oracle; when not valid, `attributedTo` is always `"unattributed"` regardless of what stdout contains.

**The structured oracle is additional to the public self-asserting contract, not a replacement for it.** The agent-visible prompt still promises: "the reproducer must encode its own assertion and exit successfully only when the observed behavior violates that assertion." A submission whose captured stdout matches the declared oracle but whose own exit status doesn't follow that contract (`historical.execution.ok !== true` or `reference.execution.ok !== false`) is `invalid_submission` — step 4 of the 4-step classifier, unchanged.

`resolveOracleReproduction()` dispatches on which oracle is declared — `structuredOracle` first, then `behavioralOracle`, then the legacy exit-status path — so the dispatch order is: structured → behavioral → exit-status, each mutually exclusive. `gradeHistoricalPostgresSubmission()`'s `oracleDriven` flag is `Boolean(task.truth.behavioralOracle) || Boolean(task.truth.structuredOracle)` so either oracle family activates the 4-step structural classifier.

### Grading protocol identifiers

`reference/truth.json` and `reference-manifest.json` both carry `gradingProtocol`, one of three honestly distinct values:

- `"submitted-reproducer-exit-status-v1"` - case 001, and any spec that declares no `truth.behavioralOracle` or `truth.structuredOracle`. Grading is purely the reproducer's own exit-status differential, unchanged since #184.
- `"submitted-reproducer-behavioral-oracle-v1"` - case 002, and any future spec that declares a `behavioralOracle`. Grading additionally requires the structural stderr-observation attribution above.
- `"submitted-reproducer-structured-oracle-v1"` - case 003, and any future spec that declares a `structuredOracle`. Grading requires the exact captured stdout to match the declared per-revision tuple expectations.

`materializeHistoricalPostgresTask()` derives this from whether `truth.behavioralOracle` is present - no separate configuration to keep in sync. `gradingProtocol` is covered by the **truth-bundle hash** (`bundleHash`, via `truthShape`) - it is deliberately *not* part of `taskDefinition`/`taskDefinitionHash`, which covers only revision-independent task-shape facts (scaffolding, budget, build profile, prompt/source hashes) that have nothing to do with grading semantics. `test/historical-postgres-002-task.test.ts`'s `"gradingProtocol/behavioralOracle presence is covered by bundleHash but not by taskDefinitionHash"` test proves this boundary directly: two specs identical except for `truth.behavioralOracle` presence produce the same `taskDefinitionHash` but a different `bundleHash`. Which protocol graded a task instance is therefore provenance-covered by `bundleHash`, not `taskDefinitionHash`.

## Submission and deterministic grade

The agent writes directly in its workspace:

```text
finding.json
repro.sql                  # only when status is "reproduced"
supporting-artifacts/      # optional
```

`finding.json` always requires a non-empty `summary`. When `status` is `"not-reproduced"`, that is the entire requirement - no `reproducer` is needed, and if one happens to be present it is never read by the grader: a legitimate miss is never upgraded to `rediscovered` by a `reproducer` field the submission did not rely on. The grader does not run the two-revision reproducer at all in this case; it grades directly to `miss`. When `status` is `"reproduced"`, `reproducer` is required and must name a file directly inside the workspace, resolvable, non-directory, and within the 256 KiB limit.

The SQL reproducer must encode its own assertion: **on the historical (buggy) revision, the assertion succeeds and the script exits 0 - that is what "the regression is observed" means. On the corrected reference revision, the same script must exit non-zero (raise/abort) - that is what "the regression is absent" means.** (Issue #184's prose - "fails on the buggy ref, passes on the fixed ref" - describes the same underlying regression from the opposite direction: whether the *correct answer* was produced, not the reproducer script's own exit status. This document's exit-code convention is the one the grader actually implements and the one every test in this repository asserts against.) The grader executes exactly that file against the historical build and the corrected build using the same research environment profile - never any canonical verification reproducer, which (when one exists for a case) exists only to prove the task instance is well-posed before an agent ever runs.

Before copying returned agent output the grader caps the workspace at 16 MiB and 2,048 entries; oversize output and paths that resolve outside the workspace are `integrity_error`, not infrastructure failures.

| Submission | Historical | Corrected | Grade |
| --- | --- | --- | --- |
| `not-reproduced` (any/no reproducer) | n/a | n/a | `miss` |
| `reproduced`, reproducer reproduces | does not reproduce | `rediscovered` |
| `reproduced`, reproducer does not reproduce | any | `miss` |
| `reproduced`, reproducer reproduces | reproduces | `invalid_submission` |
| malformed/missing `finding.json`, or `reproduced` without a valid `reproducer` | n/a | `invalid_submission` |
| build/start/grader failure | n/a | `infrastructure_error` |
| workspace escape/tamper | n/a | `integrity_error` |

This table is the `"submitted-reproducer-exit-status-v1"` protocol (case 001): "Historical"/"Corrected" above are the reproducer's own `execution.ok` exit-status differential. Under `"submitted-reproducer-behavioral-oracle-v1"` (case 002+), the same four grade outcomes still apply, but classification is driven by structural `attribution`, not `execution.ok` alone, in four steps (see "Behavioral oracle" above for the full reasoning): an invalid execution on either side (`validity.valid === false` - a client/transport/runtime failure) is `infrastructure_error`, checked first, regardless of what (if anything) was captured; `miss` requires `historical.attribution.attributedTo !== "historical"`; `rediscovered` requires `historical.attribution.attributedTo === "historical"` **and** `reference.attribution.attributedTo === "reference"` (a positive match, not merely "not historical") **and** the reproducer's own exit status still following the public self-asserting contract (`historical.execution.ok === true`, `reference.execution.ok === false`); anything else creditable-shaped (reference still shows the historical signature, is `"unattributed"`, or the exit-status contract wasn't honoured despite matching text) is `invalid_submission` - never a silent `rediscovered`.

Each revision's artifact directory retains source/build/runtime manifests, server log, grader output, and final `grade.json`. No infrastructure failure is converted into a miss.

## Scored vs. unscored: `HistoricalPostgresTrial.status`

`runHistoricalPostgresTrial()` returns `status: "completed" | "unscored" | "blocked" | "infrastructure_error" | "integrity_error"` and a top-level `scoredEligible: boolean`, which mirrors `session.isolation.scoredEligible` from `research-session.ts`. These are two separate facts and a consumer must check both, not just `status`:

- **`scoredEligible: false`** - the run's isolation was not the scored configuration (most commonly `network: "bridge"`, which a real LLM agent needs for model-API access; see `unscoredReasons()`). The deterministic grader still runs, because a diagnostic result is useful evidence, but `status` is `"unscored"`, never `"completed"` - a bridge-network run can never produce an official scored `miss` or `rediscovered`, no matter what `grade.status` says. `diagnostics` includes an explicit `"Not a scored trial: ..."` line carrying `session.isolation.warning`.
- **`scoredEligible: true` and `status: "completed"`** - `grade` is the official score.
- **`status: "blocked"`** - the agent process itself did not exit 0 (`session.agent.ok === false`): a driver configuration error, an LLM-API/driver exception, or exhausting its turn budget without a valid submission (see below). No grader ever runs in this case, and `grade` is `undefined` - a blocked run is never counted as a miss.

## Local use

The programmatic entry points are `historicalPostgres001TaskSpec()` / `historicalPostgres002TaskSpec()`, `materializeHistoricalPostgresTask()`, `runHistoricalPostgresTrial()`, and `gradeHistoricalPostgresSubmission()` from `server/postgres/historical-task.ts`. `runHistoricalPostgresTrial()` is the real-agent vertical slice: it passes the public task prompt as `HONEYRAIL_TASK_PROMPT` and the opaque id as `HONEYRAIL_TASK_ID`, gives the isolated agent its normal `$HR_PG_WORK_DIR`, copies returned files grader-side, and grades the same submitted file on both revisions.

The real two-revision check is opt-in because it needs the prebuilt local Docker images, PostgreSQL mirror, and the local known repro (the repro is intentionally not committed). It must report the historical/reference execution records, source/build hashes, `grade.json`, and artifact paths; a missing image, build, or startup is `infrastructure_error`, not an agent miss.

```sh
export HONEYRAIL_PG_184_MIRROR=/path/to/local/postgres-mirror
export HONEYRAIL_PG_184_REPRODUCER=/private/path/to/known-repro.sql
npm run test:historical-pg-184

# The configured agent command must be available inside the research image
# and write finding.json/repro.sql in $HR_PG_WORK_DIR.
export HONEYRAIL_PG_184_AGENT_COMMAND=/path/in/agent-image/to/agent
npm run historical-pg-184
```

Case 002 (#200) follows the identical shape, on `HONEYRAIL_PG_200_*` instead of `HONEYRAIL_PG_184_*` - **with one difference: `HONEYRAIL_PG_200_REPRODUCER` is a hard requirement for `npm run historical-pg-200`, not an optional one.** Unlike case 001's script, `scripts/historical-postgres-200.ts` fails fast if it's unset, so a real Bug 2 trial can never run without canonical truth provenance:

```sh
export HONEYRAIL_PG_200_MIRROR=/path/to/local/postgres-mirror
export HONEYRAIL_PG_200_REPRODUCER=/private/path/to/known-repro.sql
npm run test:historical-pg-200

export HONEYRAIL_PG_200_AGENT_COMMAND=/path/in/agent-image/to/agent
npm run historical-pg-200
```

### Case 002's canonical reproducer (private, not committed)

Like case 001's, case 002's canonical verification reproducer is deliberately **not** committed to this repository: this is a public repo, and checking in the answer key would let it leak into a future agent's training data, which would defeat the eval it is meant to validate. `HONEYRAIL_PG_200_REPRODUCER` points at a private local file; `historicalPostgres002TaskSpec()`'s `knownReproducerPath` parameter only hashes it into `reference/truth.json` for provenance (`canonicalReproducerSha256`) and, when the test above is run, retains a copy under the case's own `reference/verification/canonical-reproducer.sql` - grader-private, never mounted into an agent. The grader never executes this file as part of grading a submission; it exists only to prove a task instance is well-posed before any agent runs.

**Correction (#200 third review round):** an earlier draft of this document claimed the script "no longer has to self-assert its own pass/fail via a captured-and-compared exit status" and that "the script's own final exit status is no longer what grading depends on for this task." That was wrong, and would have let a submission violate the public prompt contract ("the reproducer must encode its own assertion and exit successfully only when the observed behavior violates that assertion") while still scoring `rediscovered` on captured text alone. The behavioral oracle is **additional** to that contract, not a replacement for it - see "Behavioral oracle" above, step 4. The canonical/agent reproducer must still self-assert via exit status exactly per case 001's original convention. Building it locally, encode the five-step sequence recorded in #185 (create wrapper procedure `p1`, create called procedure `p2`, invoke `p1` once to record the baseline error, drop and recreate `p2`, invoke `p1` again) as a single `psql -X` script:

1. `\set ON_ERROR_STOP off` before any DDL/CALL runs - the first invocation of `p1` is *expected* to error (that is the recorded baseline, not a script failure), and the script must keep running past it to reach the drop/recreate and the second invocation. `psqlFile()` in `runtime-container.ts` invokes psql with `-v ON_ERROR_STOP=1` as an initial variable, but a `\set` meta-command inside the script file overrides it before the first statement runs, so no change to the shared research-environment code is needed for this.
2. Run the wrapper procedure `p1` once (recording the baseline `ERROR`), drop and recreate the called procedure `p2`, then run `p1` again (recording the second `ERROR`). HoneyRail's grader (`resolveOracleReproduction()`/`extractPsqlErrorObservations()`/`evaluateBehavioralOracle()`) independently extracts and matches both `ERROR` observations from psql's own stderr against `historicalPostgres002TaskSpec()`'s declared `truth.behavioralOracle` patterns, using `\d+` to match the buggy ref's dynamic OID rather than any client-side normalization - but this is *in addition to*, not instead of, the script's own assertion below.
3. Before the script ends, `\set ON_ERROR_STOP on` and use psql's own captured-error facilities (e.g. `:LAST_ERROR_MESSAGE`/`:LAST_ERROR_SQLSTATE`, available since PG10, or an equivalent `DO $$ ... EXCEPTION WHEN OTHERS ...$$` capture) to assert on the second invocation's own error text and make the script's *own* exit code encode the result: exit 0 only when that text matches the stale-cache signature (the historical/buggy ref's behavior), non-zero otherwise (the reference/fixed ref's behavior) - the same exit-code convention as case 001, in "Submission and deterministic grade" below. `psql -X` (ignore any local `.psqlrc`) is still required. Setting `\set VERBOSITY verbose` near the top of the script additionally makes psql render SQLSTATE inline, which is what a future hardened oracle (see "Fabrication resistance" above) would require of the canonical reproducer too - not required for the currently-declared, message-only patterns.

### Real-agent vertical slice

The base `docker/postgres-research` image deliberately ships no agent CLI ("which agent runs is the driver's choice"). `docker/postgres-research-agent-184/` is a derived image that adds exactly one: `mini-agent.mjs`, a small driver that makes genuine calls to an OpenAI-compatible chat-completions endpoint (no scripted/known-answer path) and drives `psql` through a `run_shell` tool, submitting via a `submit_finding` tool that is the only thing that writes `finding.json`.

A real LLM agent needs outbound network access to its model API, which the scored default (`network: "none"`) does not provide. `research-session.ts` already anticipates this: `isolation.network: "bridge"` is a supported, explicit opt-in that is honestly recorded as `scoredEligible: false` with a stated reason (see `unscoredReasons()`), rather than a silent downgrade. The two-revision **grading** of both pinned revisions is unaffected and stays fully isolated (`network: "none"`) regardless of the agent's own network mode, since grading never runs an agent - only `psqlFile()` against each revision's own runtime container. See "Scored vs. unscored" above: a bridge-network run is always `status: "unscored"`, never a scored `miss`/`rediscovered`.

```sh
docker build -t honeyrail-postgres-research-184-agent:latest docker/postgres-research-agent-184

export HONEYRAIL_PG_184_MIRROR=/path/to/local/postgres-mirror
export HONEYRAIL_PG_184_AGENT_COMMAND=node
export HONEYRAIL_PG_184_AGENT_ARGS='["/opt/agent/mini-agent.mjs"]'
export HONEYRAIL_PG_184_AGENT_IMAGE=honeyrail-postgres-research-184-agent:latest
export HONEYRAIL_PG_184_AGENT_NETWORK=bridge
export HONEYRAIL_PG_184_AGENT_ENV='{"HONEYRAIL_AGENT_LLM_API_KEY":"...","HONEYRAIL_AGENT_LLM_BASE_URL":"https://api.deepseek.com","HONEYRAIL_AGENT_LLM_MODEL":"deepseek-chat"}'
npm run historical-pg-184
```

The script prints a "Real-agent trial summary" block distinguishing integration status, `scoredEligible`, the diagnostic grader result, and the official scored result (`"N/A"` whenever `scoredEligible` is false) - and its own exit code reflects only integration failure (`blocked`/`infrastructure_error`/`integrity_error`), never "not scored".

#### mini-agent failure attribution

`research-session.ts` reads only the child process's exit code to decide `agent.ok`, so `mini-agent.mjs`'s exit code is what keeps a driver/protocol failure from being misreported as a graded outcome:

| Situation | Exit code | `HistoricalPostgresTrial.status` |
| --- | --- | --- |
| Valid `submit_finding` call (`reproduced` or `not-reproduced`) | 0 | proceeds to grading (`completed`/`unscored`) |
| Missing `HONEYRAIL_AGENT_LLM_API_KEY` or `HONEYRAIL_TASK_PROMPT` | 1 (config error) | `blocked` |
| LLM API error (401/429/500/...), malformed API response, or any other driver exception | 2 (driver error) | `blocked` |
| Turn budget exhausted without a valid `submit_finding` call | 3 (budget exhausted) | `blocked` |

The driver never fabricates a `finding.json` on the model's behalf: a malformed `submit_finding` call (missing/invalid `status`, empty `summary`, or a `"reproduced"` call missing `reproducer_filename`/`reproducer_sql`) returns a tool error to the model - recorded in the transcript exactly as attempted - rather than being silently normalized into a valid submission, and running out of budget without ever producing a valid call is a driver-attributed `blocked` run, not a manufactured `not-reproduced` miss. The validation itself (`validateSubmitFindingArgs`) is a small pure function in `docker/postgres-research-agent-184/finding-validation.mjs`, unit-tested directly in `test/historical-postgres-mini-agent-validation.test.ts` without a real API call.

#### Evidence: agent-owned vs. grader-owned

- **Grader-owned** (written by HoneyRail code, not the agent): `task-manifest.json`, `reference/truth.json`, `agent-result.json` (the full session/isolation/runtime record), `agent-stdout.txt`/`agent-stderr.txt` (the agent process's own captured stdio), `agent-postgres.log` (the live PostgreSQL server log from the agent's own investigation session - copy failure is recorded as an `evidence_warning` diagnostic, never silently dropped), and `grader/grade.json`.
- **Agent-owned** (written by the agent itself into its writable workspace, then copied grader-side as `agent-workspace/`): `finding.json`, any reproducer file, and `transcript.jsonl` (every model turn and tool call/result mini-agent.mjs logs). This is useful v0 evidence for understanding what the agent tried, but it is not immutable or grader-trusted the way the manifests above are - the agent process itself could in principle have written anything into its own workspace. Treat it as agent-reported trajectory, not verified execution evidence.
