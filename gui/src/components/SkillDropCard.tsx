/**
 * SkillDropCard — opened when a skill from the SkillMarketPanel is dropped on a node's skill slot. The
 * AgentDropCard idiom (a confirm card: dragged skill vs the node's current skill + its requires/allowed
 * preview) but with the GateDropCard Slice-1.5 TWO-TIER apply: a skill is an OVERLAY (a `prompt.skill`
 * loadout pointer, not a structural preset), so "Apply to this run" bakes it RUN-FIRST (dropChip → run
 * `.pi/`), then offers the "Apply to the entire template?" promotion (dropChip → template node.json). Both
 * reuse the SAME validated write path the gate/agent drops use. On a template promote the caller refreshes
 * the node's authored config (the GateDropCard refresh). The requires/allowed preview is fetched from the
 * shared `/__piflow/skill` bundle endpoint (loadSkill) so the card shows exactly what the node would inherit.
 * Identical skill ⇒ apply is disabled (no-op). Escape or the close control dismisses it.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { GlassSurface } from "./GlassSurface";
import { ToolTag } from "./toolMeta";
import { buildSkillChip, type SkillChip } from "../data/skillChips";
import { loadSkill, type SkillBundle } from "../data/runView";
import "../styles/composecard.css";
import "../styles/skillmarket.css";

export interface SkillCardTarget {
  nodeId: string;
  /** the DRAGGED skill id (the marketplace entry id). */
  skill: string;
  /** the node's CURRENT loadout skill (undefined ⇒ none yet). */
  current?: string;
}

interface SkillDropCardProps {
  card: SkillCardTarget | null;
  run: string;
  onClose: () => void;
  dropChip: (nodeId: string, chip: SkillChip, target?: "run" | "template") => Promise<{ ok: boolean; error?: string; stub?: boolean }>;
}

// The static demo shim (gui/demo/demoFetch.ts) sets this so writes aren't faked as success here.
const isDemo = (): boolean => typeof window !== "undefined" && (window as unknown as { __PIFLOW_DEMO__?: boolean }).__PIFLOW_DEMO__ === true;

export function SkillDropCard({ card, run, onClose, dropChip }: SkillDropCardProps) {
  const [bundle, setBundle] = useState<SkillBundle | null>(null);
  const [busy, setBusy] = useState(false);           // run-first apply in flight
  const [applied, setApplied] = useState(false);      // the run-first write landed → offer the template promote
  const [promoting, setPromoting] = useState(false);
  const [resolved, setResolved] = useState<"promoted" | "dismissed" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A NEW card (different node/skill) starts a fresh confirm + fetches the dragged skill's bundle for preview.
  useEffect(() => {
    setBusy(false); setApplied(false); setPromoting(false); setResolved(null); setError(null); setBundle(null);
    if (!card || !run) return;
    let alive = true;
    loadSkill(run, card.skill).then((b) => { if (alive) setBundle(b); });
    return () => { alive = false; };
  }, [card?.nodeId, card?.skill, run]); // eslint-disable-line react-hooks/exhaustive-deps

  // Escape dismisses (no click-away — mirrors the AgentDropCard/GateDropCard Escape discipline)
  useEffect(() => {
    if (!card) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [card, onClose]);

  if (!card) return null;

  const same = card.current === card.skill; // identical skill ⇒ the confirm is a no-op
  const label = bundle?.name ?? card.skill;
  const requires = bundle?.requires ?? [];
  const extraAllowed = (bundle?.allowed ?? []).filter((t) => !requires.includes(t));

  // "Apply to this run" → the RUN-FIRST bake (an overlay; the run-view re-read then shows the skill).
  const applyRun = async () => {
    if (same || busy || applied) return;
    if (isDemo()) { setError("Editing is disabled in this demo — run `piflowctl gui` on a real project to set a node's skill."); return; }
    setBusy(true); setError(null);
    const r = await dropChip(card.nodeId, buildSkillChip(card.skill), "run");
    setBusy(false);
    if (r.ok) setApplied(true);
    else setError(r.stub ? "This run doesn't support edits (run-target is stubbed)." : (r.error ?? "The edit failed."));
  };

  // "Apply to the entire template" → the durable promote (reuses the template write path; the caller then
  // refreshes the node's authored config — the GateDropCard refresh).
  const promote = async () => {
    if (promoting || resolved) return;
    setPromoting(true);
    const r = await dropChip(card.nodeId, buildSkillChip(card.skill), "template");
    setPromoting(false);
    if (r.ok) setResolved("promoted");
    else setError(r.error ?? "Promotion failed.");
  };

  return createPortal(
    <div className="ds-composecard-layer">
      <GlassSurface as="aside" variant="soft" className="ds-composecard" legibleText aria-label={`Set skill ${label} on ${card.nodeId}`}>
        <header className="ds-composecard__head">
          <span className="ds-agentconfirm__face">
            <SkillGlyph />
          </span>
          <div className="ds-composecard__headtext">
            <span className="ds-composecard__kind">{label}</span>
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
            {/* current skill → dragged skill: the loadout change at a glance */}
            <div className="ds-agentconfirm__vs">
              <span className="ds-agentconfirm__side" data-role="current" title={`current skill: ${card.current ?? "none"}`}>
                <span className="ds-skillchip__mark"><SkillGlyph /></span>
                <span className="ds-agentconfirm__name">{card.current ?? "no skill"}</span>
              </span>
              <svg className="ds-agentconfirm__arrow" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M2 8h11M9.5 4.5L13 8l-3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="ds-agentconfirm__side" data-role="next" title={`new skill: ${card.skill}`}>
                <span className="ds-skillchip__mark"><SkillGlyph /></span>
                <span className="ds-agentconfirm__name">{label}</span>
              </span>
            </div>

            {same && <p className="ds-composecard__note">This node already loads this skill — nothing to change.</p>}

            {/* the dragged skill's DEFINITION — what the node would inherit */}
            {bundle?.description && (
              <>
                <span className="ds-agentconfirm__key">about</span>
                <p className="ds-skillcard__desc">{bundle.description}</p>
              </>
            )}
            <div className="ds-agentconfirm__key">
              needs{" "}
              <span className="ds-skillcard__badge" data-on={bundle?.needsMcp === true}>
                {bundle?.needsMcp ? "MCP tools" : "native tools"}
              </span>
            </div>
            {requires.length > 0 && (
              <>
                <span className="ds-agentconfirm__key">requires</span>
                <span className="ds-agentconfirm__tags">
                  {requires.map((t) => <ToolTag key={t} name={t} title={`${t} — required by this skill`} />)}
                </span>
              </>
            )}
            {extraAllowed.length > 0 && (
              <>
                <span className="ds-agentconfirm__key">allowed</span>
                <span className="ds-agentconfirm__tags">
                  {extraAllowed.map((t) => <ToolTag key={t} name={t} className="ds-tooltag--deny" title={`${t} — permitted (ceiling)`} />)}
                </span>
              </>
            )}

            {/* run-first applied → the promote choice (Slice 1.5) */}
            {applied && (
              <div className="ds-composecard__choice">
                <p className="ds-composecard__sys" data-tone="ok">Applied to this run — the node loads it now.</p>
                {resolved === "promoted" ? (
                  <p className="ds-composecard__sys" data-tone="ok">Promoted to the template — future runs get it too.</p>
                ) : resolved === "dismissed" ? (
                  <p className="ds-composecard__note">Kept on this run only.</p>
                ) : (
                  <div className="ds-composecard__choicebox">
                    <span className="ds-composecard__choiceq">Apply to the entire template?</span>
                    <div className="ds-composecard__choiceact">
                      <button type="button" className="ds-composecard__promote" disabled={promoting} onClick={() => void promote()}>
                        {promoting ? "Applying…" : "Apply to template"}
                      </button>
                      <button type="button" className="ds-composecard__keep" onClick={() => setResolved("dismissed")}>Keep on this run</button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {error && <p className="ds-composecard__sys" data-tone="err" role="alert">{error}</p>}
          </div>
        </div>

        {/* the composer wrapper carries the ModeBar bottom clearance (same law as AgentDropCard's foot) */}
        <div className="ds-composecard__composer">
          <div className="ds-composecard__foot">
            <span className="ds-composecard__hint" aria-hidden="true">applies to this run · then optionally the template</span>
            {!applied && (
              <button type="button" className="ds-composecard__create" disabled={same || busy} onClick={() => void applyRun()}>
                {busy ? "Applying…" : "Apply to this run"}
              </button>
            )}
          </div>
        </div>
      </GlassSurface>
    </div>,
    document.body,
  );
}

/** A small inline "skill" mark — a bookmark/tag glyph (the KindIcon inline pattern, no icon dependency). */
function SkillGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 2.5h8v11l-4-2.6-4 2.6z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  );
}
