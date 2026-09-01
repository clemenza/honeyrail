import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { publishEvent } from "../events.js";
import type { Artifact, Evidence } from "../types.js";
import type { StepExecutionContext } from "./types.js";

/**
 * Artifact/evidence plumbing shared by the database executors (the
 * transaction-restart alpha in postgres.ts and the research environment in
 * postgres-research.ts). Extracted so both record through one code path
 * rather than growing two slightly different copies; the DB-specific
 * metadata each scenario attaches stays with the caller.
 */

export async function publishArtifactEvent(ctx: StepExecutionContext, artifact: Artifact) {
  await publishEvent(ctx.store, ctx.bus, {
    type: "artifact.created",
    projectId: ctx.project.id,
    payload: { runId: ctx.runId, stepId: ctx.step.id, artifactId: artifact.id, kind: artifact.kind, name: artifact.name }
  });
}

export async function publishEvidenceEvent(ctx: StepExecutionContext, evidence: Evidence) {
  await publishEvent(ctx.store, ctx.bus, {
    type: "evidence.recorded",
    projectId: ctx.project.id,
    payload: { runId: ctx.runId, stepId: ctx.step.id, evidenceId: evidence.id, kind: evidence.kind, claim: evidence.claim }
  });
}

function artifactUri(ctx: StepExecutionContext, name: string) {
  return `honeyrail://runs/${ctx.runId}/steps/${ctx.step.id}/attempts/${ctx.step.attempt}/${name}`;
}

/** Writes `content` into `baseDir/name` and registers it as an Artifact. */
export async function createDbFileArtifact(ctx: StepExecutionContext, input: {
  baseDir: string;
  name: string;
  content: string;
  kind: Artifact["kind"];
  mediaType: string;
  metadata?: Record<string, unknown>;
}) {
  const path = join(input.baseDir, input.name);
  await writeFile(path, input.content);
  const artifact = await ctx.store.createArtifact({
    runId: ctx.runId,
    stepId: ctx.step.id,
    attempt: ctx.step.attempt,
    kind: input.kind,
    name: input.name,
    path,
    uri: artifactUri(ctx, input.name),
    mediaType: input.mediaType,
    metadata: input.metadata
  });
  await publishArtifactEvent(ctx, artifact);
  return artifact;
}

/**
 * Registers a file that already exists on disk (a PostgreSQL log, a build
 * log) in place - it lives under attachmentRoot already, so copying it would
 * only duplicate bytes.
 */
export async function registerDbFileArtifact(ctx: StepExecutionContext, input: {
  name: string;
  path: string;
  kind: Artifact["kind"];
  mediaType: string;
  metadata?: Record<string, unknown>;
}) {
  const artifact = await ctx.store.createArtifact({
    runId: ctx.runId,
    stepId: ctx.step.id,
    attempt: ctx.step.attempt,
    kind: input.kind,
    name: input.name,
    path: input.path,
    uri: artifactUri(ctx, input.name),
    mediaType: input.mediaType,
    metadata: input.metadata
  });
  await publishArtifactEvent(ctx, artifact);
  return artifact;
}

export async function createDbEvidence(
  ctx: StepExecutionContext,
  input: Omit<Partial<Evidence> & Pick<Evidence, "kind">, "runId" | "stepId" | "attempt">
) {
  const evidence = await ctx.store.createEvidence({
    runId: ctx.runId,
    stepId: ctx.step.id,
    attempt: ctx.step.attempt,
    ...input
  });
  await publishEvidenceEvent(ctx, evidence);
  return evidence;
}
