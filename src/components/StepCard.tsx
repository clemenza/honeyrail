import React from "react";
import { ArrowRight, Shield, XCircle } from "lucide-react";
import type { StepData } from "../types.js";
import { StatusPill } from "./layout.js";

type StepLike = Partial<StepData> & { id: string; name?: string; executor: string; dependsOn?: string[] };

function evaluationTone(step: StepLike) {
  const evaluations = step.verification?.evaluations;
  if (!evaluations || evaluations.passed + evaluations.failed + evaluations.error === 0) return "neutral";
  if (evaluations.error || evaluations.failed) return "bad";
  return "good";
}

function evaluationLabel(step: StepLike) {
  const evaluations = step.verification?.evaluations;
  if (!evaluations || evaluations.passed + evaluations.failed + evaluations.error === 0) return "not evaluated";
  if (evaluations.error) return "ERROR";
  if (evaluations.failed) return "FAIL";
  return "PASS";
}

function latestGateDecision(step: StepLike) {
  return step.verification?.gateDecisionItems?.at(-1);
}

function gateDecisionTone(step: StepLike) {
  const decision = latestGateDecision(step);
  if (!decision) return "neutral";
  if (decision.status === "passed") return "good";
  if (decision.status === "overridden") return "warn";
  return "bad";
}

function gateDecisionLabel(step: StepLike) {
  const decision = latestGateDecision(step);
  if (!decision) return "no gate decision";
  if (decision.status === "overridden") return "OVERRIDDEN";
  return decision.status.toUpperCase();
}

export function StepCard({ step, runId, onApprove, onReject, onOpenDrawer, busy }: {
  step: StepLike;
  runId?: string;
  onApprove?: (stepId: string) => void;
  onReject?: (stepId: string) => void;
  onOpenDrawer?: (stepId: string, kind: "artifact" | "evidence") => void;
  busy?: boolean;
}) {
  return (
    <div className="run-step">
      <div>
        <strong>{step.name || step.id}</strong>
        <span>{step.executor}{step.attempt !== undefined && step.maxAttempts !== undefined ? ` · attempt ${step.attempt}/${step.maxAttempts}` : ""}</span>
        <small>depends on {step.dependsOn?.length ? step.dependsOn.join(", ") : "none"}</small>
        {step.error ? <small className="run-step-error">{step.error}</small> : null}
        <div className="run-verification">
          <button
            type="button"
            className="verification-count-button"
            disabled={!step.verification?.artifacts}
            onClick={() => onOpenDrawer?.(step.id, "artifact")}
          >
            Artifacts {step.verification?.artifacts || 0}
          </button>
          <button
            type="button"
            className="verification-count-button"
            disabled={!step.verification?.evidence}
            onClick={() => onOpenDrawer?.(step.id, "evidence")}
          >
            Evidence {step.verification?.evidence || 0}
          </button>
          {step.verification?.latestAttempt ? <span>Latest attempt {step.verification.latestAttempt}</span> : null}
          <StatusPill tone={evaluationTone(step)}>{evaluationLabel(step)}</StatusPill>
          <StatusPill tone={gateDecisionTone(step)}>{gateDecisionLabel(step)}</StatusPill>
        </div>
      </div>
      {runId && step.status ? (
        <div className="run-step-actions">
          <StatusPill tone={step.status === "succeeded" ? "good" : step.status === "failed" ? "bad" : step.status === "waiting_approval" ? "warn" : "neutral"}>{step.status}</StatusPill>
          {step.executionRef?.sessionId ? (
            <a className="secondary-button table-action" href={`#/session/${step.executionRef.sessionId}`}>Session <ArrowRight size={14} /></a>
          ) : null}
          {step.status === "waiting_approval" ? (
            <>
              <button type="button" className="secondary-button table-action" disabled={Boolean(busy)} onClick={() => onApprove?.(step.id)}>
                <Shield size={14} /> Approve
              </button>
              <button type="button" className="secondary-button table-action danger" disabled={Boolean(busy)} onClick={() => onReject?.(step.id)}>
                <XCircle size={14} /> Reject
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
