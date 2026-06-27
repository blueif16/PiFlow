/**
 * Companion — the bottom-right AI assistant dock. Shell-level (mounted in
 * CanvasInner, portaled to <body> above the scrim) so it's available in BOTH
 * the full-map and per-node views. Collapsed = a small launcher; expanded = a
 * glass-soft panel that knows the active run / open node as context.
 *
 * TWO data sources, two physics (control-session-mirror.md):
 *  - run TELEMETRY (one-way, useRunStreamContext → /__piflow/stream → observe.watchRun): the context line's
 *    real "where are we" ("running W2 · 3/9", "done ✓ 9/9").
 *  - CONTROL SESSION (two-way, useControlSession → /__piflow/control/<run>/{start,stream,message}): the live
 *    chat with an interactive `pi --mode rpc` rooted at the run folder. The composer POSTs the user's text;
 *    the pi's reply streams back as folded messages + tool cards. This is the wired `sendToPi` seam.
 * The two streams stay separate by design (telemetry one-way; control two-way) — this dock just renders both.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
// `open` is owned by CanvasInner so the bottom-left ModeBar's "P" key (and the global
// p-keypress) can launch this bottom-right pi chat; the launcher/collapse just flip it.
import { createPortal } from "react-dom";
import { GlassSurface } from "./GlassSurface";
import { useExpand } from "./ExpandContext";
import { useRunStreamContext, whereAreWe } from "../data/runStream";
import { useControlSession, type ControlToolExecution } from "../data/controlSession";
import "../styles/companion.css";

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

/** One folded tool execution → a compact card (tool_execution_start/end collapsed by toolCallId). */
function ToolCard({ tool }: { tool: ControlToolExecution }) {
  const cls = `ds-companion__tool ds-companion__tool--${tool.phase}${tool.isError ? " ds-companion__tool--error" : ""}`;
  return (
    <div className={cls}>
      <span className="ds-companion__tool-name">{tool.toolName}</span>
      <span className="ds-companion__tool-phase">{tool.phase === "running" ? "…" : tool.isError ? "error" : "ok"}</span>
    </div>
  );
}

export function Companion({ activeRun, open, onOpenChange }: { activeRun: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { expandedId } = useExpand();
  const [draft, setDraft] = useState("");

  const live = useRunStreamContext(); // shared telemetry subscription (owned by CanvasInner) — one-way
  const where = whereAreWe(live);
  // live token counter folded from the node-event firehose (0 until events stream / for a lean run)
  const tokens = live.liveBillable > 0 ? ` · ${live.liveBillable.toLocaleString()} tok` : "";
  const context = expandedId ? `${activeRun} · ${expandedId}` : `${activeRun} · ${where}${tokens}`;

  // the two-way control session (its OWN EventSource + POST courier) — only while the dock is open.
  const ctrl = useControlSession(open ? activeRun : null);

  const logRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    // keep the newest message in view as the stream grows.
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [ctrl.messages, ctrl.toolExecutions, ctrl.notices]);

  function send(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    void ctrl.send(text); // POST /__piflow/control/<run>/message → pi stdin; reply streams back as frames
    setDraft("");
  }

  const tools = Array.from(ctrl.toolExecutions.values());
  const hasContent = ctrl.messages.length > 0 || tools.length > 0 || ctrl.notices.length > 0;
  const statusLine =
    ctrl.status === "connecting" ? "connecting…"
    : ctrl.status === "error" ? (ctrl.error ?? "session error")
    : ctrl.status === "closed" ? "session ended"
    : ctrl.streaming ? "pi is working…"
    : "ready";

  return createPortal(
    <div className="ds-companion-layer">
      {open ? (
        <GlassSurface as="aside" variant="soft" className="ds-companion" legibleText aria-label="AI companion">
          <header className="ds-companion__head">
            <span className="ds-companion__spark" aria-hidden="true">
              <PiMark size={13} />
            </span>
            <span className="ds-companion__title">Companion</span>
            <span className="ds-companion__ctx" title={context}>{context}</span>
            <button type="button" className="ds-companion__min" aria-label="Collapse companion" onClick={() => onOpenChange(false)}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </button>
          </header>

          <div className="ds-companion__log" ref={logRef}>
            {!hasContent ? (
              <div className="ds-companion__empty">
                {ctrl.status === "connecting"
                  ? "Starting a pi session for this run…"
                  : ctrl.status === "closed" || ctrl.status === "error"
                    ? <>Session ended.<button type="button" className="ds-companion__restart" onClick={() => void ctrl.start()}>Restart</button></>
                    : "Ask about this run or node."}
                <span className="ds-companion__soon">{activeRun} · {where}</span>
              </div>
            ) : (
              <>
                {ctrl.messages.map((m) => (
                  <div key={m.id} className={`ds-companion__msg ds-companion__msg--${m.role === "user" ? "you" : "system"}`}>
                    {m.text || (m.streaming ? "…" : "")}
                  </div>
                ))}
                {tools.length > 0 && (
                  <div className="ds-companion__tools">
                    {tools.map((t) => <ToolCard key={t.toolCallId} tool={t} />)}
                  </div>
                )}
                {ctrl.notices.map((n, i) => (
                  <div key={`n${i}`} className="ds-companion__notice">{n}</div>
                ))}
              </>
            )}
          </div>

          <form className="ds-companion__composer" onSubmit={send}>
            <span className="ds-companion__status" title={statusLine}>{statusLine}</span>
            {ctrl.streaming && (
              <button type="button" className="ds-companion__abort" onClick={() => void ctrl.abort()} aria-label="Stop the current turn">Stop</button>
            )}
            <input
              className="ds-companion__input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={ctrl.streaming ? "Steer the agent…" : "Ask the companion…"}
              aria-label="Message the companion"
            />
            <button type="submit" className="ds-companion__send" disabled={!draft.trim()} aria-label="Send">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 8h9M8 4.5L11.5 8 8 11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </form>
        </GlassSurface>
      ) : (
        <button type="button" className="ds-companion-launch" aria-label="Open companion" onClick={() => onOpenChange(true)}>
          <PiMark size={20} />
        </button>
      )}
    </div>,
    document.body,
  );
}
