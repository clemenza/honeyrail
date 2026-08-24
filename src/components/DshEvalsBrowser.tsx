import React, { useState } from "react";
import { FlaskConical, RefreshCw, X } from "lucide-react";
import { api } from "../api.js";
import type { DshEvalsStateData, DshTrialArtifactsData, DshTrialRecordData } from "../types.js";

// #118: read-only view onto a scripts/dsh-evals-demo.ts (#93) --out
// directory. Per #93's P0 amendment (following #103), a scored
// dsh-testengineer-trial cell never becomes a HoneyRail Run - it only ever
// exists as local files the driver wrote (state.json, cells/<trialId>/...).
// This component only ever calls the read-only GET /api/evals/dsh-runs*
// routes (server/evals/dsh-run-browser.ts) - it must never create a Run,
// Step, or Worktree, or the whole point of #93/#103's isolation is lost.

function pct(rate: number | null): string {
  return rate === null ? "n/a" : `${Math.round(rate * 1000) / 10}%`;
}

function secs(ms: number | null | undefined): string {
  return typeof ms === "number" ? `${Math.round(ms / 100) / 10}s` : "n/a";
}

const OUTCOME_PILL: Record<string, string> = {
  passed: "pill-good",
  task_failed: "pill-bad",
  verify_failed: "pill-bad",
  invalidated: "pill-bad",
  blocked: "pill-warn",
  driver_error: "pill-warn"
};

function OutcomePill({ outcome }: { outcome: string }) {
  return <span className={`pill ${OUTCOME_PILL[outcome] || "pill-neutral"}`}>{outcome.replace(/_/g, " ")}</span>;
}

function TrialArtifactsModal({ outDir, trial, onClose }: { outDir: string; trial: DshTrialRecordData; onClose: () => void }) {
  const [artifacts, setArtifacts] = useState<DshTrialArtifactsData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    api(`/api/evals/dsh-runs/trial?outDir=${encodeURIComponent(outDir)}&trialId=${encodeURIComponent(trial.trialId)}`)
      .then((result) => { if (!cancelled) setArtifacts(result); })
      .catch((err: unknown) => { if (!cancelled) setError((err as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [outDir, trial.trialId]);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div className="modal" role="dialog" aria-label={`Trial ${trial.trialId}`} onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>{trial.trialId}</h2>
            <p>
              <code>{trial.artifactsDir}</code>
            </p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="dsh-trial-modal-body">
          {error ? <div className="inline-error">{error}</div> : null}
          {loading ? <div className="table-empty"><div className="skeleton skeleton-card" /></div> : null}
          {artifacts ? (
            <>
              <div className="dsh-trial-summary">
                <OutcomePill outcome={trial.outcome} />
                <span>fixture <code>{trial.fixture}</code></span>
                <span>profile <code>{trial.profile}</code></span>
                <span>trial {trial.trial}</span>
                <span>wall time {secs(trial.wallTimeMs)}</span>
                {trial.blockedReason ? <span>blocked: {trial.blockedReason}</span> : null}
                {trial.error ? <span>error: {trial.error}</span> : null}
                {trial.transcriptAuditHits.length ? <span>transcript audit hits: {trial.transcriptAuditHits.join(", ")}</span> : null}
              </div>
              <h3>score.json</h3>
              {artifacts.scoreJson ? (
                <pre className="dsh-trial-artifact">{JSON.stringify(artifacts.scoreJson, null, 2)}</pre>
              ) : (
                <div className="table-empty">No score.json for this trial (it may have failed before scoring).</div>
              )}
              <h3>container.log</h3>
              {artifacts.containerLog ? (
                <pre className="dsh-trial-artifact">{artifacts.containerLog}</pre>
              ) : (
                <div className="table-empty">No container.log for this trial.</div>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function DshEvalsBrowser() {
  const [outDir, setOutDir] = useState("./dsh-evals-report");
  const [state, setState] = useState<DshEvalsStateData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedTrial, setSelectedTrial] = useState<DshTrialRecordData | null>(null);

  const load = async () => {
    if (!outDir.trim()) return;
    setLoading(true);
    setError("");
    try {
      setState(await api(`/api/evals/dsh-runs?outDir=${encodeURIComponent(outDir.trim())}`));
    } catch (err: unknown) {
      setState(null);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="panel table-panel">
      <div className="panel-heading">
        <div>
          <h2>DSH evals driver results</h2>
          <p>Browse a scripts/dsh-evals-demo.ts (#93) --out directory - never a HoneyRail run.</p>
        </div>
        <button type="button" className="secondary-button" onClick={load} disabled={loading || !outDir.trim()}>
          <RefreshCw size={15} /> Load
        </button>
      </div>
      <div className="form-grid">
        <label>
          Output directory
          <input
            value={outDir}
            onChange={(event) => setOutDir(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") load(); }}
            placeholder="./dsh-evals-report"
          />
        </label>
      </div>
      {error ? <div className="inline-error">{error}</div> : null}
      {loading ? <div className="table-empty"><div className="skeleton skeleton-card" /></div> : null}

      {state ? (
        <>
          <p className="subtle">
            dsh <code>{state.config.dshVersion}</code>, image <code>{state.config.image}</code>
            {state.config.smoke ? ", smoke mode" : ""} - <code>{state.outDir}</code>
          </p>

          <h3>Profile summary</h3>
          <div className="dsh-evals-table-scroll">
            <table className="dsh-evals-table">
              <thead>
                <tr>
                  <th>Profile</th><th>Trials</th><th>Passed</th><th>Task failed</th><th>Verify failed</th>
                  <th>Invalidated</th><th>Blocked</th><th>Driver error</th><th>Pass rate</th><th>Mean wall time</th>
                </tr>
              </thead>
              <tbody>
                {state.profileSummaries.map((summary) => (
                  <tr key={summary.profile}>
                    <td><code>{summary.profile}</code></td>
                    <td>{summary.trials}</td>
                    <td>{summary.passed}</td>
                    <td>{summary.taskFailed}</td>
                    <td>{summary.verifyFailed}</td>
                    <td>{summary.invalidated}</td>
                    <td>{summary.blocked}</td>
                    <td>{summary.driverError}</td>
                    <td>{pct(summary.passRate)}</td>
                    <td>{secs(summary.meanWallTimeMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>Per-fixture breakdown</h3>
          <div className="dsh-evals-table-scroll">
            <table className="dsh-evals-table">
              <thead>
                <tr>
                  <th>Fixture</th><th>Profile</th><th>Trials</th><th>Kill rate</th><th>False-alarm rate</th>
                  <th>Contract compliance</th><th>Mean kill rate</th><th>Killed by kind (assertion/invariant)</th><th>Median wall time</th>
                </tr>
              </thead>
              <tbody>
                {state.fixtureCells.map((cell) => (
                  <tr key={`${cell.fixture}-${cell.profile}`}>
                    <td><code>{cell.fixture}</code></td>
                    <td><code>{cell.profile}</code></td>
                    <td>{cell.trials}</td>
                    <td>{pct(cell.killRate)}</td>
                    <td>{pct(cell.falseAlarmRate)}</td>
                    <td>{pct(cell.contractComplianceRate)}</td>
                    <td>{pct(cell.meanKillRate)}</td>
                    <td>{cell.killedByKind ? `${cell.killedByKind.assertion}/${cell.killedByKind.invariant}` : "n/a"}</td>
                    <td>{secs(cell.medianWallTimeMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h3>Per-trial evidence</h3>
          <div className="dsh-evals-table-scroll">
            <table className="dsh-evals-table">
              <thead>
                <tr>
                  <th>Fixture</th><th>Profile</th><th>Trial</th><th>Outcome</th><th>Killed</th>
                  <th>False alarms</th><th>Contract OK</th><th>Integrity OK</th><th>Wall time</th><th></th>
                </tr>
              </thead>
              <tbody>
                {state.trials.map((trial) => (
                  <tr key={trial.trialId}>
                    <td><code>{trial.fixture}</code></td>
                    <td><code>{trial.profile}</code></td>
                    <td>{trial.trial}</td>
                    <td><OutcomePill outcome={trial.outcome} /></td>
                    <td>{trial.killed === null ? "n/a" : String(trial.killed)}</td>
                    <td>{trial.falseAlarms ?? "n/a"}</td>
                    <td>{trial.contractOk === null ? "n/a" : String(trial.contractOk)}</td>
                    <td>{String(trial.integrityOk)}</td>
                    <td>{secs(trial.wallTimeMs)}</td>
                    <td>
                      <button type="button" className="table-action" onClick={() => setSelectedTrial(trial)}>
                        <FlaskConical size={14} /> Artifacts
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!state.trials.length ? <div className="table-empty">No trials recorded in this state.json yet.</div> : null}
        </>
      ) : !loading && !error ? (
        <div className="table-empty">Enter a --out directory from a scripts/dsh-evals-demo.ts run and click Load.</div>
      ) : null}

      {selectedTrial && state ? (
        <TrialArtifactsModal outDir={state.outDir} trial={selectedTrial} onClose={() => setSelectedTrial(null)} />
      ) : null}
    </section>
  );
}
