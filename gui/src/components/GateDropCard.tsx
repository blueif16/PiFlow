/**
 * GateDropCard — opened when a rail hexagon is dropped on a node (replaces the old instant canned-default
 * write). A small anchored popover: ONE textarea (autofocused) + ONE primary button "Create gate". No
 * model/tier/threshold/retry fields — those follow hidden system defaults. Escape and click-away cancel.
 *
 * On Create it maps the natural-language text → a GateChip (data/gates.buildGateChip) and calls the existing
 * validated write path (ComposeContext.dropChip → POST /__piflow/node-edit → template node.json). On success
 * it closes (the landed gate re-renders on the node); on FAILURE it stays open and surfaces the FULL server
 * error (never truncated) so the user can fix + retry. In the static demo (no server) edits are inert, so the
 * card says editing is disabled instead of faking success.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { RAIL_KINDS, buildGateChip, canCreateGate, type RailKind } from "../data/gates";
import type { GateChip } from "../data/runView";
import "../styles/gaterail.css";

export interface DropCardTarget {
  nodeId: string;
  kind: RailKind;
  /** the drop-target's screen rect (from getBoundingClientRect) — the card anchors just below it. */
  anchor: { top: number; left: number; bottom: number; right: number };
}

interface GateDropCardProps {
  card: DropCardTarget | null;
  onClose: () => void;
  dropChip: (nodeId: string, chip: GateChip) => Promise<{ ok: boolean; error?: string; stub?: boolean }>;
}

// The static demo shim (gui/demo/demoFetch.ts) sets this so writes aren't faked as success here.
const isDemo = (): boolean => typeof window !== "undefined" && (window as unknown as { __PIFLOW_DEMO__?: boolean }).__PIFLOW_DEMO__ === true;

const CARD_W = 300;

export function GateDropCard({ card, onClose, dropChip }: GateDropCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  const demo = isDemo();
  const spec = card ? RAIL_KINDS.find((r) => r.kind === card.kind) : undefined;

  // reset the field when a NEW card opens (keyed by node+kind so re-dropping starts fresh)
  useEffect(() => {
    setText("");
    setError(null);
    setBusy(false);
    if (card) requestAnimationFrame(() => taRef.current?.focus());
  }, [card?.nodeId, card?.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  // position the card just below the drop target, clamped to the viewport
  useLayoutEffect(() => {
    if (!card) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const h = ref.current?.offsetHeight ?? 200;
    let left = card.anchor.left;
    let top = card.anchor.bottom + 8;
    left = Math.max(12, Math.min(left, vw - CARD_W - 12));
    if (top + h > vh - 12) top = Math.max(12, card.anchor.top - h - 8); // flip above if it would overflow
    setPos({ top, left });
  }, [card, text, error]);

  // Escape + click-away cancel (no scrim — the popover never covers canvas content)
  useEffect(() => {
    if (!card) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [card, onClose]);

  if (!card || !spec) return null;

  const canCreate = canCreateGate(card.kind, text);

  const submit = async () => {
    if (!canCreate || busy) return;
    if (demo) { setError("Editing is disabled in this demo — run `piflowctl gui` on a real project to author gates."); return; }
    setBusy(true);
    setError(null);
    const chip = buildGateChip(card.kind, text);
    const r = await dropChip(card.nodeId, chip);
    if (r.ok) { setBusy(false); onClose(); return; }
    setBusy(false);
    setError(r.stub ? "This run doesn't support template edits (run-target is stubbed)." : (r.error ?? "The edit failed."));
  };

  return createPortal(
    <div
      ref={ref}
      className="ds-dropcard"
      role="dialog"
      aria-label={`New ${spec.name} gate on ${card.nodeId}`}
      style={{ top: pos.top, left: pos.left }}
      onKeyDown={(e) => {
        // Cmd/Ctrl+Enter submits from the textarea
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void submit(); }
      }}
    >
      <div className="ds-dropcard__head">
        <span className="ds-dropcard__title">{spec.name}</span>
        <span className="ds-dropcard__sub">on {card.nodeId}</span>
      </div>
      <textarea
        ref={taRef}
        className="ds-dropcard__ta"
        placeholder={spec.placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label={`${spec.name} — ${spec.desc}`}
      />
      {demo && (
        <div className="ds-dropcard__notice">Editing is disabled in this demo. Gate authoring writes to the project's template, which the static demo has no server for.</div>
      )}
      {error && <div className="ds-dropcard__err" role="alert">{error}</div>}
      <div className="ds-dropcard__foot">
        <button type="button" className="ds-dropcard__cancel" onClick={onClose}>Cancel</button>
        <button
          type="button"
          className="ds-dropcard__create"
          disabled={!canCreate || busy || demo}
          onClick={() => void submit()}
        >
          {busy ? "Creating…" : "Create gate"}
        </button>
      </div>
    </div>,
    document.body,
  );
}
