# Paper artifact plan

## Goal

Preserve auditability without treating generated runtime directories as publication artifacts.

The paper uses three artifact layers.

## L0 — Custodial raw evidence

Operator-held, immutable, not committed to Git.

Contains the exact as-run experiment directories, including large/redundant build products and grader-private material.

Current sources of record:

```text
output/historical-pg-212/exp216-e0e3-dsh-2026-09-09/
output/historical-pg-221/exp222-e0e3-dsh-2026-09-10/
```

Freeze each completed experiment as an immutable archive and record a cryptographic checksum. Keep at least two independent copies.

Recommended naming:

```text
custodial/
  exp216-e0e3-dsh-2026-09-09.tar.zst
  exp222-e0e3-dsh-2026-09-10.tar.zst
  SHA256SUMS
  INDEX.json
```

Rules:
- never rewrite or sanitize L0 in place;
- never remove failed/retry attempts;
- never regenerate transcripts and replace the originals;
- never publish credentials/private machine paths accidentally contained in L0;
- treat L0 as the evidentiary source of record.

## L1 — Public research evidence pack

A deterministic sanitized export derived from L0. This is the intended paper-review/research artifact.

Suggested layout:

```text
paper-artifact/
  README.md
  REPRODUCING.md
  ARTIFACT-MANIFEST.json
  SHA256SUMS
  experiments/
    exp216/
      experiment-manifest.json
      attempt-ledger.json
      E0/
      E1/
      E2/
      E3/
    exp222/
      ...
  analysis/
    metrics.csv
    stage-analysis.csv
    cross-family.csv
  environment/
    postgres-revisions.json
    container-identities.json
    model-runtime.json
  scripts/
    verify-artifact.sh
    regenerate-paper-tables.py
```

Per-attempt files should preferentially include non-derivable observations:
- task/reference manifests and hashes;
- agent result/status;
- sanitized authoritative transcript;
- normalized trajectory and session statistics;
- workspace inventory;
- submitted `finding.json` and reproducer;
- grader result;
- sanitized attribution result;
- relevant PostgreSQL stdout/stderr/log excerpts needed to verify the result.

Exclude or replace with reproducible identities:
- complete PostgreSQL source checkouts;
- build trees and installed binaries that can be reconstructed;
- Docker build cache;
- temporary PGDATA;
- node_modules/package caches;
- duplicated reference trees.

## L2 — Reproducibility environment

Public software and environment definitions sufficient to reconstruct execution:
- exact HoneyRail release/commit;
- exact PostgreSQL historical/reference refs;
- introducing change refs;
- Dockerfiles and pinned base-image identities;
- builder/runtime/agent image identities;
- configure/build arguments and toolchain identity;
- experiment-manifest format;
- task materialization/re-execution commands;
- grader protocol implementation.

Identity reproducibility and execution reproducibility are different. A local image digest proves what ran, but reviewers also need a retrievable image or a reproducible build definition.

## Declassification policy

A historical task's private evaluation material can move through:

```text
PRIVATE / formal evaluation
-> FROZEN / analysis
-> PUBLIC / paper artifact
```

After a case is described in the paper and its results have informed methodology, it is development-exposed and should not be used for future unseen-transfer claims.

Before final publication, decide explicitly whether canonical reproducers and oracle material for Studies 1/2 are declassified. Default paper recommendation: publish them once they no longer serve as unseen evaluation cases, because reproducibility benefit outweighs continued secrecy.

## Sanitization requirements

The public exporter must fail closed on:
- API keys/tokens/credentials;
- local user/home/private paths;
- unapproved grader-private material before declassification;
- environment secrets;
- accidental future-answer material for still-unseen tasks.

Sanitization should be scripted and reproducible rather than manual copy/edit.

## Known telemetry limitation

Track #218 explicitly. If derived `agent-trajectory.jsonl` cannot supply shell-command exit codes, document the authoritative transcript as the source of truth and list the limitation in the artifact README. Do not fabricate or infer missing exit codes.

## Publication target

Keep source/software in the HoneyRail repository. Publish the frozen research evidence pack as a versioned release and archive it in a DOI-bearing research repository when submission-ready.

The published artifact must support at least:

```text
./scripts/verify-artifact.sh
```

Expected checks:
- archive/file hashes verify;
- experiment identities match frozen manifests;
- all formal attempts reconcile with ledgers;
- no secrets are present;
- paper metrics/tables regenerate from the published evidence;
- grader outcomes can be independently reconciled from included evidence or reproducible execution.