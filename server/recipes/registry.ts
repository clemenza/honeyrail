import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { Recipe, RecipeParameter, RecipeStepTemplate, RecipeSummary } from "./types.js";

export class RecipeValidationError extends Error {
  status = 400;
  issues: { path: string; message: string }[];

  constructor(issues: { path: string; message: string }[]) {
    super(issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join("; "));
    this.issues = issues;
  }
}

export class RecipeNotFoundError extends Error {
  status = 404;

  constructor(id: string) {
    super(`Recipe not found: ${id}`);
  }
}

const evaluatorSchema = z.object({
  id: z.string().optional(),
  type: z.string().min(1),
  source: z.string().optional(),
  expected: z.union([z.boolean(), z.string(), z.number()]).optional(),
  operator: z.enum(["==", "!=", ">", ">=", "<", "<="]).optional(),
  threshold: z.number().optional(),
  reason: z.string().optional()
});

// onFail is a plain string (not the strict "fail"|"wait_approval" enum used by
// createRunBody) because a recipe author may template it, e.g. "{{ onFail }}".
// The enum is enforced once materializeRecipe's output is re-validated by
// createRunBody in the routes layer.
const qualityGateSchema = z.object({
  evaluators: z.array(evaluatorSchema).min(1),
  onFail: z.string().optional()
});

// Like qualityGate.onFail above, each field is a plain string/number-or-string
// so a recipe author can template it (e.g. "{{ onBlockedAction }}"); the
// strict enums are enforced once materializeRecipe's output is re-validated
// by createRunBody in the routes layer.
const onBlockedSchema = z.object({
  action: z.string().optional(),
  timeoutMs: z.union([z.number(), z.string()]).optional(),
  onTimeout: z.string().optional(),
  maxAutoAnswers: z.union([z.number(), z.string()]).optional()
});

const recipeParameterSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["string", "number", "boolean", "enum"]),
  default: z.unknown().optional(),
  required: z.boolean().optional(),
  options: z.array(z.string()).optional(),
  multiplier: z.number().positive().optional()
});

const recipeStepTemplateSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  executor: z.string().min(1),
  input: z.record(z.string(), z.unknown()).optional(),
  dependsOn: z.array(z.string()).optional(),
  maxAttempts: z.number().int().positive().optional(),
  qualityGate: qualityGateSchema.optional(),
  onBlocked: onBlockedSchema.optional(),
  produces: z.array(z.string().min(1)).optional(),
  consumes: z.array(z.string().min(1)).optional()
});

const recipeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  contractLevel: z.enum(["L0", "L1", "L2", "L3"]).optional(),
  parameters: z.array(recipeParameterSchema),
  steps: z.array(recipeStepTemplateSchema).min(1)
});

export class RecipeRegistry {
  private recipes = new Map<string, Recipe>();

  constructor(recipes: Recipe[] = []) {
    for (const recipe of recipes) this.register(recipe);
  }

  register(recipe: Recipe) {
    if (this.recipes.has(recipe.id)) throw new Error(`Duplicate recipe id: ${recipe.id}`);
    this.recipes.set(recipe.id, recipe);
  }

  has(id: string): boolean {
    return this.recipes.has(id);
  }

  get(id: string): Recipe | undefined {
    return this.recipes.get(id);
  }

  list(): RecipeSummary[] {
    return [...this.recipes.values()].map(({ steps: _steps, ...summary }) => summary);
  }
}

export async function loadRecipesFromDirectory(dir: string): Promise<RecipeRegistry> {
  const entries = await readdir(dir);
  const files = entries.filter((name) => [".yaml", ".yml"].includes(extname(name)));
  const recipes: Recipe[] = [];
  for (const file of files) {
    const raw = await readFile(join(dir, file), "utf8");
    const parsed = parse(raw);
    const result = recipeSchema.safeParse(parsed);
    if (!result.success) {
      const message = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
      throw new Error(`Invalid recipe file ${file}: ${message}`);
    }
    recipes.push(result.data as Recipe);
  }
  return new RecipeRegistry(recipes);
}

const TEMPLATE_RE = /^\{\{\s*(\w+)\s*\}\}$/;

type ResolvedValue = { type: RecipeParameter["type"]; value: unknown };

function coerceParameterValue(param: RecipeParameter, raw: unknown, issues: { path: string; message: string }[]): unknown {
  const path = `parameters.${param.key}`;
  switch (param.type) {
    case "string": {
      if (typeof raw !== "string") {
        issues.push({ path, message: "Must be a string" });
        return undefined;
      }
      return raw;
    }
    case "number": {
      // Number("") === 0 and Number(null) === 0 are both finite, and
      // Number(true/false) === 1/0, so each would otherwise pass silently
      // as a valid number instead of the missing/wrong-type value it is.
      if (raw === "" || raw === null || typeof raw === "boolean") {
        issues.push({ path, message: "Must be a finite number" });
        return undefined;
      }
      const num = Number(raw);
      if (!Number.isFinite(num)) {
        issues.push({ path, message: "Must be a finite number" });
        return undefined;
      }
      return num;
    }
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      if (raw === "true") return true;
      if (raw === "false") return false;
      issues.push({ path, message: "Must be a boolean" });
      return undefined;
    }
    case "enum": {
      if (typeof raw !== "string" || !(param.options || []).includes(raw)) {
        issues.push({ path, message: `Must be one of: ${(param.options || []).join(", ")}` });
        return undefined;
      }
      return raw;
    }
    default:
      issues.push({ path, message: "Unknown parameter type" });
      return undefined;
  }
}

function templateSubstitute(value: unknown, resolved: Map<string, ResolvedValue>, declaredKeys: Set<string>): unknown {
  if (typeof value === "string") {
    const match = value.match(TEMPLATE_RE);
    if (!match) return value;
    const key = match[1];
    if (!declaredKeys.has(key)) {
      throw new Error(`Recipe references undeclared parameter: ${key}`);
    }
    const entry = resolved.get(key);
    if (!entry) {
      throw new Error(`Recipe parameter has no resolved value: ${key}`);
    }
    return entry.value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => templateSubstitute(item, resolved, declaredKeys));
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      output[key] = templateSubstitute(val, resolved, declaredKeys);
    }
    return output;
  }
  return value;
}

export function materializeRecipe(
  recipe: Recipe,
  input: { projectId: string; goal?: string; parameters?: Record<string, unknown> }
): { projectId: string; goal: string; steps: RecipeStepTemplate[]; contractLevel?: Recipe["contractLevel"] } {
  const issues: { path: string; message: string }[] = [];
  const declaredKeys = new Set(recipe.parameters.map((param) => param.key));
  for (const key of Object.keys(input.parameters || {})) {
    if (!declaredKeys.has(key)) issues.push({ path: `parameters.${key}`, message: "Unknown parameter" });
  }

  const resolved = new Map<string, ResolvedValue>();
  for (const param of recipe.parameters) {
    const raw = input.parameters?.[param.key] ?? param.default;
    if (raw === undefined) {
      if (param.required) issues.push({ path: `parameters.${param.key}`, message: "Required parameter is missing" });
      continue;
    }
    const value = coerceParameterValue(param, raw, issues);
    if (value === undefined) continue;
    // A numeric parameter can declare a multiplier so it can be entered in a
    // user-friendly unit (e.g. "Timeout (minutes)") while the template
    // resolves it into the unit a step field actually expects (ms).
    const finalValue = param.type === "number" && param.multiplier ? (value as number) * param.multiplier : value;
    resolved.set(param.key, { type: param.type, value: finalValue });
  }

  if (issues.length) throw new RecipeValidationError(issues);

  const clonedSteps = JSON.parse(JSON.stringify(recipe.steps)) as RecipeStepTemplate[];
  for (const step of clonedSteps) {
    if (step.input) step.input = templateSubstitute(step.input, resolved, declaredKeys) as Record<string, unknown>;
    if (step.qualityGate) {
      step.qualityGate = templateSubstitute(step.qualityGate, resolved, declaredKeys) as NonNullable<RecipeStepTemplate["qualityGate"]>;
    }
    if (step.onBlocked) {
      step.onBlocked = templateSubstitute(step.onBlocked, resolved, declaredKeys) as NonNullable<RecipeStepTemplate["onBlocked"]>;
    }
  }

  return {
    projectId: input.projectId,
    goal: input.goal || recipe.name,
    steps: clonedSteps,
    contractLevel: recipe.contractLevel
  };
}
