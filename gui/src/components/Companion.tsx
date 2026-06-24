/**
 * Companion — the bottom-right AI assistant dock. Shell-level (mounted in
 * CanvasInner, portaled to <body> above the scrim) so it's available in BOTH
 * the full-map and per-node views. Collapsed = a small launcher; expanded = a
 * glass-soft panel that knows the active run / open node as context.
 *
 * LIVE: the companion subscribes to the run's telemetry SSE bridge
 * (useRunStream → /__piflow/stream/<run> → observe.watchRun) so its context line
 * shows the REAL current state ("running W2 scaffold · 3/9", "done ✓ 9/9"). The
 * pi CHAT round-trip (talk-back / edits) is the NEXT step — `sendToPi` is the
 * single seam. Per the "no mock data" rule we do NOT fabricate assistant replies:
 * a sent message is echoed (the user typed it) and answered with an honest status
 * line that now carries the real run state.
 */
import { useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { GlassSurface } from "./GlassSurface";
import { useExpand } from "./ExpandContext";
import { useRunStream, whereAreWe } from "../data/runStream";
import "../styles/companion.css";

interface Msg { role: "you" | "system"; text: string }

export function Companion({ activeRun }: { activeRun: string }) {
  const { expandedId } = useExpand();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [log, setLog] = useState<Msg[]>([]);

  const live = useRunStream(open ? activeRun : null); // only stream while the dock is open
  const where = whereAreWe(live);
  const context = expandedId ? `${activeRun} · ${expandedId}` : `${activeRun} · ${where}`;

  function send(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    // sendToPi(text, { run: activeRun, node: expandedId })  ← wire the pi chat spawn here (step 2)
    setLog((l) => [
      ...l,
      { role: "you", text },
      { role: "system", text: `Run ${activeRun} — ${where}. Live pi chat isn't wired yet (next step); this is real run telemetry, not a stub.` },
    ]);
    setDraft("");
  }

  return createPortal(
    <div className="ds-companion-layer">
      {open ? (
        <GlassSurface as="aside" variant="soft" className="ds-companion" legibleText aria-label="AI companion">
          <header className="ds-companion__head">
            <span className="ds-companion__spark" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 1.5l1.4 4.1 4.1 1.4-4.1 1.4L8 12.5 6.6 8.4 2.5 7l4.1-1.4z" fill="currentColor" /></svg>
            </span>
            <span className="ds-companion__title">Companion</span>
            <span className="ds-companion__ctx" title={context}>{context}</span>
            <button type="button" className="ds-companion__min" aria-label="Collapse companion" onClick={() => setOpen(false)}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
            </button>
          </header>

          <div className="ds-companion__log">
            {log.length === 0 ? (
              <div className="ds-companion__empty">
                Ask about this run or node.
                <span className="ds-companion__soon">{activeRun} · {where}</span>
              </div>
            ) : (
              log.map((m, i) => <div key={i} className={`ds-companion__msg ds-companion__msg--${m.role}`}>{m.text}</div>)
            )}
          </div>

          <form className="ds-companion__composer" onSubmit={send}>
            <input
              className="ds-companion__input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Ask the companion…"
              aria-label="Message the companion"
            />
            <button type="submit" className="ds-companion__send" disabled={!draft.trim()} aria-label="Send">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 8h9M8 4.5L11.5 8 8 11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </form>
        </GlassSurface>
      ) : (
        <button type="button" className="ds-companion-launch" aria-label="Open companion" onClick={() => setOpen(true)}>
          <svg width="20" height="20" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1.5l1.4 4.1 4.1 1.4-4.1 1.4L8 12.5 6.6 8.4 2.5 7l4.1-1.4z" fill="currentColor" /></svg>
        </button>
      )}
    </div>,
    document.body,
  );
}
