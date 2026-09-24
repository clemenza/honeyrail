/**
 * Issue #237 CLI: runs the paired baseline-vs-candidate Capability Lab
 * experiment for grader-legible observable / reproducer-output construction.
 *
 * Environment:
 *   HONEYRAIL_CAP_GLO_EXPERIMENT_ID   experiment identity (default: timestamped)
 *   HONEYRAIL_CAP_GLO_ARTIFACT_DIR    artifact root (default:
 *                                     output/capability-grader-legible/<experiment-id>).
 *                                     Must be empty or absent: the harness refuses to
 *                                     write into a root that already holds evidence, so
 *                                     a rerun means a new root, never an overwrite.
 *   HONEYRAIL_CAP_GLO_PROVIDER        scripted-demonstration | scripted-self-asserting |
 *                                     scripted-grader-legible | command  (default: scripted-demonstration)
 *   HONEYRAIL_CAP_GLO_AGENT_COMMAND   required when PROVIDER=command; run with the
 *                                     agent-visible workspace as cwd
 *   HONEYRAIL_CAP_GLO_AGENT_ARGS      JSON array of arguments
 *   HONEYRAIL_CAP_GLO_AGENT_ENV       JSON object merged into the agent environment
 *   HONEYRAIL_CAP_GLO_AGENT_TIMEOUT_MS  per-attempt agent budget
 *   HONEYRAIL_CAP_GLO_AGENT_IMAGE     docker image to confine the agent in; without it
 *                                     the agent runs on the host and the run is not
 *                                     capability-eligible. Must already exist locally.
 *   HONEYRAIL_CAP_GLO_AGENT_NETWORK   container network (default: bridge)
 *   HONEYRAIL_CAP_GLO_AGENT_IDENTITY  JSON object {model, agentName, agentVersion,
 *                                     commandIdentity, repositoryCommit} declaring who the
 *                                     agent is. Required for capability eligibility.
 *
 * Capability evidence requires all three: a real agent command, an isolation
 * image, and a declared identity. The scripted providers validate the
 * instrument (materialization, external capture, grading, attribution,
 * pairing) and are reported as such.
 */

import { resolve } from "node:path";
import {
  runGraderLegiblePairedExperiment,
  type GraderLegibleCandidateProvider
} from "../server/capability/grader-legible-run.js";
import {
  SCRIPTED_GRADER_LEGIBLE_PROVIDER,
  SCRIPTED_PAIRED_DEMONSTRATION_PROVIDER,
  SCRIPTED_SELF_ASSERTING_PROVIDER
} from "../server/capability/grader-legible-scripted-agents.js";

const providerName = String(process.env.HONEYRAIL_CAP_GLO_PROVIDER || "scripted-demonstration").trim();
const experimentId = String(
  process.env.HONEYRAIL_CAP_GLO_EXPERIMENT_ID || `cap-glo-${new Date().toISOString().replace(/[:.]/g, "-")}`
).trim();
// Per-experiment by default. The harness refuses to write into an artifact
// root that already holds anything, so a shared default root would make the
// second invocation of this script fail rather than produce a second run.
const artifactRoot = resolve(
  process.env.HONEYRAIL_CAP_GLO_ARTIFACT_DIR || `output/capability-grader-legible/${experimentId}`
);

function resolveProvider(): GraderLegibleCandidateProvider {
  switch (providerName) {
    case "scripted-demonstration":
      return SCRIPTED_PAIRED_DEMONSTRATION_PROVIDER;
    case "scripted-self-asserting":
      return SCRIPTED_SELF_ASSERTING_PROVIDER;
    case "scripted-grader-legible":
      return SCRIPTED_GRADER_LEGIBLE_PROVIDER;
    case "command": {
      const command = String(process.env.HONEYRAIL_CAP_GLO_AGENT_COMMAND || "").trim();
      if (!command) throw new Error("HONEYRAIL_CAP_GLO_AGENT_COMMAND is required when HONEYRAIL_CAP_GLO_PROVIDER=command.");
      const timeoutMs = Number(process.env.HONEYRAIL_CAP_GLO_AGENT_TIMEOUT_MS || 10 * 60_000);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error("HONEYRAIL_CAP_GLO_AGENT_TIMEOUT_MS must be a positive number of milliseconds.");
      }
      const image = String(process.env.HONEYRAIL_CAP_GLO_AGENT_IMAGE || "").trim();
      const identity = process.env.HONEYRAIL_CAP_GLO_AGENT_IDENTITY
        ? (JSON.parse(process.env.HONEYRAIL_CAP_GLO_AGENT_IDENTITY) as Record<string, string>)
        : undefined;
      if (identity) {
        // Validated here rather than at report time: a missing field would
        // otherwise surface as `undefined` inside retained evidence.
        for (const field of ["model", "agentName", "agentVersion", "commandIdentity", "repositoryCommit"]) {
          if (!identity[field]) throw new Error(`HONEYRAIL_CAP_GLO_AGENT_IDENTITY is missing "${field}".`);
        }
      }
      return {
        kind: "command",
        label: `command:${command}`,
        command,
        args: process.env.HONEYRAIL_CAP_GLO_AGENT_ARGS ? JSON.parse(process.env.HONEYRAIL_CAP_GLO_AGENT_ARGS) : [],
        env: process.env.HONEYRAIL_CAP_GLO_AGENT_ENV ? JSON.parse(process.env.HONEYRAIL_CAP_GLO_AGENT_ENV) : undefined,
        timeoutMs,
        isolation: image ? { image, network: process.env.HONEYRAIL_CAP_GLO_AGENT_NETWORK?.trim() || undefined } : undefined,
        realAgentIdentity: identity
          ? {
              model: identity.model,
              agentName: identity.agentName,
              agentVersion: identity.agentVersion,
              commandIdentity: identity.commandIdentity,
              repositoryCommit: identity.repositoryCommit
            }
          : undefined
      };
    }
    default:
      throw new Error(
        `Unknown HONEYRAIL_CAP_GLO_PROVIDER "${providerName}". Use scripted-demonstration, scripted-self-asserting, scripted-grader-legible or command.`
      );
  }
}

const provider = resolveProvider();

// No image preflight here. `runGraderLegiblePairedExperiment()` resolves the
// image identity itself before the first attempt and records the resolved id
// in the report, so a check here would be a second, weaker copy that any other
// caller of the library would miss.
const report = await runGraderLegiblePairedExperiment({ experimentId, artifactRoot, provider });

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(
  "\nPaired capability run summary:\n" +
    `  experiment:                 ${report.experimentId}\n` +
    `  archetype set hash:         ${report.archetypeSetHash}\n` +
    `  paired task-surface hash:   ${report.pairedTaskSurfaceHash}\n` +
    `  provider:                   ${report.providerLabel}\n` +
    `  capability evidence:        ${report.capabilityEvidenceEligible ? "eligible" : "NOT eligible (harness validation only)"}\n` +
    `  agent identity:             ${report.realAgentIdentity ? `${report.realAgentIdentity.agentName} ${report.realAgentIdentity.agentVersion} (${report.realAgentIdentity.model}), isolation ${report.realAgentIdentity.isolationPolicy}` : "undeclared"}\n` +
    report.conditions
      .map(
        (condition) =>
          // D/A first and D/E second, deliberately: the conditional rate reads
          // like a capability number but excludes everything that failed before
          // grading, so it must never be the line a reader sees alone.
          `  ${condition.condition.padEnd(10)} end-to-end budget success (D/A) ` +
          `${condition.graderLegible}/${condition.attempts} = ${condition.endToEndBudgetSuccessRate === null ? "N/A" : condition.endToEndBudgetSuccessRate.toFixed(3)}, ` +
          `conditional grader-legible rate (D/E) ${condition.graderLegible}/${condition.completed} = ` +
          `${condition.graderLegibleRate === null ? "N/A" : condition.graderLegibleRate.toFixed(3)}\n` +
          `  ${" ".repeat(10)} causes ${JSON.stringify(condition.causeCounts)}\n` +
          `  ${" ".repeat(10)} non-capability outcomes ${JSON.stringify(condition.nonCapabilityOutcomes)}, stages ${JSON.stringify(condition.failureStages)}\n`
      )
      .join("") +
    `  artifacts:                  ${artifactRoot}\n`
);

// A run that produced no completed attempt in either condition is an
// infrastructure problem, not a result.
if (report.conditions.every((condition) => condition.completed === 0)) {
  process.exitCode = 1;
}
