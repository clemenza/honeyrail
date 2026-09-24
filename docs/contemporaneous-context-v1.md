# Contemporaneous Engineering Context v1

Issue #228 defines this contract before any implementation. It does not
materialize a third task's context bundle (#231), does not implement temporal
search (C4 is contract-only here), does not select or reserve a causal family
(#230), and does not run a scored experiment (#232). It is the methodology
layer that #229 (exposure ledger) and #231/#232 build on.

## Why this exists

Studies 1–3 (`postgres-change-001`/BUG #16867, #216/#220; `postgres-change-002`/BUG
#18574, #222/#224; `postgres-historical-003`, #233/#236) measured the effect of
*post-hoc* context: a hand-written SPEC (E1), the introducing diff (E2), and a
generic HarnessProfile (E3) - see `docs/historical-postgres-task-v0.md`'s
"Change-oriented tasks" section. Across all three, SPEC-only context produced
no measured rediscovery/localization gain, while the introducing change-set
consistently focused investigation and reduced observed search cost. The
generic HarnessProfile increased cost without gain.

The next research step studies **real contemporaneous engineering
information** - the discourse and validation evidence that actually existed
around the introducing change - rather than continuing to enrich prompts
written after the fact. That only produces valid evidence if what gets
exposed is genuinely time-consistent and was not selected using knowledge of
the eventual bug. This document is that contract.

## Core rule

```text
artifact_timestamp <= task_cutoff
AND
artifact selection does not depend on knowledge of the future defect/fix
```

Both conjuncts are required. A historically old artifact can still be
contaminated if it was selected *only because* later bug knowledge revealed
that it contains the answer - timestamp discipline alone does not prevent
this (see "Anti-hindsight selection rule" below).

`task_cutoff` is the same timestamp already used to define a change-oriented
task's introducing commit (e.g. `postgres-change-001`'s `280a408b`, 2019-03-24
- `docs/historical-postgres-task-v0.md`). It is fixed per task, not per
artifact-collection run.

## Context taxonomy (C0-C4)

```text
C0 - Source
  Repository/source snapshot at the historical cutoff. Already implemented:
  materializePostgresSource() / task/source-manifest.json.

C1 - Change Package
  Commit message
  Complete introducing diff
  Contemporaneous patch-series versions / cover letters, when available

C2 - Development Discourse
  Proposal/design discussion
  Patch review and reviewer concerns
  Author replies / revision notes / committer discussion

C3 - Validation Context
  Tests added/modified by the change
  Contemporaneous documentation changes
  CI / cfbot / buildfarm evidence available at the cutoff
  Contemporaneous benchmark/performance evidence
  Explicitly declared prerequisite/dependency patches

C4 - Temporal Retrieval (contract only here; future implementation)
  git history / mailing-list / CommitFest / docs search, all bounded by cutoff
```

C0-C1 correspond to the existing E0/E2 scaffolding levels
(`docs/historical-postgres-task-v0.md`'s `changeContext`/`scaffoldingLevel`).
C2 and C3 are new context classes this document defines for the first time;
no task currently materializes them. C4 is a retrieval *mechanism*, not a
fixed artifact set - it is named here so future retrieval implementations
have a class to declare artifacts under, but no retrieval code is implemented
by this issue.

## Future-truth boundary

Formal discovery must never expose:

- future bug reports or fix commits,
- future regression tests,
- canonical reproducers or hidden oracle material,
- corrected/reference source (the post-fix revision),
- future release notes or back-patch discussion describing the defect,
- postmortem or future diagnosis of the defect.

This is the same boundary the existing task materializer already enforces
structurally for `reference/` (never mounted into an agent - see
`docs/historical-postgres-task-v0.md`'s "Layout and boundary"). C0-C4 extend
that boundary to a richer set of C1-C3 artifact classes; the boundary itself
does not change.

## Anti-hindsight selection rule

Time consistency (`artifact_timestamp <= task_cutoff`) is necessary but not
sufficient. An artifact must not be selected merely because knowledge of the
future bug made it look relevant - a hindsight-driven curator can pick only
the pre-cutoff messages that happen to foreshadow the regression while
ignoring the rest of a contemporaneous thread, producing a misleadingly
focused context that a contemporaneous engineer never actually had.

Allowed inclusion rules are **deterministic and predeclared** - decidable
from the change identity alone, without reading the future bug report or fix.
Examples:

- all messages in the introducing patch thread up to the introducing-commit
  cutoff;
- every patch version attached to that thread before cutoff;
- all files/tests/docs changed by the introducing patch;
- all explicitly linked prerequisite patches named in contemporaneous
  material;
- complete CommitFest metadata visible before cutoff.

`selected because relevant to the known future bug` is **not** an acceptable
inclusion rule, regardless of how old the selected artifact is.

### Contamination examples

| Case | Contaminated? | Why |
|---|---|---|
| Include every message in the introducing patch's review thread up to the commit timestamp. | No | Deterministic, decidable from the thread identity alone - matches "all messages in the introducing patch thread up to cutoff." |
| Include only the one reviewer comment that, read with hindsight, turns out to describe the exact edge case that later became the bug - while omitting the rest of that same thread. | Yes | The *selection* (not the timestamp) depended on already knowing which comment "matters," which requires knowing the future defect. |
| Include the full CI/buildfarm log attached to the introducing patch's CommitFest entry, because CI evidence is a declared C3 class for every change-oriented task. | No | Class-level inclusion rule applied uniformly, not chosen because of this specific bug. |
| Include a mailing-list post from three years *before* the introducing commit because, in hindsight, it turns out to discuss a related design tradeoff that explains the eventual bug. | Yes | Even though `artifact_timestamp <= task_cutoff` holds, the post was found and included by searching *for* the future bug's explanation, not via a predeclared, decidable rule. |
| Include every prerequisite patch the introducing commit's own message explicitly names as a dependency. | No | Decidable from the introducing commit's own contemporaneous text, not from later bug knowledge. |

## Required provenance contract

Every exposed artifact must carry at minimum:

- **artifact ID** - opaque, stable identifier within the task's context bundle.
- **class** - one of `C0`-`C4`.
- **source/provenance identifier** - e.g. mailing list name, CommitFest id, repository.
- **public URL / message-id / commit**, when available (`null` when genuinely unavailable - never fabricated).
- **artifact timestamp** - the artifact's own contemporaneous timestamp.
- **task cutoff** - the task's fixed cutoff, so the core-rule comparison is always self-contained in the artifact's own record, not implied by external context.
- **content SHA-256** - hash of the artifact's retained content.
- **inclusion rule** - the specific deterministic rule (from the anti-hindsight list, or an equally deterministic task-declared rule) that selected this artifact.
- **collection procedure / version** - how and by what mechanism this artifact was gathered (manual, scripted, version-pinned), so a later change in collection tooling is itself provenance-visible.
- **`derived` identity** - `true`/`false` (see "Raw vs. derived material").

This mirrors the field-completeness discipline `docs/historical-postgres-task-v0.md`
already applies to `truth.json` and `task-manifest.json`: every fact that
matters to trusting an artifact is recorded on the artifact itself, not left
implicit.

If `derived=true`, the derivation must be mechanical and based only on
allowed pre-cutoff material; the `collection procedure` field must name that
mechanism. Human-written post-hoc summaries must never silently masquerade as
raw contemporaneous evidence by omitting or leaving blank the derivation
procedure.

## Raw vs. derived material

Prefer original material: commit messages, patch versions, review mail,
tests/docs, and benchmark/CI evidence, retained as close to their original
form as licensing/size allows. Mechanically generated change-impact
summaries, call graphs, or symbol maps are a **separate future intervention
class**, not historical context - they may be useful, but they are not what
"contemporaneous engineering context" means here, and must never be
classified as C0-C4 raw evidence.

**The current hand-written SPEC (E1, used in `postgres-change-001`/`002`) is
a curated requirement abstraction, not raw historical evidence.** It was
authored by a person after the fact to describe the feature and invariant,
not retained unmodified from the historical record. Classifying it honestly
as curated material - rather than implicitly presenting it as a raw C1/C2
artifact - is itself a deliverable of this document; it explains Studies 1-3's
finding that SPEC-only context did not produce a measured gain: it is not the
kind of artifact this contract now says should carry the evidentiary weight
of "real contemporaneous engineering context."

## Provenance schema

A small versioned type/validator for a single artifact's provenance record -
`ContemporaneousArtifactProvenance` (schema version 1) - is implemented in
[`server/postgres/contemporaneous-context.ts`](../server/postgres/contemporaneous-context.ts),
covered by [`test/contemporaneous-context.test.ts`](../test/contemporaneous-context.test.ts).
It validates the core rule (timestamp ordering), the C0-C4 class vocabulary,
required non-empty fields (`inclusionRule`, `collectionProcedure`,
`sourceIdentifier`, `artifactId`), the SHA-256 hash shape, and that
`collectionProcedure` is always required regardless of `derived` - a derived
artifact does not get to skip naming its own derivation mechanism.

This module is standalone: it is not imported by `historical-task.ts`,
`historical-corpus.ts`, or any materialization path, so no existing
`taskDefinitionHash`/`bundleHash`/`corpusHash` moves as a result of this
change, and Corpus v0 / `postgres-change-001`/`002` behavior is unaffected.
A future `ContextEnvelope` (#231) is expected to build on this schema rather
than redefine it, but that materialization is explicitly out of scope here.

## Non-goals

- No family selection (#230).
- No `ContextEnvelope` materialization for any task (#231).
- No temporal search implementation (C4 is contract-only).
- No Capability Lab intervention.
- No grader/oracle change.
- No claim that more context is always better - Studies 1-3 already show the
  opposite for at least one context class (HarnessProfile).
- No `ContextProvider`/`EvalProvider`/`ManagedEnvironment` abstraction.
- No scored experiment.

## Related

#216, #220, #221, #222, #224, #225, #229, #230, #231, #232, #233, #236.
