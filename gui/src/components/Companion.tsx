/**
 * Companion — the pi chat. Collapsed = a small launcher (bottom-right); open = a full-height glass rail
 * on the RIGHT, layered (no backdrop) over the live flowmap so the left widgets stay lit and clickable.
 * Sits a tier BELOW the floating MenuBar/ModeBar (z-modal vs z-popover) so they keep floating on top.
 *
 * Render discipline (the firehose is folded, not logged): the transcript shows only the durable spine —
 * the user's prompts and pi's replies, flat, no bubbles. The live tool / "thinking" is EPHEMERAL (a single
 * last-wins status by the input), completed tools collapse to one quiet histogram line, and lifecycle
 * chatter is dropped in the reducer. Model · context% live next to the composer. No header, no dividers,
 * no containers except the input field.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { GlassSurface } from "./GlassSurface";
import { useControlSession, type ControlToolExecution, type SessionSummary } from "../data/controlSession";
import "../styles/companion.css";

/** Relative time for a conversation's mtime ("now", "5m", "2h", "3d"). */
function relTime(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

/** A history entry's label: session name, else its first user message, else a fallback. */
function sessionLabel(s: SessionSummary): string {
  return s.name || s.firstMessage || "untitled";
}

/** Completed tools → one quiet histogram line ("read ×2 · bash"). Empty when nothing has run. */
function summarizeTools(tools: ControlToolExecution[]): string {
  if (tools.length === 0) return "";
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t.toolName, (counts.get(t.toolName) ?? 0) + 1);
  return Array.from(counts.entries())
    .map(([name, c]) => (c > 1 ? `${name} ×${c}` : name))
    .join(" · ");
}

/** The official pi mark (pi.dev) — geometric P + i dot. Inherits `currentColor`. */
function PiMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 800 800" fill="none" aria-hidden="true">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z"
      />
      <path fill="currentColor" d="M517.36 400 H634.72 V634.72 H517.36 Z" />
    </svg>
  );
}

export function Companion({ activeRun, open, onOpenChange }: { activeRun: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [draft, setDraft] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false); // the conversation-history list

  // the two-way control session (its OWN EventSource + POST courier) — only while the rail is open.
  const ctrl = useControlSession(open ? activeRun : null);

  const logRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // keep the newest line in view as the stream grows.
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ctrl.messages, ctrl.toolExecutions]);

  function send(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    void ctrl.send(text); // POST → pi stdin; reply streams back as folded messages
    setDraft("");
  }

  const tools = Array.from(ctrl.toolExecutions.values());
  const runningTool = tools.find((t) => t.phase === "running");
  const toolSummary = summarizeTools(tools.filter((t) => t.phase === "done"));

  // ONE ephemeral, last-wins status — never appended. Empty when idle (concise).
  const status =
    ctrl.status === "connecting" ? "connecting…"
    : ctrl.status === "error" ? (ctrl.error ?? "session error")
    : ctrl.status === "closed" ? "session ended"
    : runningTool ? `running ${runningTool.toolName}…`
    : ctrl.streaming ? "thinking…"
    : "";
  const busy = ctrl.streaming || !!runningTool;

  // model · context% — the only metadata, next to the input.
  const pct = ctrl.contextUsage?.percent;
  const meta = [ctrl.model, pct != null ? `${Math.round(pct)}% ctx` : null].filter(Boolean).join(" · ");

  const hasMessages = ctrl.messages.length > 0;
  const showEmpty = !hasMessages && !busy;
  const showMeta = !!status || !!meta || ctrl.streaming;

  return createPortal(
    <div className="ds-companion-layer">
      {open ? (
        <GlassSurface as="aside" variant="soft" className="ds-companion" legibleText aria-label="pi chat">
          {/* functional controls only — bare ghost icons, top-left (clears the floating top-right MenuBar) */}
          <div className="ds-companion__controls">
            <button
              type="button"
              className="ds-companion__ctl"
              aria-label="Close chat"
              title="Close"
              onClick={() => onOpenChange(false)}
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M6 4l4 4-4 4M2 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              type="button"
              className="ds-companion__ctl"
              aria-label="Conversation history"
              aria-pressed={historyOpen}
              title="History"
              onClick={() => setHistoryOpen((v) => !v)}
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M3 4h10M3 8h10M3 12h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>

          {historyOpen ? (
            <div className="ds-companion__history" role="listbox" aria-label="Conversations">
              {/* New chat is the first entry — the list IS the navigation (click = continue). */}
              <button
                type="button"
                className="ds-companion__hist-item ds-companion__hist-item--new"
                onClick={() => { void ctrl.newChat(); setHistoryOpen(false); }}
              >
                <span className="ds-companion__hist-plus" aria-hidden="true">＋</span>
                <span className="ds-companion__hist-label">new chat</span>
              </button>
              {ctrl.sessions.length === 0 ? (
                <div className="ds-companion__hist-empty">no past conversations</div>
              ) : (
                ctrl.sessions.map((s) => {
                  const active = s.id === ctrl.activeSessionId;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={`ds-companion__hist-item${active ? " ds-companion__hist-item--active" : ""}`}
                      title={sessionLabel(s)}
                      onClick={() => { if (!active) void ctrl.selectSession(s.id); setHistoryOpen(false); }}
                    >
                      <span className="ds-companion__hist-label">{sessionLabel(s)}</span>
                      <span className="ds-companion__hist-time">{relTime(s.mtime)}</span>
                    </button>
                  );
                })
              )}
            </div>
          ) : (
            <div className="ds-companion__log" ref={logRef}>
              {showEmpty ? (
                <div className="ds-companion__empty">
                  {ctrl.status === "connecting"
                    ? "starting pi…"
                    : ctrl.status === "closed" || ctrl.status === "error"
                      ? <>session ended<button type="button" className="ds-companion__restart" onClick={() => void ctrl.start()}>restart</button></>
                      : "ask anything about this run"}
                </div>
              ) : (
                <>
                  {ctrl.messages.map((m) => (
                    <p
                      key={m.id}
                      className={`ds-companion__msg ds-companion__msg--${m.role === "user" ? "you" : "pi"}${m.streaming ? " is-streaming" : ""}`}
                    >
                      {m.text}
                    </p>
                  ))}
                  {toolSummary && <p className="ds-companion__toolsum">{toolSummary}</p>}
                </>
              )}
            </div>
          )}

          <form className="ds-companion__composer" onSubmit={send}>
            {showMeta && (
              <div className="ds-companion__meta">
                {status && <span className="ds-companion__status" data-on={busy}>{status}</span>}
                {meta && <span className="ds-companion__model" title={meta}>{meta}</span>}
                {ctrl.streaming && (
                  <button type="button" className="ds-companion__abort" onClick={() => void ctrl.abort()} aria-label="Stop the current turn">stop</button>
                )}
              </div>
            )}
            <div className="ds-companion__inputrow">
              <input
                className="ds-companion__input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={ctrl.streaming ? "steer…" : "ask…"}
                aria-label="Message pi"
              />
              <button type="submit" className="ds-companion__send" disabled={!draft.trim()} aria-label="Send">
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 8h9M8 4.5L11.5 8 8 11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            </div>
          </form>
        </GlassSurface>
      ) : (
        <button type="button" className="ds-companion-launch" aria-label="Open pi" onClick={() => onOpenChange(true)}>
          <PiMark size={20} />
        </button>
      )}
    </div>,
    document.body,
  );
}
