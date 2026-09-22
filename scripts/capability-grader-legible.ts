/**
 * Issue #237 CLI: runs the paired baseline-vs-candidate Capability Lab
 * experiment for grader-legible observable / reproducer-output construction.
 *
 * Environment:
 *   HONEYRAIL_CAP_GLO_EXPERIMENT_ID   experiment identity (default: timestamped)
 *   HONEYRAIL_CAP_GLO_ARTIFACT_DIR    artifact root (default: output/capability-grader-legible)
 *   HONEYRAIL_CAP_GLO_PROVIDER        scripted-demonstration | scripted-self-asserting |
 *                                     scripted-grader-legible | command  (default: scripted-demonstration)
 *   HONEYRAIL_CAP_GLO_AGENT_COMMAND   required when PROVIDER=command; run with the
 *                                     agent-visible workspace as cwd
 *   HONEYRAIL_CAP_GLO_AGENT_ARGS      JSON array of arguments
 *   HONEYRAIL_CAP_GLO_AGENT_ENV       JSON object merged into the agent environment
 *   HONEYRAIL_CAP_GLO_AGENT_TIMEOUT_MS  per-attempt agent budget
 *
 * Only `PROVIDER=command` produces capability evidence. The scripted providers
 * validate the instrument (materialization, external capture, grading,
 * attribution, pairing) and are reported as such.
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
const artifactRoot = resolve(process.env.HONEYRAIL_CAP_GLO_ARTIFACT_DIR || "output/capability-grader-legible");
const experimentId = String(
  process.env.HONEYRAIL_CAP_GLO_EXPERIMENT_ID || `cap-glo-${new Date().toISOString().replace(/[:.]/g, "-")}`
).trim();

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
      return {
        kind: "command",
        label: `command:${command}`,
        command,
        args: process.env.HONEYRAIL_CAP_GLO_AGENT_ARGS ? JSON.parse(process.env.HONEYRAIL_CAP_GLO_AGENT_ARGS) : [],
        env: process.env.HONEYRAIL_CAP_GLO_AGENT_ENV ? JSON.parse(process.env.HONEYRAIL_CAP_GLO_AGENT_ENV) : undefined,
        timeoutMs
      };
    }
    default:
      throw new Error(
        `Unknown HONEYRAIL_CAP_GLO_PROVIDER "${providerName}". Use scripted-demonstration, scripted-self-asserting, scripted-grader-legible or command.`
      );
  }
}

const report = await runGraderLegiblePairedExperiment({ experimentId, artifactRoot, provider: resolveProvider() });

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(
  "\nPaired capability run summary:\n" +
    `  experiment:                 ${report.experimentId}\n` +
    `  archetype set hash:         ${report.archetypeSetHash}\n` +
    `  paired task-surface hash:   ${report.pairedTaskSurfaceHash}\n` +
    `  provider:                   ${report.providerLabel}\n` +
    `  capability evidence:        ${report.capabilityEvidenceEligible ? "eligible" : "NOT eligible (harness validation only)"}\n` +
    report.conditions
      .map(
        (condition) =>
          `  ${condition.condition.padEnd(10)} grader-legible ${condition.graderLegible}/${condition.completed} completed ` +
          `(rate ${condition.graderLegibleRate === null ? "N/A" : condition.graderLegibleRate.toFixed(3)}), ` +
          `non-capability outcomes ${JSON.stringify(condition.nonCapabilityOutcomes)}, stages ${JSON.stringify(condition.failureStages)}\n`
      )
      .join("") +
    `  artifacts:                  ${artifactRoot}\n`
);

// A run that produced no completed attempt in either condition is an
// infrastructure problem, not a result.
if (report.conditions.every((condition) => condition.completed === 0)) {
  process.exitCode = 1;
}
