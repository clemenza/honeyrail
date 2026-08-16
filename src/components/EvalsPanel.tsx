import React, { useEffect, useState } from "react";
import { Gauge, RefreshCw } from "lucide-react";
import { api } from "../api.js";
import type { EvalMetricsData, ProjectData, RateStatData } from "../types.js";

const METRIC_LABELS: Array<[keyof EvalMetricsData, string, string]> = [
  ["contractCompliance", "Contract compliance", "Steps that produced everything their recipe declared"],
  ["manifestEmission", "Manifest emission", "Succeeded agent steps that left a manifest-described artifact"],
  ["verifyRunnable", "Verify runnable", "Check steps that actually ran, not skipped for an upstream failure"],
  ["qualityGatePass", "Quality gate pass", "Gate decisions that passed without a human"],
  ["humanOverride", "Human override", "Gate decisions that needed an operator to override or reject"],
  ["blockedStep", "Blocked step", "Unattended agent steps that stopped to ask a clarifying question"]
];

function MetricTile({ label, hint, stat }: { label: string; hint: string; stat: RateStatData }) {
  const pct = stat.rate === null ? "—" : `${Math.round(stat.rate * 100)}%`;
  return (
    <div className="eval-metric-card">
      <span>{label}</span>
      <strong>{pct}</strong>
      <small>{stat.total ? `${stat.satisfied} / ${stat.total}` : "No matching data"}</small>
      <small className="subtle">{hint}</small>
    </div>
  );
}

export function EvalsPanel({ projects }: { projects: ProjectData[] }) {
  const [projectId, setProjectId] = useState("");
  const [recipeId, setRecipeId] = useState("");
  const [contractLevel, setContractLevel] = useState("");
  const [promptVersion, setPromptVersion] = useState("");
  const [metrics, setMetrics] = useState<EvalMetricsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (projectId) params.set("projectId", projectId);
      if (recipeId.trim()) params.set("recipeId", recipeId.trim());
      if (contractLevel) params.set("contractLevel", contractLevel);
      if (promptVersion.trim()) params.set("promptVersion", promptVersion.trim());
      const query = params.toString();
      const result = await api(`/api/evals/metrics${query ? `?${query}` : ""}`);
      setMetrics(result);
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // Only auto-load once on mount; filter changes apply via the button so
    // typing a recipe/prompt version doesn't refetch on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="panel table-panel">
      <div className="panel-heading">
        <div>
          <h2>Harness evals</h2>
          <p>{metrics ? `${metrics.runCount} run${metrics.runCount === 1 ? "" : "s"} matched` : "Aggregate reliability metrics across persisted runs"}</p>
        </div>
        <button type="button" className="secondary-button" onClick={load} disabled={loading}>
          <RefreshCw size={15} /> Refresh
        </button>
      </div>
      {error ? <div className="inline-error">{error}</div> : null}
      <div className="form-grid">
        <label>
          Project
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            <option value="">All projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>{project.name}</option>
            ))}
          </select>
        </label>
        <label>
          Contract level
          <select value={contractLevel} onChange={(event) => setContractLevel(event.target.value)}>
            <option value="">Any</option>
            <option value="L0">L0</option>
            <option value="L1">L1</option>
            <option value="L2">L2</option>
            <option value="L3">L3</option>
          </select>
        </label>
        <label>
          Recipe id
          <input value={recipeId} onChange={(event) => setRecipeId(event.target.value)} placeholder="implement-check-gate-approve" />
        </label>
        <label>
          Prompt version
          <input value={promptVersion} onChange={(event) => setPromptVersion(event.target.value)} placeholder="1" />
        </label>
      </div>
      <button type="button" className="primary-button" onClick={load} disabled={loading}>
        <Gauge size={16} /> {loading ? "Loading" : "Apply filters"}
      </button>
      {metrics ? (
        <div className="eval-metrics-grid">
          {METRIC_LABELS.map(([key, label, hint]) => (
            <MetricTile key={key} label={label} hint={hint} stat={metrics[key] as RateStatData} />
          ))}
        </div>
      ) : loading ? (
        <div className="table-empty">
          <div className="skeleton skeleton-card" />
        </div>
      ) : null}
    </section>
  );
}
