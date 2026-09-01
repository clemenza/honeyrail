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
 * materialized into any `seed-root`/`agent-root`.
 *
 * "Unknown operator" vs. "known operator, genuinely no gap" (review fix,
 * see `lookupRequiredProbeShape`): an operator id with no registry entry
 * must NOT be silently reported as "capability gaps: none" - that is
 * indistinguishable from a real clean pass and would let an unconfigured
 * operator look diagnosed when it never was. `lookupRequiredProbeShape`
 * returns an explicit `required-shape-unavailable` `Evidence` entry in that
 * case instead of a bare empty shape; callers (`scripts/tinytable-diagnose.ts`)
 * must use it rather than reading `PRIVATE_REQUIRED_PROBE_SHAPES` directly.
 *
 * `trial-diagnosis.json`'s on-disk schema is snake_case (#174 §7's own
 * output contract) while `TrialDiagnosis` is camelCase - `encodeTrialDiagnosis`/
 * `decodeTrialDiagnosis` are the single source of truth for that boundary;
 * nothing else should hand-rebuild either direction.
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
  /**
   * Review fix round 2 (P0): `crossColumnDependency` alone (a single ATOMIC
   * clause referencing >=2 columns, e.g. `CHECK (a > b)`) is deliberately
   * narrow - it must stay exactly that narrow so golden case A
   * (`CHECK (a > 10 AND b > 10)` is per-column decomposable, not
   * cross-column) keeps holding. `check-on-update-sees-only-assigned-columns`'s
   * real discriminating shape is different: a CHECK whose overall reference
   * set spans >=2 columns REGARDLESS of clause structure
   * (`multiColumnCheck`), composed with `OR` at the top level
   * (`orComposition` - only an `OR` lets one operand's spurious UNKNOWN
   * survive to make the whole predicate pass), where a partial `UPDATE`
   * leaves at least one of those referenced columns unassigned
   * (`checkReferencesUnassignedColumn`). All three are required together -
   * see `PRIVATE_REQUIRED_PROBE_SHAPES`'s own comment for the worked
   * example and why an `AND`-only composition does NOT distinguish this
   * mutant (an `AND` operand that's genuinely `FALSE` short-circuits
   * correctly even under the bug).
   */
  multiColumnCheck: boolean;
  /** True once some CHECK constraint's own predicate has a top-level `OR` (after unwrapping only the predicate's own fully-enclosing parens - not recursive into nested groups; see `containsTopLevelOr`). */
  orComposition: boolean;
  /** True once an `UPDATE`'s assigned-column set omits a column referenced by some CHECK constraint declared on that table - the shape that exercises `check-on-update-sees-only-assigned-columns`'s "reads as NULL because unassigned" bug. */
  checkReferencesUnassignedColumn: boolean;
  checkReferencedColumns: Record<string, string[]>;
  updateAssignedColumns: Record<string, string[]>;
  partialUpdate: boolean;
  fkTested: boolean;
  negativeFkTested: boolean;
  maxFkPerTable: number;
  /**
   * Review fix round 2 (P0): `maxFkPerTable >= 2` alone is necessary but not
   * sufficient for `fk-only-last-declared-constraint-registered` - the
   * mutant keeps only the LAST declared FK, so an agent can have two FKs and
   * still never distinguish the mutant if every negative test violates the
   * (correctly-enforced) last one. True once some `statement error`
   * INSERT/UPDATE is found that satisfies a table's last-declared FK while
   * violating an earlier-declared one (existence checked against values
   * already `INSERT`ed into the referenced table/column - see
   * `evaluateFkSatisfaction`).
   */
  nonLastFkViolationTested: boolean;
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

/**
 * Review fix (P1): `constraintPositionVariation` was part of #174's own
 * type sketch but had no observed-telemetry field or `GAP_CHECKS`
 * comparator behind it - a required-shape key a caller could set that could
 * never actually produce a gap. Removed until a real signal + comparator is
 * implemented (a required-shape field must never be silently ignored)
 * rather than shipping it as a no-op key. Re-add together with its
 * comparator if/when "constraints declared in varying element-list
 * positions" becomes a real v0 signal.
 */
export type RequiredProbeShape = Partial<Record<keyof ProbeShape | "minFkPerTable", boolean | number>>;

export type CapabilityGapTag =
  | "cross-column-dependency"
  | "same-kind-multiplicity"
  | "negative-obligation"
  | "partial-update"
  | "multi-object-interaction"
  | "state-transition"
  | "transaction-sequence";

/**
 * Review fix round 2 (P1): makes diagnosis validity first-class instead of
 * encoded indirectly through `Evidence[]` (a consumer reading only
 * `capabilityGaps` could otherwise mistake "never actually checked" or "this
 * trial's own data isn't trustworthy" for a genuine clean pass).
 * - `complete` - a configured required shape was compared against a
 *   trustworthy observed shape; `capabilityGaps` is meaningful.
 * - `required_shape_unavailable` - no `PRIVATE_REQUIRED_PROBE_SHAPES` entry
 *   for this operator (see `lookupRequiredProbeShape`); `capabilityGaps` is
 *   computed against an empty required shape and is NOT meaningful evidence
 *   of a clean pass.
 * - `ineligible` - the trial's own `outcome` is `blocked`/`invalidated`/
 *   `driver_error`; its observed probe shape reflects a run that never
 *   produced trustworthy data to diagnose in the first place.
 * Deliberately not a large state machine - three states, no transitions.
 */
export type DiagnosisStatus = "complete" | "required_shape_unavailable" | "ineligible";

export type TrialDiagnosis = {
  trialId: string;
  outcome: DshTrialOutcome;
  feature: string;
  observedProbeShapes: Partial<ProbeShape>;
  requiredProbeShapes: RequiredProbeShape;
  capabilityGaps: CapabilityGapTag[];
  evidence: Evidence[];
  diagnosisStatus: DiagnosisStatus;
};

/**
 * #174 §5: per-operator-id required probe shapes, private/evaluator-side
 * only - see this module's own docstring for the trust boundary and for
 * `lookupRequiredProbeShape`, the required way to read this map (an id with
 * no entry is NOT the same as "no gap"). Seeded with the two real
 * `vendor/tinytable-evals` operators that motivated #174 (`mutate.py`'s own
 * `notes=` fields, quoted below); not required to be exhaustive for v0.
 */
export const PRIVATE_REQUIRED_PROBE_SHAPES: Record<string, RequiredProbeShape> = {
  // mutate.py: "Killing it needs three tables and a child declaring two
  // FKs - one obvious single-FK test still passes." Review fix round 2:
  // minFkPerTable alone is necessary but not sufficient - the mutant keeps
  // only the LAST declared FK, so two FKs where every negative test happens
  // to violate the (correctly-enforced) last one still never distinguishes
  // it. nonLastFkViolationTested is the missing second dimension: a
  // statement error that satisfies the last FK while violating an earlier
  // one.
  "fk-only-last-declared-constraint-registered": { minFkPerTable: 2, nonLastFkViolationTested: true },
  // mutate.py: "CHECK is re-validated on UPDATE against the assignment list
  // alone rather than the merged row, so every column the UPDATE doesn't
  // touch reads as NULL - unknown, therefore passing. Only an UPDATE whose
  // *untouched* column is the one carrying the constraint (e.g. the
  // surviving disjunct of an OR-CHECK) distinguishes it."
  //
  // Worked example of why all three fields below are required together, not
  // crossColumnDependency alone (review fix round 2):
  //   CREATE TABLE t (a INTEGER, b INTEGER, CHECK (a > 10 OR b > 10))
  //   INSERT INTO t VALUES (5, 20)                -- a fails, b passes
  //   statement error
  //   UPDATE t SET b = 5 WHERE a = 5               -- b now fails too
  // Real (merged-row) evaluation: a=5, b=5 -> (a>10 OR b>10) = FALSE OR
  // FALSE = FALSE -> correctly rejected. Mutant (assignment-list-only)
  // evaluation: only b=5 is in scope, a reads as NULL -> UNKNOWN(a>10) OR
  // FALSE(b>10) = UNKNOWN -> a CHECK's own 3VL rule treats UNKNOWN as
  // passing, same as a real, non-buggy CHECK would for a genuinely
  // ambiguous predicate - the bug is which columns get evaluated, not the
  // 3VL rule itself - so the mutant wrongly lets the UPDATE through.
  // An AND-only composition does NOT distinguish this mutant: if any AND
  // operand is genuinely FALSE, three-valued AND short-circuits to FALSE
  // regardless of an UNKNOWN sibling, so the mutant still correctly
  // rejects - orComposition is therefore a real necessary condition, not
  // an optional nice-to-have.
  "check-on-update-sees-only-assigned-columns": {
    multiColumnCheck: true,
    orComposition: true,
    checkReferencesUnassignedColumn: true,
    partialUpdate: true
  }
};

/**
 * The required way to read `PRIVATE_REQUIRED_PROBE_SHAPES` (review fix,
 * P0): an operator id with no registry entry returns an explicit
 * `required-shape-unavailable` `Evidence` entry instead of silently
 * defaulting to `{}` (which `diagnoseTrial` would then report as "capability
 * gaps: none" - indistinguishable from a real clean pass). Callers must
 * pass the returned `evidence` through to `diagnoseTrial` so a report reader
 * can tell "checked, no gap" apart from "never actually checked".
 */
export function lookupRequiredProbeShape(operatorId: string): { shape: RequiredProbeShape; evidence: Evidence[] } {
  if (Object.prototype.hasOwnProperty.call(PRIVATE_REQUIRED_PROBE_SHAPES, operatorId)) {
    return { shape: PRIVATE_REQUIRED_PROBE_SHAPES[operatorId], evidence: [] };
  }
  return {
    shape: {},
    evidence: [
      {
        id: `required-shape-unavailable-${operatorId || "unknown"}`,
        runId: operatorId || "unknown",
        kind: "required-shape-unavailable",
        claim: `No PRIVATE_REQUIRED_PROBE_SHAPES entry for operator "${operatorId || "unknown"}" - capability gaps could not be determined (absence of evaluator truth, not absence of a gap).`,
        createdAt: new Date().toISOString()
      }
    ]
  };
}

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

function orOnlyBoundary(text: string, i: number): number {
  const prev = i === 0 ? "" : text[i - 1];
  if (/[A-Za-z0-9_]/.test(prev)) return 0;
  const m = /^OR\b/i.exec(text.slice(i));
  return m ? m[0].length : 0;
}

/**
 * True once a CHECK predicate's own top level (after unwrapping only its
 * own fully-enclosing parens) splits into >1 part on `OR`. Deliberately
 * shallow - checks the predicate's outermost structure only, not every `OR`
 * anywhere in the tree (an `OR` nested inside a top-level `AND`, e.g.
 * `(a > 5 OR b > 5) AND c > 5`, is invisible to this check) - matching the
 * v0 scope of a "small, named" signal per #174 §6, not a full boolean-tree
 * classifier.
 */
function containsTopLevelOr(predicate: string): boolean {
  const unwrapped = unwrapOuterParens(predicate);
  return splitTopLevel(unwrapped, orOnlyBoundary).length > 1;
}

/** Strips every fully-enclosing balanced paren pair (`((x))` -> `x`), not just one layer. */
function unwrapOuterParens(text: string): string {
  let s = text.trim();
  while (s.startsWith("(") && matchParen(s, 0) === s.length - 1) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

/**
 * Review fix (P1): a naive single top-level `AND`/`OR` split treats
 * `CHECK ((a > 10 AND b > 10))` as one clause containing both `a` and `b`
 * (the `AND` sits at paren-depth 1, below the outer group), falsely flagging
 * `crossColumnDependency` for a predicate that's semantically identical to
 * the un-parenthesized, correctly-decomposable `CHECK (a > 10 AND b > 10)`.
 * Recursively unwraps fully-enclosing parens and re-splits on `AND`/`OR`
 * until reaching atomic comparisons (no further top-level `AND`/`OR`, no
 * further full-wrap to strip) - the leaves are what "does this one
 * comparison reference >=2 columns" (`CHECK (a > b)`, including
 * `((a > b))`) should actually be asked about, not an arbitrarily
 * parenthesized substring.
 */
function extractAtomicClauses(predicate: string): string[] {
  const unwrapped = unwrapOuterParens(predicate);
  if (unwrapped === "") return [];
  const clauses = splitTopLevel(unwrapped, andOrBoundary);
  if (clauses.length <= 1) return [unwrapped];
  return clauses.flatMap((clause) => extractAtomicClauses(clause));
}

type FkConstraint = { fkColumn: string; referencedTable: string; referencedColumn: string };

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
  multiColumnCheck: boolean;
  orComposition: boolean;
  checkReferencesUnassignedColumn: boolean;
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
  nonLastFkViolationTested: boolean;
  tableColumns: Map<string, Set<string>>;
  /** Declared column order per table, from CREATE TABLE - what a column-list-omitted `INSERT INTO t VALUES (...)` positionally maps against (SPEC.md). */
  tableColumnOrder: Map<string, string[]>;
  /** Columns referenced by ANY CHECK constraint declared on a table (union across all of that table's CHECK constraints) - checkReferencesUnassignedColumn's own reference set. */
  checkRelevantColumns: Map<string, Set<string>>;
  /** FK constraints per table, in CREATE TABLE declaration order - order is load-bearing for nonLastFkViolationTested (which one is "last"). */
  fkConstraintsByTable: Map<string, FkConstraint[]>;
  /** Distinct literal value text INSERTed so far into a given "table.column" - the running "does this value exist in the referenced table" ledger evaluateFkSatisfaction reads. Only INSERT populates this (v0 simplification - an UPDATE to a referenced column isn't tracked). */
  insertedValuesByTableColumn: Map<string, Set<string>>;
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
    multiColumnCheck: false,
    orComposition: false,
    checkReferencesUnassignedColumn: false,
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
    nonLastFkViolationTested: false,
    tableColumns: new Map(),
    tableColumnOrder: new Map(),
    checkRelevantColumns: new Map(),
    fkConstraintsByTable: new Map(),
    insertedValuesByTableColumn: new Map(),
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
  const columnOrder: string[] = [];
  const constraintElements: string[] = [];
  for (const el of elements) {
    if (/^CHECK\s*\(/i.test(el) || /^FOREIGN\s+KEY\s*\(/i.test(el)) {
      constraintElements.push(el);
      continue;
    }
    const colMatch = /^(\w+)\s+(INTEGER|REAL|TEXT|BOOLEAN)\b(\s+NOT\s+NULL)?/i.exec(el);
    if (colMatch) {
      columns.add(colMatch[1]);
      columnOrder.push(colMatch[1]);
      ctx.columnCount += 1;
      if (colMatch[3]) ctx.constraintCountByKind.not_null += 1;
    }
  }
  ctx.tableColumns.set(table, columns);
  ctx.tableColumnOrder.set(table, columnOrder);

  for (const el of constraintElements) {
    if (/^CHECK\s*\(/i.test(el)) {
      const openI = el.indexOf("(");
      const closeI = matchParen(el, openI);
      const predicate = closeI === -1 ? el.slice(openI + 1) : el.slice(openI + 1, closeI);
      const clauses = extractAtomicClauses(predicate);
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
      // Review fix round 2: multiColumnCheck is the UNION of every clause's
      // referenced columns across the whole predicate, deliberately broader
      // than crossColumnDependency's per-atomic-clause definition above -
      // see ProbeShape.multiColumnCheck's own doc-comment for why these must
      // stay two separate fields, not one broadened one.
      if (allRefs.size >= 2) ctx.multiColumnCheck = true;
      const relevant = ctx.checkRelevantColumns.get(table) ?? new Set<string>();
      for (const c of allRefs) relevant.add(c);
      ctx.checkRelevantColumns.set(table, relevant);
      if (containsTopLevelOr(predicate)) ctx.orComposition = true;
    } else {
      const fkMatch = /^FOREIGN\s+KEY\s*\(\s*(\w+)\s*\)\s*REFERENCES\s+(\w+)\s*\(\s*(\w+)\s*\)/i.exec(el);
      ctx.fkPerTable.set(table, (ctx.fkPerTable.get(table) ?? 0) + 1);
      ctx.constraintCountByKind.fk += 1;
      if (fkMatch) {
        const list = ctx.fkConstraintsByTable.get(table) ?? [];
        list.push({ fkColumn: fkMatch[1], referencedTable: fkMatch[2], referencedColumn: fkMatch[3] });
        ctx.fkConstraintsByTable.set(table, list);
      }
    }
  }
}

function parseCreateIndex(body: string, ctx: BuildCtx): void {
  const m = /^CREATE\s+(UNIQUE\s+)?INDEX\b/i.exec(body);
  if (!m) return;
  ctx.indexCount += 1;
  if (m[1]) ctx.constraintCountByKind.unique += 1;
}

/**
 * Review fix round 2 (P0): `maxFkPerTable >= 2` alone can't tell "the agent
 * violated the correctly-enforced last FK twice" apart from "the agent
 * selectively violated an earlier one while satisfying the last" - only the
 * latter actually distinguishes `fk-only-last-declared-constraint-registered`.
 * `assignedValues` is this record's own column -> raw literal value text.
 * For each of the table's FK constraints (in declaration order), a `NULL`
 * assignment or a value present in `insertedValuesByTableColumn` for the
 * referenced table/column counts as satisfied; anything else (including "no
 * value assigned for this FK column at all") counts as violated. Sets
 * `ctx.nonLastFkViolationTested` when the LAST FK is satisfied while some
 * EARLIER FK is violated - deliberately v0-lightweight: only INSERTed
 * values are tracked as "existing" (see `insertedValuesByTableColumn`'s own
 * doc-comment), so this can under-detect (never over-detect) satisfaction.
 */
function evaluateFkSatisfaction(table: string, assignedValues: Map<string, string>, ctx: BuildCtx): void {
  const fks = ctx.fkConstraintsByTable.get(table);
  if (!fks || fks.length < 2) return;
  const violated = fks.map((fk) => {
    const value = assignedValues.get(fk.fkColumn);
    if (value === undefined || /^NULL$/i.test(value)) return false;
    const refSet = ctx.insertedValuesByTableColumn.get(`${fk.referencedTable}.${fk.referencedColumn}`);
    return !(refSet?.has(value) ?? false);
  });
  const lastSatisfied = violated[violated.length - 1] === false;
  const earlierViolated = violated.slice(0, -1).some((v) => v === true);
  if (lastSatisfied && earlierViolated) ctx.nonLastFkViolationTested = true;
}

/** Records this INSERT's own values into `insertedValuesByTableColumn` (v0: INSERT-only, see that field's own doc-comment) - called after `evaluateFkSatisfaction` reads the ledger's PRIOR state, so a record never satisfies its own FK against itself. */
function recordInsertedValues(table: string, assignedValues: Map<string, string>, ctx: BuildCtx): void {
  for (const [column, value] of assignedValues) {
    const key = `${table}.${column}`;
    const set = ctx.insertedValuesByTableColumn.get(key) ?? new Set<string>();
    set.add(value);
    ctx.insertedValuesByTableColumn.set(key, set);
  }
}

/** `INSERT INTO t (col, ...) VALUES (v, ...)` (explicit column list) or `INSERT INTO t VALUES (v, ...)` (positional, per SPEC.md's declared column order) -> column name -> raw literal value text. */
function extractInsertColumnValues(body: string, table: string, ctx: BuildCtx): Map<string, string> {
  const map = new Map<string, string>();
  const valuesMatch = /VALUES\s*\(([\s\S]*)\)\s*$/i.exec(body);
  if (!valuesMatch) return map;
  const values = splitTopLevel(valuesMatch[1], commaBoundary);
  const explicitCols = /^INSERT\s+INTO\s+\w+\s*\(([^)]*)\)/i.exec(body);
  const cols = explicitCols ? splitTopLevel(explicitCols[1], commaBoundary) : (ctx.tableColumnOrder.get(table) ?? []);
  for (let i = 0; i < Math.min(cols.length, values.length); i += 1) {
    map.set(cols[i].trim(), values[i].trim());
  }
  return map;
}

function parseInsert(body: string, ctx: BuildCtx, expectation: "ok" | "error" | null): void {
  const m = /^INSERT\s+INTO\s+(\w+)/i.exec(body);
  if (!m) return;
  const table = m[1];
  ctx.insertPresent = true;
  ctx.touchedTables.add(table);
  const valuesMatch = /VALUES\s*(\([\s\S]*\))\s*$/i.exec(body);
  if (valuesMatch) {
    const key = `${table}::${valuesMatch[1].replace(/\s+/g, " ").trim()}`;
    if (ctx.seenInsertValues.has(key)) ctx.duplicateInputTested = true;
    ctx.seenInsertValues.add(key);
  }
  if (/\bNULL\b/i.test(body)) ctx.nullInputTested = true;

  const assignedValues = extractInsertColumnValues(body, table, ctx);
  if (expectation === "error") evaluateFkSatisfaction(table, assignedValues, ctx);
  recordInsertedValues(table, assignedValues, ctx);
}

function parseUpdate(body: string, ctx: BuildCtx, updateIdx: number, expectation: "ok" | "error" | null): void {
  const m = /^UPDATE\s+(\w+)\s+SET\s+([\s\S]+?)(?:\s+WHERE\s+[\s\S]+)?$/i.exec(body);
  if (!m) return;
  ctx.updatePresent = true;
  const table = m[1];
  ctx.touchedTables.add(table);
  const cols: string[] = [];
  const assignedValues = new Map<string, string>();
  for (const assignment of splitTopLevel(m[2], commaBoundary)) {
    const am = /^(\w+)\s*=\s*([\s\S]+)$/.exec(assignment);
    if (am) {
      cols.push(am[1]);
      assignedValues.set(am[1], am[2].trim());
    }
  }
  ctx.updateAssignedColumns[`${table}.update${updateIdx}`] = cols;
  const knownCols = ctx.tableColumns.get(table);
  if (knownCols && cols.length > 0 && cols.length < knownCols.size) ctx.partialUpdate = true;
  const checkRelevant = ctx.checkRelevantColumns.get(table);
  if (checkRelevant && cols.length > 0 && [...checkRelevant].some((c) => !cols.includes(c))) {
    ctx.checkReferencesUnassignedColumn = true;
  }
  if (/\bNULL\b/i.test(body)) ctx.nullInputTested = true;
  if (expectation === "error") evaluateFkSatisfaction(table, assignedValues, ctx);
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
      parseInsert(body, ctx, expectation);
    } else if (/^UPDATE\b/i.test(body)) {
      updateIdx += 1;
      parseUpdate(body, ctx, updateIdx, expectation);
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
    multiColumnCheck: ctx.multiColumnCheck,
    orComposition: ctx.orComposition,
    checkReferencesUnassignedColumn: ctx.checkReferencesUnassignedColumn,
    checkReferencedColumns: ctx.checkReferencedColumns,
    updateAssignedColumns: ctx.updateAssignedColumns,
    partialUpdate: ctx.partialUpdate,
    fkTested: ctx.constraintCountByKind.fk > 0,
    negativeFkTested,
    maxFkPerTable,
    nonLastFkViolationTested: ctx.nonLastFkViolationTested,
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
/**
 * Review fix round 2 (P0): `cross-column-dependency`'s comparator now
 * recognizes two distinct required shapes that both belong under this same
 * tag - `crossColumnDependency` alone (golden case A's narrow atomic-clause
 * definition) OR the composed `multiColumnCheck`+`orComposition`+
 * `checkReferencesUnassignedColumn` shape `check-on-update-sees-only-assigned-columns`
 * actually needs (see PRIVATE_REQUIRED_PROBE_SHAPES's own worked example).
 * `partialUpdate` is deliberately NOT folded in here even though that
 * operator's required shape sets it - it's already its own independent
 * `partial-update` tag below, so a trial missing only the partial-update
 * piece gets exactly that tag, not a second, redundant
 * cross-column-dependency one.
 */
function hasCrossColumnDependencyGap(r: RequiredProbeShape, o: ProbeShape): boolean {
  if (r.crossColumnDependency === true && o.crossColumnDependency !== true) return true;
  const composedFields: Array<keyof ProbeShape> = ["multiColumnCheck", "orComposition", "checkReferencesUnassignedColumn"];
  const requiredComposedFields = composedFields.filter((field) => r[field] === true);
  if (requiredComposedFields.length === 0) return false;
  return requiredComposedFields.some((field) => o[field] !== true);
}

/**
 * Review fix round 2 (P0): `minFkPerTable` (raw multiplicity) is necessary
 * but not sufficient for `fk-only-last-declared-constraint-registered` -
 * `nonLastFkViolationTested` is the missing "which FK did the agent
 * actually violate" dimension (see PRIVATE_REQUIRED_PROBE_SHAPES's own
 * comment).
 */
function hasSameKindMultiplicityGap(r: RequiredProbeShape, o: ProbeShape): boolean {
  if (typeof r.minFkPerTable === "number" && (o.maxFkPerTable ?? 0) < r.minFkPerTable) return true;
  if (r.nonLastFkViolationTested === true && o.nonLastFkViolationTested !== true) return true;
  return false;
}

const GAP_CHECKS: GapCheck[] = [
  { tag: "cross-column-dependency", hasGap: hasCrossColumnDependencyGap },
  { tag: "same-kind-multiplicity", hasGap: hasSameKindMultiplicityGap },
  { tag: "negative-obligation", hasGap: (r, o) => r.negativeObligationTested === true && o.negativeObligationTested !== true },
  { tag: "partial-update", hasGap: (r, o) => r.partialUpdate === true && o.partialUpdate !== true },
  { tag: "multi-object-interaction", hasGap: (r, o) => r.multiObjectInteraction === true && o.multiObjectInteraction !== true },
  { tag: "state-transition", hasGap: (r, o) => r.rollbackUsed === true && o.rollbackUsed !== true },
  { tag: "transaction-sequence", hasGap: (r, o) => r.transactionUsed === true && o.transactionUsed !== true }
];

/** Outcomes whose own probe shape reflects a run that never produced trustworthy data to diagnose - see `DiagnosisStatus`'s own doc-comment. */
const INELIGIBLE_OUTCOMES: ReadonlySet<DshTrialOutcome> = new Set(["blocked", "invalidated", "driver_error"]);

/**
 * Pure diff: `Required Probe Shape - Observed Probe Shape = Capability Gap`
 * (#174 §6). No LLM. `capabilityGaps` is always computed as a plain function
 * of `required`/`observed` - `diagnosisStatus` is a SEPARATE, explicit
 * validity signal (review fix round 2, P1), not folded into
 * `capabilityGaps` by forcing it empty when the trial is ineligible or the
 * required shape was unavailable. Forcing gaps to `[]` in either case would
 * just re-create the exact ambiguity `diagnosisStatus` exists to remove - a
 * consumer must check `diagnosisStatus`, not infer validity from whether
 * `capabilityGaps` happens to be empty.
 */
export function diagnoseTrial(
  observed: ProbeShape,
  required: RequiredProbeShape,
  trial: { trialId: string; outcome: DshTrialOutcome; feature: string },
  evidence: Evidence[]
): TrialDiagnosis {
  const capabilityGaps = GAP_CHECKS.filter((check) => check.hasGap(required, observed)).map((check) => check.tag);
  const diagnosisStatus: DiagnosisStatus = INELIGIBLE_OUTCOMES.has(trial.outcome)
    ? "ineligible"
    : evidence.some((e) => e.kind === "required-shape-unavailable")
      ? "required_shape_unavailable"
      : "complete";
  return {
    trialId: trial.trialId,
    outcome: trial.outcome,
    feature: trial.feature,
    observedProbeShapes: observed,
    requiredProbeShapes: required,
    capabilityGaps,
    evidence,
    diagnosisStatus
  };
}

// --- on-disk schema (#174 §7's snake_case output contract) -----------------

/**
 * `trial-diagnosis.json`'s on-disk shape - deliberately snake_case per #174
 * §7's own output contract, distinct from `TrialDiagnosis`'s camelCase
 * in-memory shape. `encodeTrialDiagnosis`/`decodeTrialDiagnosis` are the
 * only place this conversion should happen (review fix, P0: a prior version
 * of `scripts/dsh-evals-demo.ts` read the raw JSON and spread it directly as
 * a `TrialDiagnosis`, so `d.capabilityGaps` was `undefined` on every real
 * diagnosed trial - `capability_gaps` was the actual key on disk).
 */
export type TrialDiagnosisFile = {
  trial_id: string;
  outcome: DshTrialOutcome;
  feature: string;
  observed_probe_shapes: Partial<ProbeShape>;
  required_probe_shapes: RequiredProbeShape;
  capability_gaps: CapabilityGapTag[];
  evidence: Evidence[];
  diagnosis_status: DiagnosisStatus;
};

export function encodeTrialDiagnosis(diagnosis: TrialDiagnosis): TrialDiagnosisFile {
  return {
    trial_id: diagnosis.trialId,
    outcome: diagnosis.outcome,
    feature: diagnosis.feature,
    observed_probe_shapes: diagnosis.observedProbeShapes,
    required_probe_shapes: diagnosis.requiredProbeShapes,
    capability_gaps: diagnosis.capabilityGaps,
    evidence: diagnosis.evidence,
    diagnosis_status: diagnosis.diagnosisStatus
  };
}

const DIAGNOSIS_STATUSES: ReadonlySet<string> = new Set<DiagnosisStatus>(["complete", "required_shape_unavailable", "ineligible"]);

/** Defensive decode of a `trial-diagnosis.json` payload of unknown provenance (age, hand-editing, a future schema change) - `null` for anything that doesn't match the expected shape, rather than an exception or a half-populated `TrialDiagnosis`. */
export function decodeTrialDiagnosis(raw: unknown): TrialDiagnosis | null {
  if (raw === null || typeof raw !== "object") return null;
  const r = raw as Partial<TrialDiagnosisFile>;
  if (
    typeof r.trial_id !== "string" ||
    typeof r.outcome !== "string" ||
    typeof r.feature !== "string" ||
    !Array.isArray(r.capability_gaps) ||
    !Array.isArray(r.evidence) ||
    typeof r.observed_probe_shapes !== "object" ||
    r.observed_probe_shapes === null ||
    typeof r.required_probe_shapes !== "object" ||
    r.required_probe_shapes === null ||
    typeof r.diagnosis_status !== "string" ||
    !DIAGNOSIS_STATUSES.has(r.diagnosis_status)
  ) {
    return null;
  }
  return {
    trialId: r.trial_id,
    outcome: r.outcome as DshTrialOutcome,
    feature: r.feature,
    observedProbeShapes: r.observed_probe_shapes as Partial<ProbeShape>,
    requiredProbeShapes: r.required_probe_shapes as RequiredProbeShape,
    capabilityGaps: r.capability_gaps as CapabilityGapTag[],
    evidence: r.evidence as Evidence[],
    diagnosisStatus: r.diagnosis_status
  };
}
