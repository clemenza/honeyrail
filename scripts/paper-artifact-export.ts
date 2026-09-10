import { resolve } from "node:path";
import {
  PAPER_ARTIFACT_EXPORT_VERSION,
  defaultPaperArtifactSource,
  exportPaperArtifact
} from "../server/postgres/paper-artifact-export.js";

type CliOptions = {
  experimentId: string;
  sourceDir?: string;
  outputDir: string;
  rawArchiveSha256?: string;
};

function usage(): string {
  return [
    "Usage:",
    "  npm run paper-artifact:export -- --experiment <id> --output <dir> [--source <dir>] [--raw-archive-sha256 <sha256>]",
    "",
    "Supported experiment ids:",
    "  exp216-e0e3-dsh-2026-09-09",
    "  exp222-e0e3-dsh-2026-09-10",
    "",
    "If --source is omitted, the frozen experiment's canonical output/... path is used.",
    `Exporter version: ${PAPER_ARTIFACT_EXPORT_VERSION}`
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  let experimentId = "";
  let sourceDir: string | undefined;
  let outputDir = "";
  let rawArchiveSha256: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}.\n\n${usage()}`);
    if (arg === "--experiment") experimentId = value;
    else if (arg === "--source") sourceDir = value;
    else if (arg === "--output") outputDir = value;
    else if (arg === "--raw-archive-sha256") rawArchiveSha256 = value;
    else throw new Error(`Unknown argument ${arg}.\n\n${usage()}`);
    index += 1;
  }

  if (!experimentId || !outputDir) throw new Error(`--experiment and --output are required.\n\n${usage()}`);
  return { experimentId, sourceDir, outputDir, rawArchiveSha256 };
}

const options = parseArgs(process.argv.slice(2));
const source = resolve(options.sourceDir ?? defaultPaperArtifactSource(options.experimentId));
const output = resolve(options.outputDir);
const result = await exportPaperArtifact({
  experimentId: options.experimentId,
  sourceDir: source,
  outputDir: output,
  rawArchiveSha256: options.rawArchiveSha256
});

process.stdout.write(
  `${JSON.stringify(
    {
      ...result,
      exporterVersion: PAPER_ARTIFACT_EXPORT_VERSION,
      sourceDir: source
    },
    null,
    2
  )}\n`
);
