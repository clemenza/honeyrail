import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Download, ExternalLink, X } from "lucide-react";
import { API } from "../api.js";
import type { ArtifactData, EvidenceData, StepData } from "../types.js";

type ItemKind = "artifact" | "evidence";

type DrawerView = { mode: "list" } | { mode: "content"; itemId: string };

function compactJson(value: unknown) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function prettyJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// Minimal, dependency-free JSON syntax highlighter over already
// pretty-printed text - avoids pulling in a highlighting library for a
// small, well-understood token shape.
function highlightJson(text: string): React.ReactNode[] {
  const tokenPattern = /("(?:\\.|[^"\\])*"(?:\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let key = 0;
  for (const match of text.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) parts.push(text.slice(lastIndex, index));
    const token = match[0];
    let className = "json-number";
    if (token.startsWith('"')) className = /:\s*$/.test(token) ? "json-key" : "json-string";
    else if (token === "true" || token === "false") className = "json-boolean";
    else if (token === "null") className = "json-null";
    parts.push(<span className={className} key={key++}>{token}</span>);
    lastIndex = index + token.length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
}

function renderInline(text: string, keyPrefix: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={`${keyPrefix}-${i}`}>{part.slice(1, -1)}</code>;
    return <React.Fragment key={`${keyPrefix}-${i}`}>{part}</React.Fragment>;
  });
}

// Small, dependency-free markdown renderer scoped to what honeyrail's own
// report executors actually emit (headings, "- " lists, paragraphs, **bold**,
// `code`) - not a general-purpose markdown implementation.
function renderMarkdown(text: string): React.ReactNode[] {
  const lines = text.split("\n");
  const blocks: React.ReactNode[] = [];
  let listBuffer: string[] = [];
  let key = 0;

  const flushList = () => {
    if (!listBuffer.length) return;
    const items = listBuffer;
    listBuffer = [];
    blocks.push(
      <ul key={`ul-${key++}`}>
        {items.map((item, i) => <li key={i}>{renderInline(item, `li-${key}-${i}`)}</li>)}
      </ul>
    );
  };

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushList();
      const level = Math.min(heading[1].length + 2, 6);
      const Tag = `h${level}` as "h3" | "h4" | "h5" | "h6";
      blocks.push(<Tag key={`h-${key}`}>{renderInline(heading[2], `h-${key++}`)}</Tag>);
      continue;
    }
    const listItem = line.match(/^[-*]\s+(.*)$/);
    if (listItem) {
      listBuffer.push(listItem[1]);
      continue;
    }
    flushList();
    if (!line.trim()) continue;
    blocks.push(<p key={`p-${key}`}>{renderInline(line, `p-${key++}`)}</p>);
  }
  flushList();
  return blocks;
}

const TEXTUAL_MEDIA_TYPES = new Set(["text/plain", "text/markdown", "application/json", "application/sql", "text/x-sql"]);

function isTextualMediaType(mediaType?: string) {
  if (!mediaType) return true;
  if (TEXTUAL_MEDIA_TYPES.has(mediaType)) return true;
  return mediaType.startsWith("text/");
}

function renderTextContent(mediaType: string | undefined, content: string) {
  if (mediaType === "text/markdown") {
    return <div className="markdown-content">{renderMarkdown(content)}</div>;
  }
  if (mediaType === "application/json") {
    let pretty = content;
    try {
      pretty = prettyJson(JSON.parse(content));
    } catch {
      // Not valid JSON (e.g. truncated) - fall back to raw text below.
    }
    return <pre className="content-pre json-pre"><code>{highlightJson(pretty)}</code></pre>;
  }
  const lines = content.split("\n");
  return (
    <pre className="content-pre">
      <code>
        {lines.map((line, i) => (
          <span className="content-line" key={i}>
            <span className="content-line-number">{i + 1}</span>
            <span className="content-line-text">{line}</span>
          </span>
        ))}
      </code>
    </pre>
  );
}

type ContentState = {
  loading: boolean;
  error: string;
  content: string | null;
  truncated: boolean;
};

function ArtifactContentView({ artifact, onBack }: { artifact: ArtifactData; onBack: () => void }) {
  const [state, setState] = useState<ContentState>({ loading: true, error: "", content: null, truncated: false });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, error: "", content: null, truncated: false });
    fetch(`${API}/api/artifacts/${artifact.id}/content`, { credentials: "same-origin" })
      .then(async (response) => {
        if (cancelled) return;
        if (response.status === 404) {
          setState({ loading: false, error: "No file content available for this artifact.", content: null, truncated: false });
          return;
        }
        if (!response.ok) throw new Error(`Failed to load content (${response.status})`);
        const text = await response.text();
        if (cancelled) return;
        setState({ loading: false, error: "", content: text, truncated: response.headers.get("x-artifact-truncated") === "true" });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ loading: false, error: (err as Error).message, content: null, truncated: false });
      });
    return () => {
      cancelled = true;
    };
  }, [artifact.id]);

  const rawUrl = `${API}/api/artifacts/${artifact.id}/content`;

  return (
    <div className="verification-content">
      <div className="verification-content-header">
        <button type="button" className="drawer-back" onClick={onBack}><ArrowLeft size={14} /> Back</button>
        <div>
          <strong>{artifact.name}</strong>
          <small>{artifact.kind}{artifact.mediaType ? ` · ${artifact.mediaType}` : ""}{artifact.attempt !== undefined ? ` · attempt ${artifact.attempt}` : ""}</small>
        </div>
        <div className="verification-content-actions">
          <a className="secondary-button table-action" href={rawUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open raw</a>
          <a className="secondary-button table-action" href={rawUrl} download={artifact.name}><Download size={14} /> Download</a>
        </div>
      </div>
      {state.truncated ? (
        <div className="inline-warning">This artifact is larger than the preview limit - showing a truncated excerpt. Download the full file to see everything.</div>
      ) : null}
      {state.loading ? <div className="verification-loading">Loading…</div> : null}
      {state.error ? <div className="inline-error">{state.error}</div> : null}
      {!state.loading && !state.error && state.content !== null ? (
        isTextualMediaType(artifact.mediaType) ? (
          renderTextContent(artifact.mediaType, state.content)
        ) : (
          <div className="verification-binary-fallback">
            <p>This artifact&apos;s content type ({artifact.mediaType || "unknown"}) can&apos;t be previewed inline. Use Open raw or Download above.</p>
          </div>
        )
      ) : null}
      {artifact.metadata ? (
        <details className="run-verification-detail">
          <summary>Metadata</summary>
          <code>{compactJson(artifact.metadata)}</code>
        </details>
      ) : null}
    </div>
  );
}

function EvidenceContentView({
  evidence,
  artifacts,
  onBack,
  onOpenArtifact
}: {
  evidence: EvidenceData;
  artifacts: ArtifactData[];
  onBack: () => void;
  onOpenArtifact: (artifactId: string) => void;
}) {
  return (
    <div className="verification-content">
      <div className="verification-content-header">
        <button type="button" className="drawer-back" onClick={onBack}><ArrowLeft size={14} /> Back</button>
        <div>
          <strong>{evidence.kind}</strong>
          <small>{evidence.source ? `${evidence.source} · ` : ""}{evidence.attempt !== undefined ? `attempt ${evidence.attempt}` : ""}</small>
        </div>
      </div>
      {evidence.claim ? <p className="verification-claim">{evidence.claim}</p> : null}
      {evidence.value !== undefined ? <pre className="content-pre json-pre"><code>{highlightJson(prettyJson(evidence.value))}</code></pre> : null}
      {evidence.artifactIds?.length ? (
        <div className="verification-linked-artifacts">
          <h4>Linked artifacts</h4>
          <div className="verification-list">
            {evidence.artifactIds.map((id) => {
              const artifact = artifacts.find((item) => item.id === id);
              return (
                <button type="button" className="verification-list-row" key={id} onClick={() => onOpenArtifact(id)}>
                  <strong>{artifact ? artifact.name : id}</strong>
                  {artifact ? <small>{artifact.kind}{artifact.mediaType ? ` · ${artifact.mediaType}` : ""}</small> : <small>Not part of this step</small>}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      {evidence.metadata ? (
        <details className="run-verification-detail">
          <summary>Metadata</summary>
          <code>{compactJson(evidence.metadata)}</code>
        </details>
      ) : null}
    </div>
  );
}

function ItemList({
  kind,
  items,
  onSelect
}: {
  kind: ItemKind;
  items: Array<ArtifactData | EvidenceData>;
  onSelect: (id: string) => void;
}) {
  if (!items.length) {
    return <div className="table-empty">No {kind === "artifact" ? "artifacts" : "evidence"} recorded for this attempt.</div>;
  }
  return (
    <div className="verification-list">
      {items.map((item) => (
        <button type="button" className="verification-list-row" key={item.id} onClick={() => onSelect(item.id)}>
          {kind === "artifact" ? (
            <>
              <strong>{(item as ArtifactData).name}</strong>
              <small>{(item as ArtifactData).kind}{(item as ArtifactData).mediaType ? ` · ${(item as ArtifactData).mediaType}` : ""}</small>
            </>
          ) : (
            <>
              <strong>{(item as EvidenceData).kind}</strong>
              {(item as EvidenceData).claim ? <small>{(item as EvidenceData).claim}</small> : null}
            </>
          )}
          <time>{new Date(item.createdAt).toLocaleString()}</time>
        </button>
      ))}
    </div>
  );
}

export function VerificationDrawer({ step, initialKind, onClose }: { step: StepData; initialKind: ItemKind; onClose: () => void }) {
  const artifacts = useMemo(() => step.verification?.artifactItems || [], [step.verification]);
  const evidenceList = useMemo(() => step.verification?.evidenceItems || [], [step.verification]);

  const attempts = useMemo(() => {
    const set = new Set<number>();
    [...artifacts, ...evidenceList].forEach((item) => set.add(item.attempt ?? 1));
    return Array.from(set).sort((a, b) => a - b);
  }, [artifacts, evidenceList]);

  const defaultAttempt = step.verification?.latestAttempt ?? attempts.at(-1) ?? 1;
  const [activeKind, setActiveKind] = useState<ItemKind>(initialKind);
  const [attemptFilter, setAttemptFilter] = useState<number | "all">(defaultAttempt);
  const [view, setView] = useState<DrawerView>({ mode: "list" });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const filteredArtifacts = useMemo(
    () => (attemptFilter === "all" ? artifacts : artifacts.filter((item) => (item.attempt ?? 1) === attemptFilter)),
    [artifacts, attemptFilter]
  );
  const filteredEvidence = useMemo(
    () => (attemptFilter === "all" ? evidenceList : evidenceList.filter((item) => (item.attempt ?? 1) === attemptFilter)),
    [evidenceList, attemptFilter]
  );

  const openArtifact = (id: string) => {
    setActiveKind("artifact");
    setView({ mode: "content", itemId: id });
  };
  const openEvidence = (id: string) => {
    setActiveKind("evidence");
    setView({ mode: "content", itemId: id });
  };
  const switchKind = (kind: ItemKind) => {
    setActiveKind(kind);
    setView({ mode: "list" });
  };

  const selectedArtifact = view.mode === "content" && activeKind === "artifact" ? artifacts.find((item) => item.id === view.itemId) : undefined;
  const selectedEvidence = view.mode === "content" && activeKind === "evidence" ? evidenceList.find((item) => item.id === view.itemId) : undefined;

  return (
    <div className="verification-drawer-backdrop" role="presentation" onClick={onClose}>
      <aside className="verification-drawer" role="dialog" aria-label="Verification detail" onClick={(event) => event.stopPropagation()}>
        <div className="verification-drawer-header">
          <div>
            <h3>{activeKind === "artifact" ? "Artifacts" : "Evidence"}</h3>
            <p>{step.name} · attempt {attemptFilter === "all" ? "all" : attemptFilter}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="verification-drawer-tabs">
          <button type="button" className={activeKind === "artifact" ? "active" : ""} onClick={() => switchKind("artifact")}>
            Artifacts {artifacts.length}
          </button>
          <button type="button" className={activeKind === "evidence" ? "active" : ""} onClick={() => switchKind("evidence")}>
            Evidence {evidenceList.length}
          </button>
          {attempts.length > 1 ? (
            <select
              value={attemptFilter}
              onChange={(event) => setAttemptFilter(event.target.value === "all" ? "all" : Number(event.target.value))}
              aria-label="Filter by attempt"
            >
              <option value="all">All attempts</option>
              {attempts.map((attempt) => (
                <option value={attempt} key={attempt}>Attempt {attempt}</option>
              ))}
            </select>
          ) : null}
        </div>
        <div className="verification-drawer-body">
          {view.mode === "list" ? (
            activeKind === "artifact" ? (
              <ItemList kind="artifact" items={filteredArtifacts} onSelect={openArtifact} />
            ) : (
              <ItemList kind="evidence" items={filteredEvidence} onSelect={openEvidence} />
            )
          ) : selectedArtifact ? (
            <ArtifactContentView artifact={selectedArtifact} onBack={() => setView({ mode: "list" })} />
          ) : selectedEvidence ? (
            <EvidenceContentView
              evidence={selectedEvidence}
              artifacts={artifacts}
              onBack={() => setView({ mode: "list" })}
              onOpenArtifact={openArtifact}
            />
          ) : (
            <div className="table-empty">Item not found.</div>
          )}
        </div>
      </aside>
    </div>
  );
}
