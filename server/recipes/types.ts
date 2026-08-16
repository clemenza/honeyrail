import type { OnBlockedPolicy, QualityGate } from "../types.js";

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
};

export type Recipe = {
  id: string;
  name: string;
  description?: string;
  category?: string;
  parameters: RecipeParameter[];
  steps: RecipeStepTemplate[];
};

export type RecipeSummary = Omit<Recipe, "steps">;
