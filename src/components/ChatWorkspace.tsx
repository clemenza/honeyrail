import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CircleStop,
  CornerDownLeft,
  FileText,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  RefreshCw,
  Send,
  SquareTerminal,
  Trash2,
  Workflow,
  X
} from "lucide-react";
import { api } from "../api.js";
import { agentActivityText, cleanRuntimeOutput } from "../activity.js";
import type { EventData, ImageAttachmentLocal, SessionData, SummaryData } from "../types.js";
import { fileToAttachment, formatBytes, formatClock, imageFileToAttachment, sessionTone, summaryBlocks } from "../utils.js";
import { IconButton, StatusPill } from "./layout.js";

function SummaryMarkdown({ text, loading }: { text: string; loading: boolean }) {
  const blocks = useMemo(() => summaryBlocks(text), [text]);

  if (loading && !text) {
    return (
      <div className="summary-empty">
        <RefreshCw size={18} />
        <span>Summarizing session...</span>
      </div>
    );
  }

  if (!blocks.length) {
    return <div className="summary-empty">No summary yet.</div>;
  }

  return (
    <div className="summary-markdown">
      {blocks.map((block, index) => {
        if (block.type === "heading") {
          return <h3 key={`${block.type}-${index}`}>{block.text}</h3>;
        }
        if (block.type === "section") {
          return (
            <section className="summary-section" key={`${block.type}-${index}`}>
              <h3>{block.title}</h3>
              <p>{block.text}</p>
            </section>
          );
        }
        if (block.type === "list") {
          return (
            <ul className="summary-list" key={`${block.type}-${index}`}>
              {block.items.map((item, itemIndex) => <li key={`${item}-${itemIndex}`}>{item}</li>)}
            </ul>
          );
        }
        return <p className="summary-paragraph" key={`${block.type}-${index}`}>{block.text}</p>;
      })}
    </div>
  );
}

export function ChatWorkspace({ sessions, events, selectedSessionId, setSelectedSessionId, refresh, onBackToManagement, onSessionChange }: {
  sessions: SessionData[];
  events: EventData[];
  selectedSessionId: string;
  setSelectedSessionId: (id: string) => void;
  refresh: () => Promise<void>;
  onBackToManagement: () => void;
  onSessionChange: (sessionId: string) => void;
}) {
  const [output, setOutput] = useState("");
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<ImageAttachmentLocal[]>([]);
  const [error, setError] = useState("");
  const [controlsOpen, setControlsOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"chat" | "terminal" | "summary">("chat");
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [inputSending, setInputSending] = useState(false);
  const [keySending, setKeySending] = useState(false);
  const inputSendingRef = useRef(false);
  const keySendingRef = useRef(false);
  const loadOutputAbortRef = useRef<AbortController | null>(null);
  const selected = sessions.find((session) => session.id === selectedSessionId) || (!selectedSessionId ? sessions.at(-1) : null);
  const selectedIdRef = useRef(selected?.id);
  selectedIdRef.current = selected?.id;
  const selectedIsRunning = ["running", "waiting_approval", "waiting_input", "idle", "stale"].includes(String(selected?.status || ""));
  const selectedModel = selected?.model || "";
  const sessionEvents = events
    .filter((event) => event.sessionId === selected?.id)
    .slice()
    .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
  const userPrompts = sessionEvents.filter((event) => event.type === "session.input_sent");
  const agentActivity = agentActivityText({ selected, selectedIsRunning, output, userPrompts });

  useEffect(() => {
    if (selected?.id && !selectedSessionId) setSelectedSessionId(selected.id);
  }, [selected?.id]);

  useEffect(() => {
    setAttachments([]);
    setError("");
    setViewMode("chat");
    setSummary(selected?.summary || null);
  }, [selected?.id]);

  useEffect(() => {
    setSummary(selected?.summary || null);
  }, [selected?.summary?.generatedAt]);

  const loadOutput = async () => {
    if (!selected) return;
    const sessionId = selected.id;
    // Cancel any in-flight request so a slow response for a previous session
    // can't land after we've already moved on and clobber fresher output.
    loadOutputAbortRef.current?.abort();
    const controller = new AbortController();
    loadOutputAbortRef.current = controller;
    let result: { output: string };
    try {
      result = await api(`/api/sessions/${sessionId}/output?lines=200`, { signal: controller.signal });
    } catch (err: unknown) {
      if ((err as { name?: string })?.name === "AbortError") return;
      throw err;
    }
    // Guard against stale responses that resolve after the selected session
    // has changed again (e.g. rapid session switching).
    if (selectedIdRef.current !== sessionId) return;
    setOutput(result.output);
    setError("");
  };

  const summarizeSession = async () => {
    if (!selected) return;
    setSummaryLoading(true);
    setError("");
    setViewMode("summary");
    try {
      const result = await api(`/api/sessions/${selected.id}/summarize`, {
        method: "POST",
        body: JSON.stringify({ lines: 800 })
      });
      setSummary(result.summary);
      await refresh();
    } catch (err: unknown) {
      setError((err as Error).message || "Failed to summarize session.");
    } finally {
      setSummaryLoading(false);
    }
  };

  useEffect(() => {
    loadOutput().catch(() => {});
    return () => {
      loadOutputAbortRef.current?.abort();
    };
  }, [selected?.id]);

  useEffect(() => {
    if (!selectedIsRunning) return undefined;
    const timer = window.setInterval(() => {
      loadOutput().catch(() => {});
    }, 2500);
    return () => window.clearInterval(timer);
  }, [selected?.id, selectedIsRunning]);

  const addImageFiles = async (files: FileList | File[] | null) => {
    const images = Array.from(files || []).filter((file: File) => file.type?.startsWith("image/"));
    if (!images.length) {
      setError("Only image files can be attached.");
      return;
    }
    try {
      const nextAttachments = await Promise.all(images.map(imageFileToAttachment));
      setAttachments((current) => [...current, ...nextAttachments].slice(0, 6));
      setError("");
    } catch (err: unknown) {
      setError((err as Error).message || "Failed to attach image.");
    }
  };

  const addAnyFiles = async (files: FileList | File[] | null) => {
    const fileArray = Array.from(files || []);
    if (!fileArray.length) return;
    try {
      const nextAttachments = await Promise.all(fileArray.map(fileToAttachment));
      setAttachments((current) => [...current, ...nextAttachments].slice(0, 6));
      setError("");
    } catch (err: unknown) {
      setError((err as Error).message || "Failed to attach file.");
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id));
  };

  const sendInputPayload = async (payloadText: string, payloadAttachments: Array<{ name: string; type: string; dataUrl: string }> = []) => {
    if (!selected || inputSendingRef.current || (!String(payloadText || "").trim() && !payloadAttachments.length)) return false;
    inputSendingRef.current = true;
    setInputSending(true);
    try {
      await api(`/api/sessions/${selected.id}/input`, {
        method: "POST",
        body: JSON.stringify({
          text: payloadText,
          attachments: payloadAttachments
        })
      });
      await loadOutput();
      await refresh();
      return true;
    } catch (err: unknown) {
      setError((err as Error).message);
      await refresh();
      return false;
    } finally {
      inputSendingRef.current = false;
      setInputSending(false);
    }
  };

  const sendInput = async () => {
    const sent = await sendInputPayload(text, attachments.map(({ name, type, dataUrl }) => ({ name, type, dataUrl })));
    if (sent) {
      setText("");
      setAttachments([]);
    }
  };

  const sendKey = async (key: string) => {
    if (!selected || keySendingRef.current) return;
    keySendingRef.current = true;
    setKeySending(true);
    try {
      await api(`/api/sessions/${selected.id}/key`, {
        method: "POST",
        body: JSON.stringify({ key })
      });
      await loadOutput();
    } catch (err: unknown) {
      setError((err as Error).message);
      await refresh();
    } finally {
      keySendingRef.current = false;
      setKeySending(false);
    }
  };

  const stop = async () => {
    if (!selected) return;
    await api(`/api/sessions/${selected.id}/stop`, { method: "POST", body: JSON.stringify({}) });
    await refresh();
  };

  const deleteSelectedSession = async () => {
    if (!selected) return;
    try {
      const deletedId = selected.id;
      await api(`/api/sessions/${deletedId}`, { method: "DELETE" });
      const remaining = sessions.filter((session) => session.id !== deletedId);
      const nextSessionId = remaining.at(-1)?.id || "";
      setSelectedSessionId(nextSessionId);
      setOutput("");
      setControlsOpen(false);
      setViewMode("chat");
      setError("");
      await refresh();
      if (nextSessionId) {
        onSessionChange?.(nextSessionId);
      } else {
        onBackToManagement?.();
      }
    } catch (err: unknown) {
      setError((err as Error).message);
      await refresh();
    }
  };

  const navKeys = [
    { label: "Up", icon: ArrowUp, key: "Up" },
    { label: "Down", icon: ArrowDown, key: "Down" },
    { label: "Left", icon: ArrowLeft, key: "Left" },
    { label: "Right", icon: ArrowRight, key: "Right" },
    { label: "Tab", icon: ArrowRight, key: "Tab" },
    { label: "Esc", icon: X, key: "Escape" },
    { label: "Enter", icon: CornerDownLeft, key: "Enter" }
  ];
  const quickActions = [
    { label: "Continue", action: () => sendInputPayload("continue"), disabled: !selectedIsRunning || inputSending },
    { label: "Approve", action: () => sendInputPayload("y"), disabled: !selectedIsRunning || inputSending },
    { label: "Deny", action: () => sendInputPayload("n"), disabled: !selectedIsRunning || inputSending },
    { label: "Esc", action: () => sendKey("Escape"), disabled: !selectedIsRunning || keySending },
    { label: "Tab", action: () => sendKey("Tab"), disabled: !selectedIsRunning || keySending },
    { label: "Ctrl-C", action: () => sendKey("C-c"), disabled: !selectedIsRunning || keySending }
  ];

  const summaryText = summary?.text || selected?.summary?.text || "";

  return (
    <section className={`chat-workspace session-page-workspace ${["terminal", "summary"].includes(viewMode) ? "terminal-fullscreen" : ""}`}>
      <div className="chat-main">
        {/* Header Row 1: Back + Name + Status + Overflow */}
        <div className="chat-header">
          <div className="chat-header-left">
            <button type="button" className="icon-button" onClick={onBackToManagement} aria-label="Back to management">
              <ArrowLeft size={16} />
            </button>
            <h2>{selected ? selected.name : "No session"}</h2>
            {selected ? <StatusPill tone={sessionTone(selected.status)}>{selected.status}</StatusPill> : null}
          </div>
          <div className="chat-header-right">
            {selectedModel ? <StatusPill tone="neutral">{selectedModel}</StatusPill> : null}
            <IconButton icon={RefreshCw} label="Refresh transcript" onClick={loadOutput} disabled={!selected} />
            <button
              type="button"
              className={`icon-button ${viewMode === "summary" ? "icon-button-good" : ""}`}
              onClick={() => summaryText ? setViewMode("summary") : summarizeSession()}
              disabled={!selected}
              aria-label={summaryLoading ? "Summarizing" : "Summary"}
              title="Summary"
            >
              <FileText size={16} />
            </button>
            <div className="session-controls">
              <button type="button" className="icon-button" onClick={() => setControlsOpen((v) => !v)} aria-label="Session controls">
                <Workflow size={16} />
              </button>
              {controlsOpen ? (
                <>
                  <div className="session-controls-backdrop" onClick={() => setControlsOpen(false)} />
                  <div className="session-controls-popup">
                    <div className="session-control-grid">
                      {navKeys.map((control) => {
                        const Icon = control.icon;
                        return (
                          <button key={control.key} type="button" className="secondary-button" onClick={() => { sendKey(control.key); setControlsOpen(false); }} disabled={!selectedIsRunning || keySending}>
                            <Icon size={16} /> {control.label}
                          </button>
                        );
                      })}
                    </div>
                    <button type="button" className="secondary-button" onClick={() => { sendInputPayload("y"); setControlsOpen(false); }} disabled={!selectedIsRunning || inputSending}>
                      <CornerDownLeft size={16} /> Approve
                    </button>
                    <button type="button" className="secondary-button" onClick={() => { sendInputPayload("n"); setControlsOpen(false); }} disabled={!selectedIsRunning || inputSending}>
                      <X size={16} /> Reject
                    </button>
                    <button type="button" className="secondary-button danger" onClick={() => { sendKey("C-c"); setControlsOpen(false); }} disabled={!selectedIsRunning || keySending}>
                      <CircleStop size={16} /> Interrupt
                    </button>
                    <button type="button" className="secondary-button danger" onClick={() => { stop(); setControlsOpen(false); }} disabled={!selectedIsRunning}>
                      <CircleStop size={16} /> Stop
                    </button>
                    <button type="button" className="secondary-button danger" onClick={deleteSelectedSession} disabled={!selected}>
                      <Trash2 size={16} /> Delete session
                    </button>
                  </div>
                </>
              ) : null}
            </div>
          </div>
        </div>

        {/* Header Row 2: View Toggle */}
        <div className="chat-header-row2">
          <div className="view-toggle" role="tablist" aria-label="Session view">
            <button type="button" className={viewMode === "chat" ? "active" : ""} onClick={() => setViewMode("chat")} disabled={!selected} aria-pressed={viewMode === "chat"}>
              <MessageSquare size={15} /> Chat
            </button>
            <button
              type="button"
              className={viewMode === "terminal" ? "active" : ""}
              onClick={() => setViewMode(viewMode === "terminal" ? "chat" : "terminal")}
              disabled={!selected}
              aria-pressed={viewMode === "terminal"}
            >
              <SquareTerminal size={15} /> Terminal
            </button>
            <button
              type="button"
              className={viewMode === "summary" ? "active" : ""}
              onClick={() => summaryText ? setViewMode("summary") : summarizeSession()}
              disabled={!selected}
              aria-pressed={viewMode === "summary"}
            >
              <FileText size={15} /> Summary
            </button>
          </div>
        </div>

      {selected?.error ? (
        <div className="inline-error" style={{ margin: "0 16px" }}>
          <strong>Action required:</strong> {selected.error}
        </div>
      ) : selected && !selectedIsRunning && selected.status !== "completed" ? (
        <div className="inline-warning" style={{ margin: "0 16px" }}>
          This session is {selected.status}. Start a new session before sending prompts.
        </div>
      ) : null}
        {error ? <div className="inline-error" style={{ margin: "0 16px" }}>{error}</div> : null}

        {viewMode === "chat" ? (
          <div className="chat-thread" aria-label="Session chat">
            {!selected ? (
              <div className="chat-empty">
                <MessageSquare size={24} />
                <h2>No session selected</h2>
                <p>Start or select an agent session to chat with it remotely.</p>
              </div>
            ) : null}
            {selected && !userPrompts.length && !output ? (
              <div className="chat-empty">
                <MessageSquare size={24} />
                <h2>Ready for instructions</h2>
                <p>Send the first prompt from the composer below.</p>
              </div>
            ) : null}
            {userPrompts.map((event) => (
              <article className="chat-message chat-message-user" key={event.id || event.createdAt}>
                <div className="message-meta">You · {formatClock(event.createdAt)}</div>
                <div className="message-bubble">
                  <div>{event.payload?.preview || (event.payload?.attachments?.length ? "Attached image input" : "Prompt sent")}</div>
                  {event.payload?.attachments?.length ? (
                    <div className="message-attachments">
                      {event.payload.attachments.map((attachment) => (
                        <figure className="message-attachment" key={attachment.id || attachment.fileName}>
                          <img src={attachment.thumbnailDataUrl || attachment.url} alt={attachment.name || "Attached image"} />
                          <figcaption>{attachment.name || "image"} · {formatBytes(attachment.size ?? 0)}</figcaption>
                        </figure>
                      ))}
                    </div>
                  ) : null}
                </div>
              </article>
            ))}
            {selected && agentActivity ? (
              <article className="chat-message chat-message-agent">
                <div className="message-bubble agent-card">
                  <div className="agent-avatar"><SquareTerminal size={17} /></div>
                  <div className="agent-card-body">
                    <strong>{selectedIsRunning ? "Agent is working" : "Agent session"}</strong>
                    <p>{agentActivity}</p>
                  </div>
                </div>
              </article>
            ) : null}
          </div>
        ) : viewMode === "terminal" ? (
          <section className="terminal-view" role="complementary" aria-label="Runtime transcript">
            <div className="session-view-header">
              <div>
                <strong>Terminal transcript</strong>
                <span>Raw-ish cleaned runtime output, optimized for mobile review.</span>
              </div>
              <button type="button" className="secondary-button" onClick={loadOutput} disabled={!selected}>
                <RefreshCw size={15} /> Refresh
              </button>
            </div>
            <pre>{cleanRuntimeOutput(output) || "No runtime output."}</pre>
          </section>
        ) : (
          <section className="summary-view" role="complementary" aria-label="Session summary">
            <div className="session-view-header">
              <div>
                <strong>Session summary</strong>
                <span>Readable review of work, files, tests, blockers, and next steps.</span>
              </div>
              <button type="button" className="secondary-button" onClick={summarizeSession} disabled={!selected || summaryLoading}>
                <RefreshCw size={15} /> {summaryLoading ? "Summarizing" : "Regenerate"}
              </button>
            </div>
            <SummaryMarkdown text={summaryText} loading={summaryLoading} />
          </section>
        )}

        <div className="chat-composer" onDrop={(event) => {
          event.preventDefault();
          addAnyFiles(event.dataTransfer.files);
        }} onDragOver={(event) => event.preventDefault()}>
          <div className="quick-action-strip" aria-label="Quick session actions">
            {quickActions.map((action) => (
              <button key={action.label} type="button" className={action.label === "Ctrl-C" ? "danger" : ""} onClick={action.action} disabled={action.disabled}>
                {action.label}
              </button>
            ))}
          </div>
          <div className="composer-input-stack">
            {attachments.length ? (
              <div className="attachment-strip" aria-label="Attached files">
                {attachments.map((attachment) => (
                  <figure className="attachment-preview" key={attachment.id}>
                    {attachment.type.startsWith("image/") ? (
                      <img src={attachment.dataUrl} alt={attachment.name} />
                    ) : (
                      <div className="file-attachment-icon"><FileText size={28} /></div>
                    )}
                    <figcaption>
                      <span>{attachment.name}</span>
                      <small>{formatBytes(attachment.size)}</small>
                    </figcaption>
                    <button type="button" onClick={() => removeAttachment(attachment.id)} aria-label={`Remove ${attachment.name}`}>
                      <Trash2 size={14} />
                    </button>
                  </figure>
                ))}
              </div>
            ) : null}
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              onPaste={(event) => {
                const files = event.clipboardData?.files;
                if (files?.length) {
                  const images = Array.from(files as FileList).filter((file) => file.type?.startsWith("image/"));
                  if (images.length) {
                    event.preventDefault();
                    addImageFiles(images);
                  }
                }
              }}
              placeholder={selectedIsRunning ? "Send prompt or paste an image..." : "Select a running session to send a prompt."}
              rows={3}
              onKeyDown={(event) => {
                if (!inputSending && (event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  sendInput();
                }
              }}
            />
          </div>
          <div className="composer-actions">
            <label className="attach-button" title="Attach image">
              <Paperclip size={16} />
              <span>Image</span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                onChange={(event) => {
                  addImageFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            </label>
            <label className="attach-button" title="Attach file">
              <FileText size={16} />
              <span>File</span>
              <input
                type="file"
                multiple
                onChange={(event) => {
                  addAnyFiles(event.target.files);
                  event.target.value = "";
                }}
              />
            </label>
            <button type="button" onClick={sendInput} disabled={inputSending || !selectedIsRunning || (!text.trim() && !attachments.length)}>
              <Send size={16} /> {inputSending ? "Sending" : "Send"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
