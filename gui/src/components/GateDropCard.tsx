/**
 * GateDropCard — opened when a rail hexagon is dropped on a node. A LARGE full-height overlay on the LEFT
 * edge of the canvas, the mirror image of the right-side Companion rail (same glass geometry + MarkdownReader
 * turn rendering, ambient z-rail tier below the HUD scrim). It replaces the old canned-default write with a
 * describe-then-create surface:
 *   - Header binds the gate KIND (user vocabulary: agentic check / execution / human) to the target node.
 *   - Body is a live TRANSCRIPT: hitting "Create gate" applies the gate to THIS RUN first (Slice 1.5 run-first)
 *     and renders the submitted text as a markdown turn tagged with a context chip ("agentic check → <node>").
 *     A CHOICE turn beneath it — "Applied to this run · Apply to the entire template?" — PROMOTES the change
 *     durably (future runs) or keeps it run-only. A failed write renders the FULL error as a system turn.
 *     The transcript is structured so Slice 2 can bind a control session ABOVE the composer without redesign.
 *   - Composer is a LARGE paste-a-paragraph textarea + the one primary button.
 * Escape or the close control dismisses it. Run-first + promote reuse the SAME validated write path
 * (buildGateChip → ComposeContext.dropChip(target) → POST /__piflow/node-edit → run `.pi/` or template node.json).
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GlassSurface } from "./GlassSurface";
import { MarkdownReader } from "./MarkdownReader";
import { GateHex } from "./GateGlyph";
import { RAIL_KINDS, buildGateChip, canCreateGate, railHex, type RailKind } from "../data/gates";
import type { GateChip } from "../data/runView";
import "../styles/composecard.css";

export interface DropCardTarget {
  nodeId: string;
  kind: RailKind;
}

interface GateDropCardProps {
  card: DropCardTarget | null;
  onClose: () => void;
  dropChip: (nodeId: string, chip: GateChip, target?: "run" | "template") => Promise<{ ok: boolean; error?: string; stub?: boolean }>;
}

// The static demo shim (gui/demo/demoFetch.ts) sets this so writes aren't faked as success here.
const isDemo = (): boolean => typeof window !== "undefined" && (window as unknown as { __PIFLOW_DEMO__?: boolean }).__PIFLOW_DEMO__ === true;

/** One transcript turn: the user's submitted description ("you"), a system report ("system"), or the run→template
 *  promotion CHOICE ("choice", carrying the chip so "Apply to template" can re-send it). */
type Turn = {
  id: number;
  role: "you" | "system" | "choice";
  text?: string;
  tone?: "ok" | "err";
  chip?: GateChip;
  resolved?: "promoted" | "dismissed";
};

export function GateDropCard({ card, onClose, dropChip }: GateDropCardProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(0);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);

  const demo = isDemo();
  const spec = card ? RAIL_KINDS.find((r) => r.kind === card.kind) : undefined;

  // A NEW card (different node/kind) starts a fresh authoring session.
  useEffect(() => {
    setText("");
    setTurns([]);
    setBusy(false);
    setPromoting(false);
    if (card) requestAnimationFrame(() => taRef.current?.focus());
  }, [card?.nodeId, card?.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  // keep the newest turn in view as the transcript grows
  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [turns]);

  // Escape dismisses (no click-away — the rail is a persistent surface, like the Companion)
  useEffect(() => {
    if (!card) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [card, onClose]);

  if (!card || !spec) return null;

  const canCreate = canCreateGate(card.kind, text);
  const kindHex = railHex(card.kind, spec.name);
  const chipLabel = `${spec.name} → ${card.nodeId}`;
  const pushTurn = (t: Omit<Turn, "id">) => setTurns((cur) => [...cur, { id: ++idRef.current, ...t }]);

  // Create gate → RUN-FIRST: apply to this run, then offer to promote to the template.
  const submit = async () => {
    if (!canCreate || busy) return;
    const sent = text;
    pushTurn({ role: "you", text: sent });
    setText("");
    if (demo) {
      pushTurn({ role: "system", tone: "err", text: "Editing is disabled in this demo — run `piflowctl gui` on a real project to author gates." });
      return;
    }
    setBusy(true);
    const chip = buildGateChip(card.kind, sent);
    const r = await dropChip(card.nodeId, chip, "run");
    setBusy(false);
    if (r.ok) pushTurn({ role: "choice", chip });
    else pushTurn({ role: "system", tone: "err", text: r.stub ? "This run doesn't support edits (run-target is stubbed)." : (r.error ?? "The edit failed.") });
    requestAnimationFrame(() => taRef.current?.focus());
  };

  // Apply to the entire template → the durable promote (reuses the template write path).
  const promote = async (turnId: number, chip: GateChip) => {
    if (promoting) return;
    setPromoting(true);
    const r = await dropChip(card.nodeId, chip, "template");
    setPromoting(false);
    if (r.ok) setTurns((cur) => cur.map((x) => (x.id === turnId ? { ...x, resolved: "promoted" } : x)));
    else pushTurn({ role: "system", tone: "err", text: r.error ?? "Promotion failed." });
  };
  const dismiss = (turnId: number) => setTurns((cur) => cur.map((x) => (x.id === turnId ? { ...x, resolved: "dismissed" } : x)));

  return createPortal(
    <div className="ds-composecard-layer">
      <GlassSurface as="aside" variant="soft" className="ds-composecard" legibleText aria-label={`New ${spec.name} gate on ${card.nodeId}`}>
        <header className="ds-composecard__head">
          <GateHex desc={kindHex} size={30} />
          <div className="ds-composecard__headtext">
            <span className="ds-composecard__kind">{spec.name}</span>
            <span className="ds-composecard__node" title={card.nodeId}>→ {card.nodeId}</span>
          </div>
          <button type="button" className="ds-composecard__close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M10 4l-4 4 4 4M14 4l-4 4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </header>

        <div className="ds-composecard__log" ref={logRef}>
          {turns.length === 0 ? (
            <div className="ds-composecard__empty">{spec.desc}. Describe it below, then Create gate.</div>
          ) : (
            turns.map((turn) =>
              turn.role === "you" ? (
                <div key={turn.id} className="ds-composecard__turn ds-composecard__turn--you">
                  <span className="ds-composecard__chip">
                    <GateHex desc={kindHex} size={13} />
                    {chipLabel}
                  </span>
                  {/* the submitted text as a rendered markdown paragraph turn (paste-a-paragraph friendly) */}
                  <MarkdownReader source={turn.text ?? ""} />
                </div>
              ) : turn.role === "choice" ? (
                <div key={turn.id} className="ds-composecard__choice">
                  <p className="ds-composecard__sys" data-tone="ok">Applied to this run.</p>
                  {turn.resolved === "promoted" ? (
                    <p className="ds-composecard__sys" data-tone="ok">Promoted to the template — future runs get it too.</p>
                  ) : turn.resolved === "dismissed" ? (
                    <p className="ds-composecard__note">Kept on this run only.</p>
                  ) : (
                    <div className="ds-composecard__choicebox">
                      <span className="ds-composecard__choiceq">Apply to the entire template?</span>
                      <div className="ds-composecard__choiceact">
                        <button type="button" className="ds-composecard__promote" disabled={promoting} onClick={() => void promote(turn.id, turn.chip!)}>
                          {promoting ? "Applying…" : "Apply to template"}
                        </button>
                        <button type="button" className="ds-composecard__keep" onClick={() => dismiss(turn.id)}>Keep on this run</button>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <p key={turn.id} className="ds-composecard__sys" data-tone={turn.tone} role={turn.tone === "err" ? "alert" : undefined}>{turn.text}</p>
              ),
            )
          )}
        </div>

        <form className="ds-composecard__composer" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <textarea
            ref={taRef}
            className="ds-composecard__ta"
            placeholder={spec.placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void submit(); } }}
            aria-label={`${spec.name} — ${spec.desc}`}
          />
          <div className="ds-composecard__foot">
            <span className="ds-composecard__hint" aria-hidden="true">applies to this run · ⌘⏎</span>
            <button type="submit" className="ds-composecard__create" disabled={!canCreate || busy}>
              {busy ? "Creating…" : "Create gate"}
            </button>
          </div>
        </form>
      </GlassSurface>
    </div>,
    document.body,
  );
}
