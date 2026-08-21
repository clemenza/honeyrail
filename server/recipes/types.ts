import type { ContractLevel, OnBlockedPolicy, QualityGate } from "../types.js";

export type RecipeParameterType = "string" | "number" | "boolean" | "enum";

export type RecipeParameter = {
  key: string;
  label: string;
  type: RecipeParameterType;
  default?: unknown;
  required?: boolean;
  options?: string[];
  /** For type "number": multiplies the resolved value before templating, so a user-friendly unit (e.g. minutes) can resolve into what a step field actually expects (e.g. ms). */
  multiplier?: number;
};

export type RecipeStepTemplate = {
  id: string;
  name?: string;
  executor: string;
  input?: Record<string, unknown>;
  dependsOn?: string[];
  maxAttempts?: number;
  qualityGate?: QualityGate;
  onBlocked?: OnBlockedPolicy;
  produces?: string[];
  consumes?: string[];
};

export type Recipe = {
  id: string;
  name: string;
  description?: string;
  category?: string;
  /** Defaults to "L1" (see ContractLevel) when a recipe doesn't declare one. */
  contractLevel?: ContractLevel;
  /** Concurrency ceiling applied to every run created from this recipe - see Run.maxParallel (#78). Omit for unlimited parallelism. */
  maxParallel?: number;
  /**
   * #109: when true, POST /api/recipes/:id/runs (the "New run" wizard's
   * launch path, which hands the agent shared filesystem access to a
   * registered project's real repo) refuses to launch this recipe at all -
   * see launchDisabledReason. GET/preview stay available so the recipe is
   * still visible and inspectable; only creating a real Run through this
   * shared-filesystem path is blocked. Exists for recipe classes (like
   * dsh-testengineer-trial, #103) whose only safe launch path is a
   * dedicated isolated driver, never a HoneyRail Run.
   */
  launchDisabled?: boolean;
  /** Shown in the 403 from POST /api/recipes/:id/runs and in the "New run" UI when launchDisabled is true. */
  launchDisabledReason?: string;
  parameters: RecipeParameter[];
  steps: RecipeStepTemplate[];
};

export type RecipeSummary = Omit<Recipe, "steps">;
