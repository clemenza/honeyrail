import type { QualityGate } from "../types.js";

export type RecipeParameterType = "string" | "number" | "boolean" | "enum";

export type RecipeParameter = {
  key: string;
  label: string;
  type: RecipeParameterType;
  default?: unknown;
  required?: boolean;
  options?: string[];
};

export type RecipeStepTemplate = {
  id: string;
  name?: string;
  executor: string;
  input?: Record<string, unknown>;
  dependsOn?: string[];
  maxAttempts?: number;
  qualityGate?: QualityGate;
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
