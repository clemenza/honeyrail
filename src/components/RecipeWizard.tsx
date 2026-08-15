import React, { useEffect, useState } from "react";
import { ArrowLeft, X } from "lucide-react";
import { api } from "../api.js";
import type { ProjectData, RecipeParameterData, RecipePreviewData, RecipeSummaryData } from "../types.js";
import { StepCard } from "./StepCard.js";

type WizardStep = "choose" | "configure" | "preview";

function paramValue(paramValues: Record<string, unknown>, param: RecipeParameterData) {
  return paramValues[param.key] !== undefined ? paramValues[param.key] : param.default;
}

function ParamField({ param, value, onChange }: { param: RecipeParameterData; value: unknown; onChange: (value: unknown) => void }) {
  if (param.type === "boolean") {
    return (
      <label>
        {param.label}
        <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />
      </label>
    );
  }
  if (param.type === "enum") {
    return (
      <label>
        {param.label}
        <select value={value === undefined ? "" : String(value)} onChange={(event) => onChange(event.target.value)} required={param.required}>
          <option value="">Select…</option>
          {(param.options || []).map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      </label>
    );
  }
  if (param.type === "number") {
    return (
      <label>
        {param.label}
        <input
          type="number"
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))}
          required={param.required}
        />
      </label>
    );
  }
  return (
    <label>
      {param.label}
      <input
        type="text"
        value={value === undefined || value === null ? "" : String(value)}
        onChange={(event) => onChange(event.target.value)}
        required={param.required}
      />
    </label>
  );
}

export function RecipeWizard({ projects, onCreated, onClose }: {
  projects: ProjectData[];
  onCreated: () => Promise<void>;
  onClose: () => void;
}) {
  const [step, setStep] = useState<WizardStep>("choose");
  const [recipes, setRecipes] = useState<RecipeSummaryData[]>([]);
  const [selectedRecipe, setSelectedRecipe] = useState<RecipeSummaryData | null>(null);
  const [projectId, setProjectId] = useState("");
  const [goal, setGoal] = useState("");
  const [paramValues, setParamValues] = useState<Record<string, unknown>>({});
  const [preview, setPreview] = useState<RecipePreviewData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/api/recipes")
      .then((result) => setRecipes(result.recipes))
      .catch((err: unknown) => setError((err as Error).message));
  }, []);

  const groups = recipes.reduce<Record<string, RecipeSummaryData[]>>((acc, recipe) => {
    const category = recipe.category || "Other";
    acc[category] = acc[category] || [];
    acc[category].push(recipe);
    return acc;
  }, {});

  const chooseRecipe = (recipe: RecipeSummaryData) => {
    setSelectedRecipe(recipe);
    const defaults: Record<string, unknown> = {};
    for (const param of recipe.parameters) {
      if (param.default !== undefined) defaults[param.key] = param.default;
    }
    setParamValues(defaults);
    setGoal(recipe.name);
    setError("");
    setStep("configure");
  };

  const runPreview = async () => {
    if (!selectedRecipe) return;
    setBusy(true);
    setError("");
    try {
      const result = await api(`/api/recipes/${selectedRecipe.id}/preview`, {
        method: "POST",
        body: JSON.stringify({ projectId, goal, parameters: paramValues })
      });
      setPreview(result.run);
      setStep("preview");
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submitRun = async () => {
    if (!selectedRecipe) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/recipes/${selectedRecipe.id}/runs`, {
        method: "POST",
        body: JSON.stringify({ projectId, goal, parameters: paramValues })
      });
      await onCreated();
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const stepLabel = step === "choose" ? "Choose a recipe" : step === "configure" ? "Configure" : "Preview";

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal recipe-wizard-modal" role="dialog" aria-label="New run" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>New run</h2>
            <p>{stepLabel}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="recipe-wizard-body">
          {error ? <div className="inline-error">{error}</div> : null}

          {step === "choose" ? (
            Object.keys(groups).length ? (
              Object.entries(groups).map(([category, categoryRecipes]) => (
                <div className="recipe-card-group" key={category}>
                  <h4>{category}</h4>
                  <div className="recipe-card-grid">
                    {categoryRecipes.map((recipe) => (
                      <button type="button" className="recipe-card" key={recipe.id} onClick={() => chooseRecipe(recipe)}>
                        <strong>{recipe.name}</strong>
                        {recipe.description ? <p>{recipe.description}</p> : null}
                      </button>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <div className="table-empty">No recipes available.</div>
            )
          ) : null}

          {step === "configure" && selectedRecipe ? (
            <div className="form-grid">
              <label>
                Project
                <select value={projectId} onChange={(event) => setProjectId(event.target.value)} required>
                  <option value="">Select project</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>{project.name}</option>
                  ))}
                </select>
              </label>
              <label>
                Goal
                <input value={goal} onChange={(event) => setGoal(event.target.value)} required />
              </label>
              {selectedRecipe.parameters.map((param) => (
                <ParamField
                  key={param.key}
                  param={param}
                  value={paramValue(paramValues, param)}
                  onChange={(value) => setParamValues((current) => ({ ...current, [param.key]: value }))}
                />
              ))}
            </div>
          ) : null}

          {step === "preview" && preview ? (
            <div className="run-steps">
              {preview.steps.map((previewStep) => (
                <StepCard key={previewStep.id} step={previewStep} />
              ))}
              <details className="run-verification-detail">
                <summary>Raw JSON</summary>
                <pre className="content-pre json-pre">{JSON.stringify(preview, null, 2)}</pre>
              </details>
            </div>
          ) : null}
        </div>
        {step === "configure" || step === "preview" ? (
          <div className="modal-footer">
            {step === "configure" ? (
              <>
                <button type="button" className="secondary-button" onClick={() => setStep("choose")} disabled={busy}>
                  <ArrowLeft size={15} /> Back
                </button>
                <button type="button" className="primary-button" onClick={runPreview} disabled={busy || !projectId || !goal}>
                  {busy ? "Building preview" : "Preview"}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="secondary-button" onClick={() => setStep("configure")} disabled={busy}>
                  <ArrowLeft size={15} /> Back
                </button>
                <button type="button" className="primary-button" onClick={submitRun} disabled={busy}>
                  {busy ? "Submitting" : "Submit"}
                </button>
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
