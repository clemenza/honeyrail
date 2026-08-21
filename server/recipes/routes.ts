import { Router } from "express";
import { validate, createRunBody, recipeRunBody } from "../validation.js";
import { asyncRoute, httpError } from "../route-context.js";
import type { OrchestrationService } from "../orchestration/service.js";
import { RecipeValidationError, materializeRecipe, type RecipeRegistry } from "./registry.js";

export function recipeRoutes(registry: RecipeRegistry, orchestration: OrchestrationService) {
  const router = Router();

  router.get("/api/recipes", asyncRoute(async (_req, res) => {
    res.json({ recipes: registry.list() });
  }));

  router.get("/api/recipes/:id", asyncRoute(async (req, res) => {
    const recipe = registry.get(String(req.params.id));
    if (!recipe) return res.status(404).json({ error: "Recipe not found" });
    res.json({ recipe });
  }));

  router.post("/api/recipes/:id/preview", validate(recipeRunBody), asyncRoute(async (req, res) => {
    const recipe = registry.get(String(req.params.id));
    if (!recipe) throw httpError(404, "Recipe not found");
    let materialized;
    try {
      materialized = materializeRecipe(recipe, req.body);
    } catch (error) {
      if (error instanceof RecipeValidationError) throw httpError(400, error.message);
      throw error;
    }
    const parsed = createRunBody.parse(materialized);
    try {
      await orchestration.preflightRun(parsed);
    } catch (error) {
      throw httpError((error as Error).message === "Project not found" ? 404 : 400, (error as Error).message);
    }
    res.json({ run: parsed });
  }));

  router.post("/api/recipes/:id/runs", validate(recipeRunBody), asyncRoute(async (req, res) => {
    const recipe = registry.get(String(req.params.id));
    if (!recipe) throw httpError(404, "Recipe not found");
    // #109: a run created here shares the registered project's real repo
    // filesystem with the agent - the exact #103 failure mode for a recipe
    // class whose only safe launch path is an isolated driver script.
    if (recipe.launchDisabled) {
      throw httpError(403, recipe.launchDisabledReason || `Recipe "${recipe.id}" cannot be launched as a HoneyRail run.`);
    }
    let materialized;
    try {
      materialized = materializeRecipe(recipe, req.body);
    } catch (error) {
      if (error instanceof RecipeValidationError) throw httpError(400, error.message);
      throw error;
    }
    const parsed = createRunBody.parse(materialized);
    let result;
    try {
      result = await orchestration.createRun(parsed);
    } catch (error) {
      throw httpError((error as Error).message === "Project not found" ? 404 : 400, (error as Error).message);
    }
    res.status(201).json(result);
  }));

  return router;
}
