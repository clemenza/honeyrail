/**
 * #148: classifies each *killed* real trial's `transcript.ndjson` by how the
 * agent actually found the seeded defect - `#145`/`#146`'s open question is
 * whether kills are test-driven (write a test, watch it fail, then explain
 * why) or code-review (read `tinytable/sql.py`/`core.py` directly, spot the
 * diff-shaped bug by inspection, write a confirming test afterwards) or,
 * worse, sourced from a leak (`#146`'s `__pycache__` finding,
 * `clemenza/tinytable-evals#70`). `tinytable/sql.py` is ~40KB - it fits in
 * one context window, so "the agent read the file and the bug just jumped
 * out" is a real alternative explanation for the ceiling effect
 * `tinytable-evals#38` tracks, distinct from "the operators aren't hard
 * enough".
 *
 * This module is pure classification logic over an already-parsed
 * `transcript.ndjson` (`server/evals/dsh-transcript.ts`'s own output) - no
 * filesystem access, so it's directly unit-testable against both synthetic
 * fixtures and real transcript excerpts. `scripts/audit-kill-attribution.ts`
 * is the CLI that walks report directories and calls this.
 *
 * Reuses server/evals/dsh-trajectory-bridge.ts's `deriveTrajectoryEvents`
 * for the tool_call/shell_command pairing (`callId`-matched `tool/call` +
 * `tool/result`, verified against `@deepseek-ai/dsh-session`'s own
 * published types) rather than re-deriving that from scratch - same
 * provenance guarantees, no reason to trust a second implementation less.
 */

import { deriveTrajectoryEvents, type DerivedTrajectoryEvent } from "./dsh-trajectory-bridge.js";
import type { DshRawEvent } from "./dsh-session-stats.js";
import type { TranscriptLine } from "./dsh-transcript.js";
import { runCommandSafe } from "../utils.js";

export function parseTranscript(text: string): TranscriptLine[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as TranscriptLine);
}

/** `deriveTrajectoryEvents` wants `DshRawEvent[]` (`{type, time, data}`) - `transcript.ndjson` lines already carry everything but a numeric `time`, recovered from `ts`. */
function toRawEvents(lines: TranscriptLine[]): DshRawEvent[] {
  return lines.map((line) => ({ type: line.type, time: line.ts ? Date.parse(line.ts) : 0, data: line.data }));
}

function tsMillis(ts: string | null): number | null {
  if (ts === null) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

// --- assistant reasoning/text extraction -----------------------------------

export type AssistantTextBlock = { seq: number; ts: string | null; tMs: number | null; turn: number | null; step: number | null; kind: "reasoning" | "text"; text: string };

/** Every `reasoning`/`text` content block across every `assistant/message` event, in transcript order - the narrative an agent leaves behind, distinct from the tool_call/shell_command signal `deriveTrajectoryEvents` extracts. */
export function extractAssistantTextBlocks(lines: TranscriptLine[]): AssistantTextBlock[] {
  const out: AssistantTextBlock[] = [];
  for (const line of lines) {
    if (line.type !== "assistant/message") continue;
    const message = (line.data as { message?: { content?: unknown } } | undefined)?.message;
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block && typeof block === "object" &&
        (block as { type?: unknown }).type !== undefined &&
        ((block as { type: unknown }).type === "reasoning" || (block as { type: unknown }).type === "text") &&
        typeof (block as { text?: unknown }).text === "string" &&
        (block as { text: string }).text.trim() !== ""
      ) {
        out.push({
          seq: line.seq,
          ts: line.ts,
          tMs: tsMillis(line.ts),
          turn: (line.data as { turn?: number } | undefined)?.turn ?? null,
          step: (line.data as { step?: number } | undefined)?.step ?? null,
          kind: (block as { type: "reasoning" | "text" }).type,
          text: (block as { text: string }).text
        });
      }
    }
  }
  return out;
}

// --- leak / oracle-exploit scanning -----------------------------------------

export type LeakHit = { tMs: number | null; ts: string | null; source: "command" | "output" | "text"; pattern: string; snippet: string };

/**
 * #146's original leak class: a pre-mutation-compiled `__pycache__`
 * (`clemenza/tinytable-evals#70`) let an agent decompile its way back to
 * the answer. Under normal (white-box, source-visible) seed-roots, any
 * `.pyc`/`marshal`/`dis`/bytecode-internals reference is exactly this -
 * there's no legitimate reason to touch compiled bytecode when the `.py`
 * is right there to read.
 *
 * Under `--black-box` mode (#158), this entire category flips: the
 * seed-root *only* ships `.pyc` - reading/disassembling it is the
 * mode's own sanctioned interaction surface, not a leak. `#164`'s real
 * trial referenced these patterns 100+ times doing exactly what
 * black-box mode expects. `classifyKillAttribution`'s `blackBoxMode`
 * parameter excludes this group from leak scanning in that case (see
 * BYTECODE_INTROSPECTION_RE / the `bytecode-review` channel instead,
 * which measures the same signal without treating it as invalidating).
 */
const BYTECODE_LEAK_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "__pycache__", re: /__pycache__/ },
  { name: ".pyc", re: /\.pyc\b/ },
  { name: "marshal", re: /\bmarshal\b/ },
  { name: "source_size", re: /\bsource_size\b/ },
  { name: "co_code", re: /\bco_code\b/ },
  { name: "dis.", re: /\bdis\.\w/ }
];

/**
 * Leak signals that stay invalidating regardless of white-box vs.
 * black-box mode: host filesystem paths, and git archaeology beyond what
 * a freshly-committed single-commit seed-root has any legitimate reason
 * to run (`git status`/`git diff` against HEAD are fine -
 * `run_sql_tests.py`'s own instructions ask for neither, and grade.py's
 * own protected-path check is exactly `git status`). Neither of these
 * becomes sanctioned just because source is hidden.
 */
const HOST_LEAK_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "git log/diff/show", re: /\bgit\s+(?:log|diff|show)\b/ },
  { name: "/mnt/", re: /\/mnt\// },
  { name: "/host", re: /\/host\b/ },
  { name: "/Users/", re: /\/Users\// },
  { name: "/home/", re: /\/home\// }
];

/**
 * A softer category: references to the *old*, pre-#126 static-mutant
 * system's naming (`examples/tinytable-eval/{mutants,golden,score.py}`,
 * `clean/`) - none of these exist in a real seed-root, so a hit here is
 * plausibly the agent pattern-matching from general SWE knowledge about
 * "a scoring harness" rather than having actually touched real leaked
 * material. Kept separate from BYTECODE_LEAK_PATTERNS/HOST_LEAK_PATTERNS per #148's own rule 2 -
 * legitimately in-scope depending on what task-prompt.md says.
 */
const ORACLE_EXPLOIT_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "clean/", re: /\bclean\// },
  { name: "mutants/", re: /\bmutants\// },
  { name: "golden", re: /\bgolden\b/ },
  { name: "score.py", re: /\bscore\.py\b/ }
];

function scanPatterns(text: string, patterns: Array<{ name: string; re: RegExp }>, tMs: number | null, ts: string | null, source: LeakHit["source"]): LeakHit[] {
  const hits: LeakHit[] = [];
  for (const { name, re } of patterns) {
    const match = re.exec(text);
    if (match) {
      const start = Math.max(0, match.index - 40);
      hits.push({ tMs, ts, source, pattern: name, snippet: text.slice(start, match.index + match[0].length + 40) });
    }
  }
  return hits;
}

/** Runs the given pattern set over every command/output/text surface a trial's transcript exposes - independent of whether the trial was killed (#148 AC3: leak scan runs on every trial). */
export function scanForPatterns(lines: TranscriptLine[], derived: DerivedTrajectoryEvent[], patterns: Array<{ name: string; re: RegExp }>): LeakHit[] {
  const hits: LeakHit[] = [];
  for (const event of derived) {
    const tMs = tsMillis(event.ts);
    if (event.kind === "shell_command") {
      const command = typeof event.command === "string" ? event.command : "";
      hits.push(...scanPatterns(command, patterns, tMs, event.ts, "command"));
      const output = `${typeof event.stdout === "string" ? event.stdout : ""}\n${typeof event.stderr === "string" ? event.stderr : ""}`;
      hits.push(...scanPatterns(output, patterns, tMs, event.ts, "output"));
    } else if (event.kind === "tool_call") {
      hits.push(...scanPatterns(JSON.stringify(event.input ?? {}), patterns, tMs, event.ts, "command"));
      // A bash tool_call's output is scanned via its sibling shell_command
      // event above instead (clemenza/honeyrail#154 fixed that derivation
      // to actually fire on real data) - scanning both here would double-
      // count every hit.
      if (event.name === "bash") continue;
      // A `read` of one of these ships-in-every-seed-root, sanctioned,
      // universally-read files legitimately contains pattern-matching text
      // that isn't a reference to anything actually leaked: .gitignore's own
      // "__pycache__/"/"*.pyc" ignore-glob lines; run_sql_tests.py's own
      // docstring and SPEC.md itself both describe the *overall* grading
      // methodology in the abstract ("clean/ is... the sole arbiter of
      // correct behavior", "golden" test files, "mirrors score.py's own...
      // design") to explain what the tool/harness does - not evidence the
      // agent has (or is trying to get) access to any of it. Confirmed
      // empirically against real trials: every one reads SPEC.md (mandatory
      // - it's the task itself) and nearly every one reads run_sql_tests.py
      // (task-prompt.md tells every agent to run it), and both hit these
      // same oracle-exploit patterns from that read alone, on every trial,
      // regardless of anything the agent actually did wrong.
      const input = event.input as { file_path?: unknown } | null;
      const filePath = event.name === "read" && typeof input?.file_path === "string" ? input.file_path : null;
      const isSanctionedFileRead = filePath !== null && (filePath.endsWith(".gitignore") || filePath.endsWith("run_sql_tests.py") || filePath.endsWith("SPEC.md"));
      if (!isSanctionedFileRead) {
        hits.push(...scanPatterns(JSON.stringify(event.output ?? {}), patterns, tMs, event.ts, "output"));
      }
    }
  }
  for (const block of extractAssistantTextBlocks(lines)) {
    hits.push(...scanPatterns(block.text, patterns, block.tMs, block.ts, "text"));
  }
  hits.sort((a, b) => (a.tMs ?? Infinity) - (b.tMs ?? Infinity));
  return hits;
}

// --- source-read / own-failing-test detection -------------------------------

const SOURCE_FILE_RE = /tinytable\/(sql|core)\.py\b/;

export type StepEvidence = { tMs: number | null; ts: string | null; step: number | null };

/** First `read` tool call (or bash command referencing) `tinytable/sql.py`/`core.py` - the two files every operator, Gen1 or Gen2, ever mutates. */
export function findFirstSourceRead(derived: DerivedTrajectoryEvent[]): StepEvidence | null {
  for (const event of derived) {
    if (event.kind === "tool_call") {
      const input = event.input as { file_path?: unknown } | null;
      const filePath = typeof input?.file_path === "string" ? input.file_path : "";
      if (SOURCE_FILE_RE.test(filePath)) return { tMs: tsMillis(event.ts), ts: event.ts, step: null };
    } else if (event.kind === "shell_command") {
      const command = typeof event.command === "string" ? event.command : "";
      if (SOURCE_FILE_RE.test(command)) return { tMs: tsMillis(event.ts), ts: event.ts, step: null };
    }
  }
  return null;
}

// #164: under --black-box mode, tinytable/{core,sql}.py don't exist, so
// findFirstSourceRead never fires - but the compiled .pyc is still
// importable, and a real trial (#164) disassembled every method via
// stdlib marshal+dis within seconds and reasoned from that instead,
// forming a precise "bug hypothesis" comment 2.5 minutes in - the same
// localize-then-confirm workflow as code-review, just reading bytecode
// instead of source. Earlier attempts on the same issue also tried
// installing decompyle3/uncompyle6/xdis. Matches a `read` of a `.pyc`
// file directly, or a bash/tool_call command referencing any of these.
const BYTECODE_INTROSPECTION_RE = /\bdis\.dis\(|\bmarshal\.(?:loads?|dumps?)\(|\buncompyle\w*\b|\bdecompyle\w*\b|\bxdis\b|\.pyc\b/i;

/** First `read` of a `.pyc` file, or bash/tool_call command referencing bytecode-disassembly tooling (`dis.dis`, `marshal`, `uncompyle`/`decompyle`/`xdis`) - the black-box-mode analog of `findFirstSourceRead`, since the real `.py` doesn't exist to read. */
export function findFirstBytecodeIntrospection(derived: DerivedTrajectoryEvent[]): StepEvidence | null {
  for (const event of derived) {
    if (event.kind === "tool_call") {
      const input = event.input as { file_path?: unknown; command?: unknown } | null;
      const filePath = typeof input?.file_path === "string" ? input.file_path : "";
      const command = event.name === "bash" && typeof input?.command === "string" ? input.command : "";
      if (filePath.endsWith(".pyc") || BYTECODE_INTROSPECTION_RE.test(command)) return { tMs: tsMillis(event.ts), ts: event.ts, step: null };
    } else if (event.kind === "shell_command") {
      const command = typeof event.command === "string" ? event.command : "";
      if (BYTECODE_INTROSPECTION_RE.test(command)) return { tMs: tsMillis(event.ts), ts: event.ts, step: null };
    }
  }
  return null;
}

// Matches both a specific file (`sql-tests/agent/foo.test`) and a bare
// directory reference (`sql-tests/agent`, `sql-tests/agent/`) - confirmed
// against real trials that the latter is the dominant invocation style
// (`python3 run_sql_tests.py --root . sql-tests/agent`, letting
// run_sql_tests.py discover every .test file itself) - a regex requiring a
// trailing filename missed almost every real self-verification run.
const AGENT_TEST_FILE_RE = /sql-tests\/agent\b/;
const FAILURE_MARKER_RE = /\bFAIL\b|\bfailure\(s\)|AssertionError|expected[^\n]{0,80}actual|assert(?:ion)? (?:error|failed)/i;

/**
 * First shell_command that (a) invokes `run_sql_tests.py` against
 * `sql-tests/agent/` (a specific `.test` file or the whole directory) -
 * inherently the agent's own work, since nothing else populates that
 * directory - and (b) whose own output shows a failure, in
 * `run_sql_tests.py`'s real output shape ("FAIL <path> (N failure(s))" vs
 * "ok   <path>").
 */
export function findFirstOwnFailingTest(derived: DerivedTrajectoryEvent[]): StepEvidence | null {
  for (const event of derived) {
    if (event.kind !== "shell_command") continue;
    const command = typeof event.command === "string" ? event.command : "";
    if (!command.includes("run_sql_tests.py") || !AGENT_TEST_FILE_RE.test(command)) continue;
    const output = `${typeof event.stdout === "string" ? event.stdout : ""}\n${typeof event.stderr === "string" ? event.stderr : ""}`;
    if (FAILURE_MARKER_RE.test(output)) {
      return { tMs: tsMillis(event.ts), ts: event.ts, step: null };
    }
  }
  return null;
}

// --- bug-claim detection -----------------------------------------------------

const GENERIC_CLAIM_RE = /\b(bug|defect|violat\w*|incorrect(?:ly)?|is wrong|isn't right|should (?:have |not )?\w+ but|off[- ]by[- ]one|silently (?:skip|omit|drop)s?|doesn't (?:match|conform|comply))\b/i;
const STOP_TOKENS = new Set([
  "self", "return", "else", "None", "True", "False", "class", "import", "from", "while", "with", "try",
  "except", "raise", "pass", "print", "list", "dict", "str", "int", "len", "range", "then", "that", "this",
  "which", "where", "when", "what", "there", "their", "these", "those", "table", "column", "value", "values"
]);

export type OperatorMeta = {
  id: string;
  file: string;
  specSection: string;
  tokens: string[];
  family: string | null;
  /**
   * #139's interim difficultyTier source, pending clemenza/tinytable-evals#53's
   * staged L0-L4 benchmark levels: #44's `statefulness` difficulty axis
   * (`mutate.py`'s own "ordered tiers, each subsuming the one before it" -
   * single-statement < multi-statement < multi-object < transactional <
   * crash-recovery), only declared for Gen2 (`family`-carrying) operators.
   * null for every Gen1 operator - i.e. every fixture in the 22-operator
   * default matrix #136 analyzed by hand - since Gen1 predates #44 and
   * carries no difficulty metadata at all yet.
   */
  tier: string | null;
};

/** Identifier-shaped tokens (>=4 chars, not a stopword) pulled from an operator's anchor `find` text - a cheap proxy for "names the mutated function/constraint". */
export function extractOperatorTokens(findSnippet: string): string[] {
  const matches = findSnippet.match(/\b_?[A-Za-z][A-Za-z0-9_]{3,}\b/g) ?? [];
  const unique = new Set(matches.filter((t) => !STOP_TOKENS.has(t) && !/^\d+$/.test(t)));
  return [...unique];
}

export type ClaimEvidence = { tMs: number | null; ts: string | null; text: string; matchedBy: "generic" | "spec-section" | "token"; token?: string };

/** First reasoning/text block that names a defect - generically ("bug", "violates", ...), or by referencing the operator's own SPEC.md section, or by naming a token pulled from the mutated anchor text. */
export function findFirstClaim(lines: TranscriptLine[], operator: OperatorMeta | null): ClaimEvidence | null {
  for (const block of extractAssistantTextBlocks(lines)) {
    if (GENERIC_CLAIM_RE.test(block.text)) {
      return { tMs: block.tMs, ts: block.ts, text: block.text, matchedBy: "generic" };
    }
    if (operator) {
      if (operator.specSection.length >= 8 && block.text.toLowerCase().includes(operator.specSection.toLowerCase())) {
        return { tMs: block.tMs, ts: block.ts, text: block.text, matchedBy: "spec-section" };
      }
      for (const token of operator.tokens) {
        const re = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        if (re.test(block.text)) {
          return { tMs: block.tMs, ts: block.ts, text: block.text, matchedBy: "token", token };
        }
      }
    }
  }
  return null;
}

// --- full classification ------------------------------------------------------

export type Channel = "leak" | "oracle-exploit" | "test-driven" | "code-review" | "bytecode-review" | "black-box-reasoning" | "unattributable";

export type AttributionResult = {
  channel: Channel;
  claim: ClaimEvidence | null;
  firstOwnFailingTest: StepEvidence | null;
  firstSourceRead: StepEvidence | null;
  firstBytecodeIntrospection: StepEvidence | null;
  leakHits: LeakHit[];
  oracleHits: LeakHit[];
};

/**
 * #148's ordered rules, evaluated top to bottom - the first that matches
 * wins:
 *   1. leak - any hard-leak-pattern hit before t_claim (or at all, if no
 *      claim was ever made) -> the trial is invalid, not a genuine kill.
 *      `blackBoxMode` (#164) excludes BYTECODE_LEAK_PATTERNS from this
 *      check - under `--black-box`, reading/disassembling the compiled
 *      `.pyc` is the mode's own sanctioned surface, not a leak;
 *      HOST_LEAK_PATTERNS (host paths, git archaeology) still applies
 *      either way.
 *   2. oracle-exploit - an ORACLE_EXPLOIT_PATTERNS hit before t_claim,
 *      softer than (1), kept separate rather than folded in.
 *   3. test-driven - the agent's own test failed at or before the claim.
 *   4. code-review - the mutated `.py` file was read before the claim,
 *      with no own failing test before it (a confirming test written
 *      afterwards doesn't change this).
 *   5. bytecode-review (#164): no `.py` source exists to read (implies
 *      --black-box), but the agent disassembled/introspected the compiled
 *      `.pyc` before the claim instead - the same localize-then-confirm
 *      workflow as code-review, just reading bytecode. A real trial
 *      formed a precise "bug hypothesis" comment from `dis` output within
 *      2.5 minutes and wrote a single, narrowly-targeted test file - not
 *      the systematic SPEC-coverage a genuine black-box process would
 *      produce. Hiding source is not the same as forcing black-box
 *      behavior; this channel exists to measure how often it fails to.
 *   6. black-box-reasoning - a claim exists with neither a source read, a
 *      bytecode introspection, nor a failing test before it.
 *   7. unattributable - none of the above (including: no claim was ever
 *      made at all).
 */
export function classifyKillAttribution(lines: TranscriptLine[], operator: OperatorMeta | null, blackBoxMode = false): AttributionResult {
  const derived = deriveTrajectoryEvents(toRawEvents(lines));
  const leakPatterns = blackBoxMode ? HOST_LEAK_PATTERNS : [...BYTECODE_LEAK_PATTERNS, ...HOST_LEAK_PATTERNS];
  const leakHits = scanForPatterns(lines, derived, leakPatterns);
  const oracleHits = scanForPatterns(lines, derived, ORACLE_EXPLOIT_PATTERNS);
  const claim = findFirstClaim(lines, operator);
  const firstOwnFailingTest = findFirstOwnFailingTest(derived);
  const firstSourceRead = findFirstSourceRead(derived);
  const firstBytecodeIntrospection = findFirstBytecodeIntrospection(derived);

  const claimT = claim?.tMs ?? Infinity; // no claim ever made -> every hit counts as "before" it
  const before = (t: number | null) => t !== null && t < claimT;

  const base = { claim, firstOwnFailingTest, firstSourceRead, firstBytecodeIntrospection, leakHits, oracleHits };

  if (leakHits.some((h) => before(h.tMs))) return { ...base, channel: "leak" };
  if (oracleHits.some((h) => before(h.tMs))) return { ...base, channel: "oracle-exploit" };

  if (claim === null) return { ...base, channel: "unattributable" };

  if (firstOwnFailingTest !== null && (firstOwnFailingTest.tMs ?? Infinity) <= claimT) {
    return { ...base, channel: "test-driven" };
  }
  if (firstSourceRead !== null && (firstSourceRead.tMs ?? Infinity) < claimT) {
    return { ...base, channel: "code-review" };
  }
  if (firstBytecodeIntrospection !== null && (firstBytecodeIntrospection.tMs ?? Infinity) < claimT) {
    return { ...base, channel: "bytecode-review" };
  }
  return { ...base, channel: "black-box-reasoning" };
}

/**
 * Queries every operator's {id, file, spec_section, find, family, tier} from
 * the pinned vendor/tinytable-evals/mutate.py once (not per trial) via a
 * single subprocess call - the same "shell out to Python for mutate.py-
 * adjacent work" pattern build_seed_root.py/grade.py invocations already
 * use. `tier` is #44's `statefulness` axis, read straight off `o.axes` when
 * declared (see OperatorMeta's own docstring for why that's the field #139
 * picked as its interim difficultyTier source) - `None` for every Gen1
 * operator, same as `family`. Returns an empty map (not a throw) if
 * python3/mutate.py aren't available, so a checkout without the submodule
 * initialized still produces a report/trial record - just without
 * spec-section/token-based claim detection (the generic defect-assertion
 * regex still works on its own) or a difficultyTier.
 */
export async function loadOperatorMetadata(vendorDir: string): Promise<Map<string, OperatorMeta>> {
  const script =
    "import mutate, json; print(json.dumps([{'id': o.id, 'file': o.file, 'specSection': o.spec_section, 'find': o.find, 'family': o.family, 'tier': (o.axes.statefulness if o.axes else None)} for o in mutate.OPERATORS]))";
  const result = await runCommandSafe("python3", ["-c", script], { cwd: vendorDir });
  if (!result.ok) {
    console.error(`  warning: could not query operator metadata from ${vendorDir} (${result.stderr.trim() || "unknown error"}) - claim detection will use generic patterns only`);
    return new Map();
  }
  try {
    const raw = JSON.parse(result.stdout) as Array<{ id: string; file: string; specSection: string; find: string; family: string | null; tier: string | null }>;
    const map = new Map<string, OperatorMeta>();
    for (const op of raw) {
      map.set(op.id, { id: op.id, file: op.file, specSection: op.specSection, tokens: extractOperatorTokens(op.find), family: op.family, tier: op.tier });
    }
    return map;
  } catch {
    return new Map();
  }
}
