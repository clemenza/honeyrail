import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  historicalPostgres001TaskSpec,
  historicalPostgres002TaskSpec,
  historicalPostgres003TaskSpec,
  loadHistoricalPostgres003PrivateTruth,
  materializeHistoricalPostgresTask
} from "../server/postgres/historical-task.js";
import { buildHistoricalPostgresCorpusManifest, buildHistoricalPostgresCorpusTaskEntry } from "../server/postgres/historical-corpus.js";

/**
 * Issue #201: freezes Corpus v0 (Tasks 001-003) into a single versioned,
 * hashable manifest. Requires the real local PostgreSQL mirror (and, for case
 * 003, operator-supplied private truth) for all three tasks - a partial
 * freeze is refused, loudly, rather than silently freezing an incomplete
 * corpus. Never writes truth/revisions/upstream-bug-identity anywhere: it
 * only ever reads each task's already-sanitized `task-manifest.json` /
 * `reference-manifest.json` via `buildHistoricalPostgresCorpusTaskEntry()`.
 */

function requiredEnv(name: string): string {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required to freeze Corpus v0 - a partial freeze is not permitted.`);
  return value;
}

const mirror184 = requiredEnv("HONEYRAIL_PG_184_MIRROR");
const reproducer184 = String(process.env.HONEYRAIL_PG_184_REPRODUCER || "").trim();

const mirror200 = requiredEnv("HONEYRAIL_PG_200_MIRROR");
const reproducer200 = requiredEnv("HONEYRAIL_PG_200_REPRODUCER");

const mirror199 = requiredEnv("HONEYRAIL_PG_199_MIRROR");
const reproducer199 = requiredEnv("HONEYRAIL_PG_199_REPRODUCER");
const privateTruthPath199 = requiredEnv("HONEYRAIL_PG_199_PRIVATE_TRUTH");

const corpusId = String(process.env.HONEYRAIL_PG_201_CORPUS_ID || "historical-postgres-corpus-v0").trim();
const outputPath = resolve(String(process.env.HONEYRAIL_PG_201_OUTPUT || "corpus/historical-postgres-corpus-v0.json"));

const root = await mkdtemp(join(tmpdir(), "honeyrail-pg201-freeze-"));

const privateTruth199 = await loadHistoricalPostgres003PrivateTruth(privateTruthPath199);

const specs = [
  { spec: historicalPostgres001TaskSpec(resolve(mirror184), reproducer184 ? resolve(reproducer184) : undefined), provenanceReferences: ["#178", "#184", "#185", "#201"] },
  { spec: historicalPostgres002TaskSpec(resolve(mirror200), resolve(reproducer200)), provenanceReferences: ["#178", "#185", "#200", "#201"] },
  { spec: historicalPostgres003TaskSpec(resolve(mirror199), privateTruth199, resolve(reproducer199)), provenanceReferences: ["#178", "#185", "#199", "#201"] }
];

const entries = [];
for (const { spec, provenanceReferences } of specs) {
  const layout = await materializeHistoricalPostgresTask(spec, join(root, spec.taskId));
  entries.push(buildHistoricalPostgresCorpusTaskEntry(layout, provenanceReferences));
}

const freezeDate = String(process.env.HONEYRAIL_PG_201_FREEZE_DATE || new Date().toISOString()).trim();
const manifest = buildHistoricalPostgresCorpusManifest({ corpusId, freezeDate, tasks: entries });

await mkdir(join(outputPath, ".."), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);

process.stdout.write(`Wrote frozen Corpus v0 manifest to ${outputPath}\n\n`);
process.stdout.write(`corpusId:    ${manifest.corpusId}\n`);
process.stdout.write(`freezeDate:  ${manifest.freezeDate}\n`);
process.stdout.write(`corpusHash:  ${manifest.corpusHash}\n\n`);
for (const task of manifest.tasks) {
  process.stdout.write(
    `  ${task.taskId} [${task.partition}] gradingProtocol=${task.gradingProtocol}\n` +
      `    sourceSnapshotHash=${task.sourceSnapshotHash}\n` +
      `    taskDefinitionHash=${task.taskDefinitionHash}\n` +
      `    truthBundleHash=${task.truthBundleHash}\n`
  );
}
