import React, { useEffect, useState } from "react";
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

// Reflects CheckExecutor's commandsSource (executors/check.ts): whether the
// commands a "check" step ran came from a step-level override or the
// project's configured test commands. Falls back to the pre-run input shape
// (used by RecipeWizard's preview, before any step has executed).
function checkCommandsSource(step: StepLike): "step" | "project" | undefined {
  if (step.executor !== "check") return undefined;
  const outputSource = (step.output as Record<string, unknown> | undefined)?.commandsSource;
  if (outputSource === "step" || outputSource === "project") return outputSource;
  return Array.isArray((step.input as Record<string, unknown> | undefined)?.commands) ? "step" : "project";
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

const FAILURE_KIND_LABEL: Record<string, string> = {
  config_error: "CONFIG ERROR",
  execution_failed: "EXECUTION FAILED",
  verification_failed: "VERIFICATION FAILED"
};

function failureKindLabel(step: StepLike) {
  return FAILURE_KIND_LABEL[step.failureKind || ""] || null;
}

function isQualityGateWaiting(step: StepLike) {
  const gate = step.output?.qualityGate as { status?: string } | undefined;
  return step.status === "waiting_approval" && gate?.status === "waiting_approval";
}

// A step is "agent-blocked" when it's the agent itself asking a clarifying
// question (onBlocked policy territory), as opposed to a dedicated human
// "approval" step or a quality-gate wait_approval — both of those keep using
// the existing Approve/Reject flow below.
export function isAgentBlocked(step: StepLike) {
  return (step.status === "waiting_input" || step.status === "waiting_approval") &&
    step.executor !== "approval" &&
    !isQualityGateWaiting(step);
}

const DEFAULT_ON_BLOCKED_TIMEOUT_MS = 30 * 60_000;

function formatCountdown(ms: number) {
  if (ms <= 0) return "any moment";
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function BlockedCountdown({ blockedSince, timeoutMs }: { blockedSince?: string; timeoutMs: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (!blockedSince) return null;
  const deadline = new Date(blockedSince).getTime() + timeoutMs;
  return <small className="run-step-blocked-countdown">times out in {formatCountdown(deadline - now)}</small>;
}

function BlockedStepPanel({ step, onAnswer, busy }: { step: StepLike; onAnswer?: (stepId: string, text: string) => void; busy?: boolean }) {
  const [text, setText] = useState("");
  const question = String(step.output?.question || "").trim();
  const questionTail = question.split("\n").slice(-20).join("\n");
  const timeoutMs = step.onBlocked?.timeoutMs ?? DEFAULT_ON_BLOCKED_TIMEOUT_MS;

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    onAnswer?.(step.id, value);
    setText("");
  };

  return (
    <div className="run-step-blocked">
      <div className="run-step-blocked-question">
        <StatusPill tone="warn">blocked</StatusPill>
        <BlockedCountdown blockedSince={step.blockedSince} timeoutMs={timeoutMs} />
      </div>
      {questionTail ? <pre className="run-step-blocked-text">{questionTail}</pre> : null}
      <div className="run-step-blocked-answer">
        <input
          type="text"
          placeholder="Type an answer to send to the agent…"
          value={text}
          disabled={Boolean(busy)}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />
        <button type="button" className="secondary-button table-action" disabled={Boolean(busy) || !text.trim()} onClick={submit}>
          Answer
        </button>
      </div>
    </div>
  );
}

export function StepCard({ step, runId, onApprove, onReject, onAnswer, onOpenDrawer, busy }: {
  step: StepLike;
  runId?: string;
  onApprove?: (stepId: string) => void;
  onReject?: (stepId: string) => void;
  onAnswer?: (stepId: string, text: string) => void;
  onOpenDrawer?: (stepId: string, kind: "artifact" | "evidence") => void;
  busy?: boolean;
}) {
  const blocked = isAgentBlocked(step);
  return (
    <div className="run-step">
      <div>
        <strong>{step.name || step.id}</strong>
        <span>{step.executor}{step.attempt !== undefined && step.maxAttempts !== undefined ? ` · attempt ${step.attempt}/${step.maxAttempts}` : ""}</span>
        <small>depends on {step.dependsOn?.length ? step.dependsOn.join(", ") : "none"}</small>
        {step.status === "failed" && failureKindLabel(step) ? (
          <StatusPill tone={step.failureKind === "config_error" ? "warn" : "bad"}>{failureKindLabel(step)}</StatusPill>
        ) : null}
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
          {checkCommandsSource(step) ? <span>Commands: {checkCommandsSource(step) === "step" ? "step override" : "project defaults"}</span> : null}
          <StatusPill tone={evaluationTone(step)}>{evaluationLabel(step)}</StatusPill>
          <StatusPill tone={gateDecisionTone(step)}>{gateDecisionLabel(step)}</StatusPill>
        </div>
        {blocked ? <BlockedStepPanel step={step} onAnswer={onAnswer} busy={busy} /> : null}
      </div>
      {runId && step.status ? (
        <div className="run-step-actions">
          <StatusPill tone={step.status === "succeeded" ? "good" : step.status === "failed" ? "bad" : step.status === "waiting_approval" || blocked ? "warn" : "neutral"}>{step.status}</StatusPill>
          {step.executionRef?.sessionId ? (
            <a className="secondary-button table-action" href={`#/session/${step.executionRef.sessionId}`}>Session <ArrowRight size={14} /></a>
          ) : null}
          {step.status === "waiting_approval" && !blocked ? (
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
