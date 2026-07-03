/**
 * AgentDropCard — opened when a base agent from the AgentRail is dropped on a node's basis slot. The
 * GateDropCard idiom, simpler: no agent session, no transcript — a CONFIRM card that shows the dragged
 * preset's identity (avatar · label · role prompt · tools · skills) against the node's current base, and
 * one action. Confirm applies the agent chip through the SAME validated write path the gate drops use
 * (dropChip → POST /__piflow/node-edit) — TEMPLATE-ONLY by design (agentType is structural; the run-bake
 * path rejects the kind server-side), so there is no run-first choice here: the card offers exactly the
 * durable template write, and the caller refreshes the node's authored config on success (the promote
 * path's refresh). Identical base ⇒ the confirm is disabled (no-op). Escape or the close control
 * dismisses it (the GateDropCard Escape discipline).
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { GlassSurface } from "./GlassSurface";
import { AgentAvatar } from "./WorkflowNode";
import { buildAgentChip, type AgentChip } from "../data/agentChips";
import type { AgentCatalog } from "../data/runView";
import "../styles/composecard.css";
import "../styles/agentrail.css";

export interface AgentCardTarget {
  nodeId: string;
  /** the DRAGGED base-agent preset id (the catalog key). */
  agentType: string;
  /** the node's CURRENT base (undefined ⇒ bespoke — assigning a first base). */
  current?: string;
}

interface AgentDropCardProps {
  card: AgentCardTarget | null;
  catalog: AgentCatalog;
  onClose: () => void;
  dropChip: (nodeId: string, chip: AgentChip, target?: "run" | "template") => Promise<{ ok: boolean; error?: string; stub?: boolean }>;
}

// The static demo shim (gui/demo/demoFetch.ts) sets this so writes aren't faked as success here.
const isDemo = (): boolean => typeof window !== "undefined" && (window as unknown as { __PIFLOW_DEMO__?: boolean }).__PIFLOW_DEMO__ === true;

export function AgentDropCard({ card, catalog, onClose, dropChip }: AgentDropCardProps) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  // A NEW card (different node/base) starts a fresh confirm.
  useEffect(() => {
    setBusy(false);
    setResult(null);
  }, [card?.nodeId, card?.agentType]);

  // Escape dismisses (no click-away — mirrors the GateDropCard Escape discipline)
  useEffect(() => {
    if (!card) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [card, onClose]);

  if (!card) return null;

  const next = catalog[card.agentType];
  const cur = card.current ? catalog[card.current] : undefined;
  const nextLabel = next?.label ?? card.agentType;
  const curLabel = card.current ? (cur?.label ?? card.current) : "bespoke · no base";
  const same = card.current === card.agentType; // identical base ⇒ the confirm is a no-op
  const tools = next?.tools?.allow ?? [];
  const skills = next?.skills ?? [];

  const confirm = async () => {
    if (same || busy || result?.ok) return;
    if (isDemo()) { setResult({ ok: false, text: "Editing is disabled in this demo — run `piflowctl gui` on a real project to reassign base agents." }); return; }
    setBusy(true);
    const r = await dropChip(card.nodeId, buildAgentChip(card.agentType), "template");
    setBusy(false);
    if (r.ok) setResult({ ok: true, text: "Base agent set on the template — future runs adopt it (this run is unchanged)." });
    else setResult({ ok: false, text: r.error ?? "The edit failed." });
  };

  return createPortal(
    <div className="ds-composecard-layer">
      <GlassSurface as="aside" variant="soft" className="ds-composecard" legibleText aria-label={`Set base agent ${nextLabel} on ${card.nodeId}`}>
        <header className="ds-composecard__head">
          <span className="ds-agentconfirm__face" style={next?.color ? { color: next.color } : undefined}>
            <AgentAvatar agentType={card.agentType} icon={next?.icon} />
          </span>
          <div className="ds-composecard__headtext">
            <span className="ds-composecard__kind">{nextLabel}</span>
            <span className="ds-composecard__node" title={card.nodeId}>→ {card.nodeId}</span>
          </div>
          <button type="button" className="ds-composecard__close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M10 4l-4 4 4 4M14 4l-4 4 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </header>

        <div className="ds-composecard__log">
          <div className="ds-agentconfirm">
            {/* current → dragged: the reassignment at a glance */}
            <div className="ds-agentconfirm__vs">
              <span className="ds-agentconfirm__side" data-role="current" title={`current base: ${card.current ?? "none"}`}>
                <span className="ds-agentconfirm__face">
                  <AgentAvatar agentType={card.current} icon={cur?.icon} />
                </span>
                <span className="ds-agentconfirm__name">{curLabel}</span>
              </span>
              <svg className="ds-agentconfirm__arrow" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M2 8h11M9.5 4.5L13 8l-3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="ds-agentconfirm__side" data-role="next" title={`new base: ${card.agentType}`}>
                <span className="ds-agentconfirm__face" style={next?.color ? { color: next.color } : undefined}>
                  <AgentAvatar agentType={card.agentType} icon={next?.icon} />
                </span>
                <span className="ds-agentconfirm__name">{nextLabel}</span>
              </span>
            </div>

            {same && <p className="ds-composecard__note">This node already runs on this base — nothing to change.</p>}

            {/* the dragged preset's DEFINITION — what the node would inherit */}
            {next?.prompt && (
              <>
                <span className="ds-agentconfirm__key">role prompt</span>
                <pre className="ds-agentconfirm__prompt">{next.prompt}</pre>
              </>
            )}
            {tools.length > 0 && (
              <>
                <span className="ds-agentconfirm__key">tools</span>
                <span className="ds-agentconfirm__tags">
                  {tools.map((t) => <span key={t} className="ds-agentconfirm__tag">{t}</span>)}
                </span>
              </>
            )}
            {skills.length > 0 && (
              <>
                <span className="ds-agentconfirm__key">skills</span>
                <span className="ds-agentconfirm__tags">
                  {skills.map((s) => <span key={s} className="ds-agentconfirm__tag">{s}</span>)}
                </span>
              </>
            )}

            {result && (
              <p className="ds-composecard__sys" data-tone={result.ok ? "ok" : "err"} role={result.ok ? undefined : "alert"}>
                {result.text}
              </p>
            )}
          </div>
        </div>

        {/* the composer wrapper carries the ModeBar bottom clearance (same law as GateDropCard's form) */}
        <div className="ds-composecard__composer">
          <div className="ds-composecard__foot">
            <span className="ds-composecard__hint" aria-hidden="true">applies to the template — future runs</span>
            <button type="button" className="ds-composecard__create" disabled={same || busy || result?.ok === true} onClick={() => void confirm()}>
              {busy ? "Setting…" : result?.ok ? "Set" : "Set base agent"}
            </button>
          </div>
        </div>
      </GlassSurface>
    </div>,
    document.body,
  );
}
