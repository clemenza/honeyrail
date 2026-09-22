/**
 * Issue #237: freezes the candidate intervention and the TRAIN archetype set
 * into a single content-hashed artifact.
 *
 * This must run (and its output be retained) *before* any reserved family-004
 * transfer validation: #237's exit criteria require the candidate to be
 * content-hashed and frozen first, and to be exportable for that later run
 * without modification. `assertFrozenGraderLegibleIntervention()` on the
 * receiving side re-derives the hash and refuses a body that has drifted.
 *
 * Idempotent and fail-closed: re-running with unchanged inputs rewrites an
 * identical file; re-running after the intervention body or the archetype set
 * changed refuses rather than silently re-freezing under the same identity.
 *
 * Environment:
 *   HONEYRAIL_CAP_GLO_FREEZE_OUTPUT  output path (default: corpus/capability-grader-legible-intervention-v1.json)
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stableJson } from "../server/postgres/historical-task.js";
import {
  GRADER_LEGIBLE_ARCHETYPES,
  graderLegibleArchetypeHash,
  graderLegibleArchetypeSetHash
} from "../server/capability/grader-legible-archetypes.js";
import { exportFrozenGraderLegibleIntervention } from "../server/capability/grader-legible-intervention.js";

const outputPath = resolve(
  process.env.HONEYRAIL_CAP_GLO_FREEZE_OUTPUT || "corpus/capability-grader-legible-intervention-v1.json"
);

const frozen = {
  schemaVersion: 1 as const,
  intervention: exportFrozenGraderLegibleIntervention(),
  trainArchetypeSet: {
    archetypeSetHash: graderLegibleArchetypeSetHash(),
    archetypes: GRADER_LEGIBLE_ARCHETYPES.map((archetype) => ({
      archetypeId: archetype.archetypeId,
      failureClass: archetype.failureClass,
      archetypeHash: graderLegibleArchetypeHash(archetype)
    }))
  },
  notes: [
    "TRAIN only. The archetypes are synthetic fixtures; they reproduce no historical bug, oracle or grader-private tuple.",
    "Transfer validation of this intervention belongs on the separately reserved unseen family-004 path (#229/#230/#232), after this freeze.",
    "Re-deriving interventionHash from interventionId + body is the integrity check; a changed body is a new intervention ID."
  ]
};

const serialized = `${stableJson(frozen)}\n`;
const existing = await readFile(outputPath, "utf8").catch(() => null);
if (existing && existing !== serialized) {
  const previous = JSON.parse(existing);
  throw new Error(
    `${outputPath} already holds a frozen artifact (intervention "${previous?.intervention?.interventionId}", archetype set ${previous?.trainArchetypeSet?.archetypeSetHash}) ` +
      "whose contents differ from what this run would write. Refusing to overwrite a freeze: register a new intervention/archetype-set version instead."
  );
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, serialized);

process.stdout.write(
  `Frozen grader-legible intervention written to ${outputPath}\n` +
    `  interventionId:     ${frozen.intervention.interventionId}\n` +
    `  interventionHash:   ${frozen.intervention.interventionHash}\n` +
    `  archetypeSetHash:   ${frozen.trainArchetypeSet.archetypeSetHash}\n`
);
