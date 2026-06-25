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
// `open` is owned by CanvasInner so the bottom-left ModeBar's "P" key (and the global
// p-keypress) can launch this bottom-right pi chat; the launcher/collapse just flip it.
import { createPortal } from "react-dom";
import { GlassSurface } from "./GlassSurface";
import { useExpand } from "./ExpandContext";
import { useRunStreamContext, whereAreWe } from "../data/runStream";
import "../styles/companion.css";

interface Msg { role: "you" | "system"; text: string }

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
  const { expandedId } = useExpand();
  const [draft, setDraft] = useState("");
  const [log, setLog] = useState<Msg[]>([]);

  const live = useRunStreamContext(); // shared subscription (owned by CanvasInner) — no second connection
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
              <PiMark size={13} />
            </span>
            <span className="ds-companion__title">Companion</span>
            <span className="ds-companion__ctx" title={context}>{context}</span>
            <button type="button" className="ds-companion__min" aria-label="Collapse companion" onClick={() => onOpenChange(false)}>
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
        <button type="button" className="ds-companion-launch" aria-label="Open companion" onClick={() => onOpenChange(true)}>
          <PiMark size={20} />
        </button>
      )}
    </div>,
    document.body,
  );
}
