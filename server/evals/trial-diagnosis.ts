/**
 * #174 (TrialDiagnosis v0, M1 of #173's roadmap): deterministic pipeline
 * `Trial artifacts -> Test Shape Telemetry -> Required Probe Shape
 * comparison -> TrialDiagnosis`. Core capability-gap determination is
 * deterministic, no LLM in the critical path - same "pure classification
 * logic over already-parsed inputs, no filesystem access" shape as
 * `kill-attribution.ts` (see that module's own docstring).
 *
 * `outcome` vocabulary decision (#174 open question): `TrialDiagnosis.outcome`
 * reuses `DshTrialOutcome` (`dsh-report.ts`) as-is rather than introducing a
 * second, unreconciled vocabulary - a "miss" in the issue's own example maps
 * to `task_failed`/`verify_failed`.
 *
 * `sqlStatements: string[]` contents (non-obvious, documented here since the
 * type alone doesn't convey it): each entry is one `.test`-file *record's*
 * full text - i.e. the optional `statement ok` / `statement error
 * [substring]` header line (SPEC.md "Test Script Format") followed by its
 * SQL body, not just the bare SQL. This preserves each statement's pass/fail
 * *expectation*, the source of `negativeInputTested`/`negativeFkTested`/
 * `negativeObligationTested`, without widening `extractProbeShape`'s
 * signature beyond what #174 specifies. `scripts/tinytable-diagnose.ts`
 * builds this array by splitting `sql-tests/agent/**\/*.test` into
 * blank-line-separated records and keeping each `statement ...` header with
 * its body; `query ...` records (SELECT-only, no schema/constraint signal)
 * are skipped there before this function ever sees them.
 *
 * Extraction is lightweight tokenization (regex + paren-depth scanning) over
 * the SQL grammar in `vendor/tinytable-evals/SPEC.md` - not a real
 * parser/AST, per #174 §3's own scoping.
 *
 * Private truth isolation (#174 §5): `PRIVATE_REQUIRED_PROBE_SHAPES` is
 * keyed by the same `operatorId` `scripts/tinytable-seed-root-builder.ts`'s
 * `SeedRootManifest` already carries as "THE ANSWER - grader-side only;
 * never written into the seed-root" - the same trust boundary
 * `kill-attribution.ts`'s `OperatorMeta` (also `manifest.json`-sourced)
 * already relies on. This map is plain host-side TS source, never
 * materialized into any `seed-root`/`agent-root`; an operator id with no
 * entry here just yields an empty `RequiredProbeShape` (no capability gaps),
 * which is a safe default, not an error.
 */

import { deriveTrajectoryEvents } from "./dsh-trajectory-bridge.js";
import type { DshRawEvent } from "./dsh-session-stats.js";
import type { TranscriptLine } from "./dsh-transcript.js";
import type { DshTrialOutcome } from "./dsh-report.js";
import type { Evidence } from "../types.js";

export type ProbeShape = {
  // structural counts
  tableCount: number;
  columnCount: number;
  constraintCountByKind: Record<"check" | "fk" | "unique" | "not_null" | "pk", number>;
  fkPerTable: Record<string, number>;
  checkPerTable: Record<string, number>;
  indexCount: number;
  // behavioral flags
  checkTested: boolean;
  updateTested: boolean;
  crossColumnDependency: boolean;
  checkReferencedColumns: Record<string, string[]>;
  updateAssignedColumns: Record<string, string[]>;
  partialUpdate: boolean;
  fkTested: boolean;
  negativeFkTested: boolean;
  maxFkPerTable: number;
  // statement-level
  insertPresent: boolean;
  updatePresent: boolean;
  deletePresent: boolean;
  ddlPresent: boolean;
  statementSequenceLength: number;
  nullInputTested: boolean;
  duplicateInputTested: boolean;
  negativeInputTested: boolean;
  positiveObligationTested: boolean;
  negativeObligationTested: boolean;
  transactionUsed: boolean;
  savepointUsed: boolean;
  rollbackUsed: boolean;
  multiObjectInteraction: boolean;
  multiStatementInteraction: boolean;
};

export type RequiredProbeShape = Partial<Record<keyof ProbeShape | "minFkPerTable" | "constraintPositionVariation", boolean | number>>;

export type CapabilityGapTag =
  | "cross-column-dependency"
  | "same-kind-multiplicity"
  | "negative-obligation"
  | "partial-update"
  | "multi-object-interaction"
  | "state-transition"
  | "transaction-sequence";

export type TrialDiagnosis = {
  trialId: string;
  outcome: DshTrialOutcome;
  feature: string;
  observedProbeShapes: Partial<ProbeShape>;
  requiredProbeShapes: RequiredProbeShape;
  capabilityGaps: CapabilityGapTag[];
  evidence: Evidence[];
};

/**
 * #174 §5: per-operator-id required probe shapes, private/evaluator-side
 * only - see this module's own docstring for the trust boundary. Empty for
 * an operator id with no known required shape (safe default: no gaps).
 * Grows as real operators get a documented required shape; not required to
 * be exhaustive for v0.
 */
export const PRIVATE_REQUIRED_PROBE_SHAPES: Record<string, RequiredProbeShape> = {};

// --- lightweight SQL tokenization -------------------------------------------

type StatementRecord = { expectation: "ok" | "error" | null; body: string };

function parseRecord(entry: string): StatementRecord {
  const lines = entry.split("\n");
  const header = /^\s*statement\s+(ok|error)\b/i.exec(lines[0] ?? "");
  if (header) {
    return { expectation: header[1].toLowerCase() as "ok" | "error", body: lines.slice(1).join("\n").trim() };
  }
  return { expectation: null, body: entry.trim() };
}

/** Finds the index of the `)` matching the `(` at `openIdx`, skipping over single-quoted string literals (`''` is an escaped quote). -1 if unmatched. */
function matchParen(text: string, openIdx: number): number {
  let depth = 0;
  let inString = false;
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "'") {
        if (text[i + 1] === "'") {
          i += 1;
          continue;
        }
        inString = false;
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits `text` at top-level (paren-depth 0, outside string literals) occurrences where `boundary` reports a match length > 0. */
function splitTopLevel(text: string, boundary: (text: string, i: number) => number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      if (ch === "'") {
        if (text[i + 1] === "'") {
          i += 2;
          continue;
        }
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === "'") {
      inString = true;
      i += 1;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      i += 1;
      continue;
    }
    if (depth === 0) {
      const matchLen = boundary(text, i);
      if (matchLen > 0) {
        parts.push(text.slice(start, i));
        i += matchLen;
        start = i;
        continue;
      }
    }
    i += 1;
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

const commaBoundary = (text: string, i: number): number => (text[i] === "," ? 1 : 0);

function andOrBoundary(text: string, i: number): number {
  const prev = i === 0 ? "" : text[i - 1];
  if (/[A-Za-z0-9_]/.test(prev)) return 0;
  const m = /^(AND|OR)\b/i.exec(text.slice(i));
  return m ? m[0].length : 0;
}

type BuildCtx = {
  tableCount: number;
  columnCount: number;
  constraintCountByKind: Record<"check" | "fk" | "unique" | "not_null" | "pk", number>;
  fkPerTable: Map<string, number>;
  checkPerTable: Map<string, number>;
  indexCount: number;
  checkReferencedColumns: Record<string, string[]>;
  updateAssignedColumns: Record<string, string[]>;
  crossColumnDependency: boolean;
  partialUpdate: boolean;
  insertPresent: boolean;
  updatePresent: boolean;
  deletePresent: boolean;
  ddlPresent: boolean;
  savepointUsed: boolean;
  rollbackUsed: boolean;
  releaseUsed: boolean;
  commitUsed: boolean;
  nullInputTested: boolean;
  duplicateInputTested: boolean;
  tableColumns: Map<string, Set<string>>;
  touchedTables: Set<string>;
  seenInsertValues: Set<string>;
};

function makeCtx(): BuildCtx {
  return {
    tableCount: 0,
    columnCount: 0,
    constraintCountByKind: { check: 0, fk: 0, unique: 0, not_null: 0, pk: 0 },
    fkPerTable: new Map(),
    checkPerTable: new Map(),
    indexCount: 0,
    checkReferencedColumns: {},
    updateAssignedColumns: {},
    crossColumnDependency: false,
    partialUpdate: false,
    insertPresent: false,
    updatePresent: false,
    deletePresent: false,
    ddlPresent: false,
    savepointUsed: false,
    rollbackUsed: false,
    releaseUsed: false,
    commitUsed: false,
    nullInputTested: false,
    duplicateInputTested: false,
    tableColumns: new Map(),
    touchedTables: new Set(),
    seenInsertValues: new Set()
  };
}

/**
 * `CREATE TABLE t (col_def|table_constraint, ...)` (SPEC.md grammar). Two
 * passes over the element list: column_defs first (to know the table's full
 * declared column set), then CHECK/FOREIGN KEY constraints (so a constraint
 * can reference a column declared anywhere in the same statement, not just
 * earlier in the element list).
 */
function parseCreateTable(body: string, ctx: BuildCtx): void {
  const header = /^CREATE\s+TABLE\s+(\w+)\s*\(/i.exec(body);
  if (!header) return;
  const table = header[1];
  ctx.tableCount += 1;
  const openIdx = header[0].length - 1;
  const closeIdx = matchParen(body, openIdx);
  if (closeIdx === -1) return;
  const elements = splitTopLevel(body.slice(openIdx + 1, closeIdx), commaBoundary);

  const columns = new Set<string>();
  const constraintElements: string[] = [];
  for (const el of elements) {
    if (/^CHECK\s*\(/i.test(el) || /^FOREIGN\s+KEY\s*\(/i.test(el)) {
      constraintElements.push(el);
      continue;
    }
    const colMatch = /^(\w+)\s+(INTEGER|REAL|TEXT|BOOLEAN)\b(\s+NOT\s+NULL)?/i.exec(el);
    if (colMatch) {
      columns.add(colMatch[1]);
      ctx.columnCount += 1;
      if (colMatch[3]) ctx.constraintCountByKind.not_null += 1;
    }
  }
  ctx.tableColumns.set(table, columns);

  for (const el of constraintElements) {
    if (/^CHECK\s*\(/i.test(el)) {
      const openI = el.indexOf("(");
      const closeI = matchParen(el, openI);
      const predicate = closeI === -1 ? el.slice(openI + 1) : el.slice(openI + 1, closeI);
      const clauses = splitTopLevel(predicate, andOrBoundary);
      const idx = (ctx.checkPerTable.get(table) ?? 0) + 1;
      ctx.checkPerTable.set(table, idx);
      ctx.constraintCountByKind.check += 1;
      const allRefs = new Set<string>();
      for (const clause of clauses) {
        const idents = clause.match(/\b[A-Za-z_]\w*\b/g) ?? [];
        const refCols = new Set(idents.filter((id) => columns.has(id)));
        for (const c of refCols) allRefs.add(c);
        if (refCols.size >= 2) ctx.crossColumnDependency = true;
      }
      ctx.checkReferencedColumns[`${table}.check${idx}`] = [...allRefs];
    } else {
      ctx.fkPerTable.set(table, (ctx.fkPerTable.get(table) ?? 0) + 1);
      ctx.constraintCountByKind.fk += 1;
    }
  }
}

function parseCreateIndex(body: string, ctx: BuildCtx): void {
  const m = /^CREATE\s+(UNIQUE\s+)?INDEX\b/i.exec(body);
  if (!m) return;
  ctx.indexCount += 1;
  if (m[1]) ctx.constraintCountByKind.unique += 1;
}

function parseInsert(body: string, ctx: BuildCtx): void {
  const m = /^INSERT\s+INTO\s+(\w+)/i.exec(body);
  if (!m) return;
  ctx.insertPresent = true;
  ctx.touchedTables.add(m[1]);
  const valuesMatch = /VALUES\s*(\([\s\S]*\))\s*$/i.exec(body);
  if (valuesMatch) {
    const key = `${m[1]}::${valuesMatch[1].replace(/\s+/g, " ").trim()}`;
    if (ctx.seenInsertValues.has(key)) ctx.duplicateInputTested = true;
    ctx.seenInsertValues.add(key);
  }
  if (/\bNULL\b/i.test(body)) ctx.nullInputTested = true;
}

function parseUpdate(body: string, ctx: BuildCtx, updateIdx: number): void {
  const m = /^UPDATE\s+(\w+)\s+SET\s+([\s\S]+?)(?:\s+WHERE\s+[\s\S]+)?$/i.exec(body);
  if (!m) return;
  ctx.updatePresent = true;
  const table = m[1];
  ctx.touchedTables.add(table);
  const cols: string[] = [];
  for (const assignment of splitTopLevel(m[2], commaBoundary)) {
    const am = /^(\w+)\s*=/.exec(assignment);
    if (am) cols.push(am[1]);
  }
  ctx.updateAssignedColumns[`${table}.update${updateIdx}`] = cols;
  const knownCols = ctx.tableColumns.get(table);
  if (knownCols && cols.length > 0 && cols.length < knownCols.size) ctx.partialUpdate = true;
  if (/\bNULL\b/i.test(body)) ctx.nullInputTested = true;
}

function parseDelete(body: string, ctx: BuildCtx): void {
  const m = /^DELETE\s+FROM\s+(\w+)/i.exec(body);
  if (!m) return;
  ctx.deletePresent = true;
  ctx.touchedTables.add(m[1]);
}

const FAILURE_MARKER_RE = /\bFAIL\b|\bfailure\(s\)|AssertionError|expected[^\n]{0,80}actual|assert(?:ion)? (?:error|failed)/i;

/** Best-effort reinforcement signal from the transcript: did the agent's own `run_sql_tests.py` run against `sql-tests/agent` come back clean at least once? Not required for either golden case, but gives the `transcript` parameter real use beyond being unused. */
function hasOwnPassingTestRun(transcript: TranscriptLine[]): boolean {
  const raw: DshRawEvent[] = transcript.map((line) => ({ type: line.type, time: line.ts ? Date.parse(line.ts) : 0, data: line.data }));
  const derived = deriveTrajectoryEvents(raw);
  for (const event of derived) {
    if (event.kind !== "shell_command") continue;
    const command = typeof event.command === "string" ? event.command : "";
    if (!command.includes("run_sql_tests.py") || !/sql-tests\/agent\b/.test(command)) continue;
    const output = `${typeof event.stdout === "string" ? event.stdout : ""}\n${typeof event.stderr === "string" ? event.stderr : ""}`;
    if (!FAILURE_MARKER_RE.test(output)) return true;
  }
  return false;
}

/**
 * Test Shape Telemetry extractor (#174 §3): turns an agent's own
 * `sql-tests/agent/*.test` records (`sqlStatements`, see this module's
 * docstring for their exact shape) plus its `transcript.ndjson` into a
 * `ProbeShape`. Deterministic, no LLM.
 */
export function extractProbeShape(transcript: TranscriptLine[], sqlStatements: string[]): ProbeShape {
  const ctx = makeCtx();
  let updateIdx = 0;
  let statementCount = 0;
  let anyErrorRecord = false;
  let negativeFkTested = false;
  let positiveObligationTested = false;

  for (const raw of sqlStatements) {
    const { expectation, body } = parseRecord(raw);
    const isStatement = /^(CREATE|INSERT|UPDATE|DELETE|SAVEPOINT|ROLLBACK|RELEASE|COMMIT)\b/i.test(body);
    if (!isStatement) continue; // e.g. a bare "query" record - no schema/constraint signal
    statementCount += 1;
    if (expectation === "error") anyErrorRecord = true;

    if (/^CREATE\s+TABLE\b/i.test(body)) {
      ctx.ddlPresent = true;
      parseCreateTable(body, ctx);
    } else if (/^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(body)) {
      ctx.ddlPresent = true;
      parseCreateIndex(body, ctx);
    } else if (/^INSERT\b/i.test(body)) {
      parseInsert(body, ctx);
    } else if (/^UPDATE\b/i.test(body)) {
      updateIdx += 1;
      parseUpdate(body, ctx, updateIdx);
    } else if (/^DELETE\b/i.test(body)) {
      parseDelete(body, ctx);
    } else if (/^SAVEPOINT\b/i.test(body)) {
      ctx.savepointUsed = true;
    } else if (/^ROLLBACK\s+TO\b/i.test(body)) {
      ctx.rollbackUsed = true;
    } else if (/^RELEASE\b/i.test(body)) {
      ctx.releaseUsed = true;
    } else if (/^COMMIT\b/i.test(body)) {
      ctx.commitUsed = true;
    }

    const targetMatch = /^(?:INSERT\s+INTO|UPDATE)\s+(\w+)/i.exec(body);
    const targetTable = targetMatch?.[1];
    if (targetTable) {
      const hasConstraint = (ctx.checkPerTable.get(targetTable) ?? 0) > 0 || (ctx.fkPerTable.get(targetTable) ?? 0) > 0;
      if (expectation === "error" && (ctx.fkPerTable.get(targetTable) ?? 0) > 0) negativeFkTested = true;
      if (expectation === "ok" && hasConstraint) positiveObligationTested = true;
    }
  }

  if (!positiveObligationTested && hasOwnPassingTestRun(transcript)) positiveObligationTested = true;

  const fkValues = [...ctx.fkPerTable.values()];
  const maxFkPerTable = fkValues.length ? Math.max(...fkValues) : 0;
  const fkPerTable: Record<string, number> = {};
  for (const [table, count] of ctx.fkPerTable) fkPerTable[table] = count;
  const checkPerTable: Record<string, number> = {};
  for (const [table, count] of ctx.checkPerTable) checkPerTable[table] = count;

  return {
    tableCount: ctx.tableCount,
    columnCount: ctx.columnCount,
    constraintCountByKind: ctx.constraintCountByKind,
    fkPerTable,
    checkPerTable,
    indexCount: ctx.indexCount,
    checkTested: ctx.constraintCountByKind.check > 0,
    updateTested: ctx.updatePresent,
    crossColumnDependency: ctx.crossColumnDependency,
    checkReferencedColumns: ctx.checkReferencedColumns,
    updateAssignedColumns: ctx.updateAssignedColumns,
    partialUpdate: ctx.partialUpdate,
    fkTested: ctx.constraintCountByKind.fk > 0,
    negativeFkTested,
    maxFkPerTable,
    insertPresent: ctx.insertPresent,
    updatePresent: ctx.updatePresent,
    deletePresent: ctx.deletePresent,
    ddlPresent: ctx.ddlPresent,
    statementSequenceLength: statementCount,
    nullInputTested: ctx.nullInputTested,
    duplicateInputTested: ctx.duplicateInputTested,
    negativeInputTested: anyErrorRecord,
    positiveObligationTested,
    // v0 simplification: no signal in a synthetic .test-record corpus
    // distinguishes "negative obligation" (an explicit rejection
    // requirement) from "negative input" (any statement error record) - see
    // this module's docstring on sqlStatements' shape. Revisit once a
    // richer per-record annotation is available.
    negativeObligationTested: anyErrorRecord,
    transactionUsed: ctx.savepointUsed || ctx.rollbackUsed || ctx.releaseUsed || ctx.commitUsed,
    savepointUsed: ctx.savepointUsed,
    rollbackUsed: ctx.rollbackUsed,
    multiObjectInteraction: ctx.touchedTables.size >= 2,
    multiStatementInteraction: statementCount > 1
  };
}

// --- capability gap model (#174 §6) -----------------------------------------

type GapCheck = { tag: CapabilityGapTag; hasGap: (required: RequiredProbeShape, observed: ProbeShape) => boolean };

/**
 * Exactly the seven v0 tags (#174 §6), each a small named function - no
 * general ontology/rule engine. `same-kind-multiplicity` covers FK
 * multiplicity specifically (the issue's own golden case B); a future tag
 * would be needed for a different "same kind, more than N" axis rather than
 * overloading this one.
 */
const GAP_CHECKS: GapCheck[] = [
  { tag: "cross-column-dependency", hasGap: (r, o) => r.crossColumnDependency === true && o.crossColumnDependency !== true },
  { tag: "same-kind-multiplicity", hasGap: (r, o) => typeof r.minFkPerTable === "number" && (o.maxFkPerTable ?? 0) < r.minFkPerTable },
  { tag: "negative-obligation", hasGap: (r, o) => r.negativeObligationTested === true && o.negativeObligationTested !== true },
  { tag: "partial-update", hasGap: (r, o) => r.partialUpdate === true && o.partialUpdate !== true },
  { tag: "multi-object-interaction", hasGap: (r, o) => r.multiObjectInteraction === true && o.multiObjectInteraction !== true },
  { tag: "state-transition", hasGap: (r, o) => r.rollbackUsed === true && o.rollbackUsed !== true },
  { tag: "transaction-sequence", hasGap: (r, o) => r.transactionUsed === true && o.transactionUsed !== true }
];

/** Pure diff: `Required Probe Shape - Observed Probe Shape = Capability Gap` (#174 §6). No LLM. */
export function diagnoseTrial(
  observed: ProbeShape,
  required: RequiredProbeShape,
  trial: { trialId: string; outcome: DshTrialOutcome; feature: string },
  evidence: Evidence[]
): TrialDiagnosis {
  const capabilityGaps = GAP_CHECKS.filter((check) => check.hasGap(required, observed)).map((check) => check.tag);
  return {
    trialId: trial.trialId,
    outcome: trial.outcome,
    feature: trial.feature,
    observedProbeShapes: observed,
    requiredProbeShapes: required,
    capabilityGaps,
    evidence
  };
}
