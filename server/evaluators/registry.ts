import type { Artifact, Evaluation, EvaluatorDefinition, Evidence, Step } from "../types.js";

export type EvaluatorInput = {
  definition: EvaluatorDefinition;
  step: Step;
  output?: Record<string, unknown>;
  evidence: Evidence[];
  artifacts: Artifact[];
};

export type EvaluatorResult = Omit<Evaluation, "id" | "runId" | "stepId" | "createdAt">;

export interface Evaluator {
  type: string;
  evaluate(input: EvaluatorInput): EvaluatorResult;
}

export class EvaluatorRegistry {
  private evaluators = new Map<string, Evaluator>();

  constructor(evaluators: Evaluator[] = []) {
    evaluators.forEach((evaluator) => this.register(evaluator));
  }

  register(evaluator: Evaluator) {
    this.evaluators.set(evaluator.type, evaluator);
  }

  has(type: string) {
    return this.evaluators.has(type);
  }

  get(type: string) {
    const evaluator = this.evaluators.get(type);
    if (!evaluator) throw new Error(`Unknown evaluator type: ${type}`);
    return evaluator;
  }
}

function nestedValue(value: unknown, path: string): unknown {
  if (!path) return value;
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(segment)) return current[Number(segment)];
    if (typeof current === "object") return (current as Record<string, unknown>)[segment];
    return undefined;
  }, value);
}

function firstCheckEvidence(evidence: Evidence[]) {
  return evidence.find((item) => item.kind === "check.command");
}

function resolveSource(input: EvaluatorInput): unknown {
  const source = String(input.definition.source || "").trim();
  if (!source) return undefined;
  if (source.startsWith("output.")) return nestedValue(input.output, source.slice("output.".length));
  if (source === "check.ok") {
    const checks = input.evidence.filter((item) => item.kind === "check.command");
    return checks.length > 0 && checks.every((item) => nestedValue(item.value, "status") === "passed");
  }
  if (source.startsWith("check.")) return nestedValue(firstCheckEvidence(input.evidence)?.value, source.slice("check.".length));
  if (source.startsWith("evidence.")) {
    const path = source.slice("evidence.".length);
    for (const item of input.evidence) {
      const value = nestedValue(item.value, path) ?? nestedValue(item as unknown as Record<string, unknown>, path);
      if (value !== undefined) return value;
    }
  }
  return nestedValue({ output: input.output, step: input.step }, source);
}

function compare(left: unknown, operator: string, right: unknown) {
  switch (operator) {
    case "==": return left === right;
    case "!=": return left !== right;
    case ">": return Number(left) > Number(right);
    case ">=": return Number(left) >= Number(right);
    case "<": return Number(left) < Number(right);
    case "<=": return Number(left) <= Number(right);
    default: throw new Error(`Unsupported operator: ${operator}`);
  }
}

function evidenceIds(evidence: Evidence[]) {
  return evidence.map((item) => item.id);
}

function artifactIds(artifacts: Artifact[]) {
  return artifacts.map((item) => item.id);
}

export class BooleanEvaluator implements Evaluator {
  type = "boolean";

  evaluate(input: EvaluatorInput): EvaluatorResult {
    const actual = resolveSource(input);
    const expected = input.definition.expected ?? true;
    const passed = Boolean(actual) === Boolean(expected);
    return {
      evaluator: input.definition.id || this.type,
      status: passed ? "passed" : "failed",
      score: Boolean(actual) ? 1 : 0,
      threshold: Boolean(expected) ? 1 : 0,
      reason: input.definition.reason || `${input.definition.source || "value"} expected ${Boolean(expected)} and was ${Boolean(actual)}`,
      evidenceIds: evidenceIds(input.evidence),
      artifactIds: artifactIds(input.artifacts),
      metadata: { type: this.type, source: input.definition.source, expected, actual }
    };
  }
}

export class NumericThresholdEvaluator implements Evaluator {
  type = "numeric-threshold";

  evaluate(input: EvaluatorInput): EvaluatorResult {
    const actual = Number(resolveSource(input));
    const threshold = Number(input.definition.threshold);
    if (!Number.isFinite(actual) || !Number.isFinite(threshold)) {
      throw new Error(`Numeric evaluator requires finite actual and threshold values`);
    }
    const operator = input.definition.operator || ">=";
    const passed = compare(actual, operator, threshold);
    return {
      evaluator: input.definition.id || this.type,
      status: passed ? "passed" : "failed",
      score: actual,
      threshold,
      reason: input.definition.reason || `${input.definition.source || "value"} ${actual} ${operator} ${threshold}`,
      evidenceIds: evidenceIds(input.evidence),
      artifactIds: artifactIds(input.artifacts),
      metadata: { type: this.type, source: input.definition.source, operator }
    };
  }
}

export class CheckEvaluator implements Evaluator {
  type = "check";

  evaluate(input: EvaluatorInput): EvaluatorResult {
    const checks = input.evidence.filter((item) => item.kind === "check.command");
    const passed = checks.length > 0 && checks.every((item) => nestedValue(item.value, "status") === "passed" && Number(nestedValue(item.value, "exitCode") ?? 0) === 0);
    return {
      evaluator: input.definition.id || this.type,
      status: passed ? "passed" : "failed",
      score: checks.filter((item) => nestedValue(item.value, "status") === "passed").length,
      threshold: checks.length,
      reason: passed ? "All check commands passed" : "One or more check commands failed",
      evidenceIds: evidenceIds(checks),
      artifactIds: artifactIds(input.artifacts),
      metadata: { type: this.type, commandCount: checks.length }
    };
  }
}

export function createDefaultEvaluatorRegistry() {
  return new EvaluatorRegistry([
    new BooleanEvaluator(),
    new NumericThresholdEvaluator(),
    new CheckEvaluator()
  ]);
}
