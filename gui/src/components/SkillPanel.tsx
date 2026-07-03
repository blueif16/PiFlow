/**
 * SkillPanel — the left-edge skill-bundle inspector. Opened by clicking a loaded skill chip (on the node
 * card's AgentHoverCard or in the NodeHud's agent-definition block) via SkillContext; shows the bundle the
 * skill IS: its name, what it's about (description), the tools it needs (the `requires` floor, rendered as
 * tool tags — an `mcp.*`/namespaced id gets the plug glyph, so MCP-vs-native reads at a glance), the wider
 * `allowed` ceiling, and a PREVIEW of the SKILL.md content (partial by default, expandable to the full body).
 *
 * DATA: pure projection of `/__piflow/skill` (server resolves the id across pi's skill dirs, reads + parses
 * the SKILL.md with core's shared `parseSkillManifest`). A skill that declares no manifest resolves with EMPTY
 * requires/allowed — shown as "native tools · none declared", never an error. Floats at z-modal so it's visible
 * whether opened from the canvas or from inside an open NodeHud.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GlassSurface } from "./GlassSurface";
import { MarkdownReader } from "./MarkdownReader";
import { ToolTag } from "./toolMeta";
import { useSkill } from "./SkillContext";
import { loadSkill, type SkillBundle } from "../data/runView";
import "../styles/skillpanel.css";

/** `…/harden-blueprint/SKILL.md` → `harden-blueprint`; a bare id passes through. */
function shortName(p: string): string {
  const parts = p.replace(/\/SKILL\.md$/i, "").split("/");
  return parts[parts.length - 1] || p;
}

export function SkillPanel({ activeRun }: { activeRun: string }) {
  const { open, close } = useSkill();
  const [bundle, setBundle] = useState<SkillBundle | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "loaded" | "missing">("idle");
  const [showFull, setShowFull] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Fetch the bundle whenever the open skill (or the run) changes; reset the body expand each time.
  useEffect(() => {
    if (!open || !activeRun) { setBundle(null); setStatus("idle"); return; }
    let alive = true;
    setStatus("loading");
    setShowFull(false);
    loadSkill(activeRun, open).then((b) => {
      if (!alive) return;
      setBundle(b);
      setStatus(b ? "loaded" : "missing");
    });
    return () => { alive = false; };
  }, [open, activeRun]);

  // Escape closes (the shell-wide convention); the panel is layered (no scrim), so no click-away trap.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  const label = bundle?.name ?? shortName(open);
  // requires = the FLOOR (what the skill needs); allowed-only = the rest of the ceiling not already required.
  const requires = bundle?.requires ?? [];
  const extraAllowed = (bundle?.allowed ?? []).filter((t) => !requires.includes(t));
  const noManifest = status === "loaded" && requires.length === 0 && extraAllowed.length === 0;

  return createPortal(
    <div className="ds-skillpanel-layer" ref={panelRef}>
      <GlassSurface as="aside" variant="soft" className="ds-skillpanel" legibleText role="dialog" aria-label={`skill ${label}`}>
        <div className="ds-skillpanel__head">
          <div className="ds-skillpanel__title">
            <span className="ds-skillpanel__eyebrow">skill bundle</span>
            <h2 className="ds-skillpanel__name">{label}</h2>
          </div>
          <button type="button" className="ds-skillpanel__close" aria-label="Close skill panel" title="Close (Esc)" onClick={close}>
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {status === "loading" && <div className="ds-skillpanel__muted">loading skill…</div>}
        {status === "missing" && (
          <div className="ds-skillpanel__muted">
            couldn’t resolve <code>{shortName(open)}</code> — the SKILL.md wasn’t found in the known skill dirs.
          </div>
        )}

        {status === "loaded" && bundle && (
          <div className="ds-skillpanel__body">
            {/* what the bundle is about */}
            {bundle.description
              ? <p className="ds-skillpanel__desc">{bundle.description}</p>
              : <p className="ds-skillpanel__desc ds-skillpanel__desc--muted">No description in the SKILL.md frontmatter.</p>}

            {/* MCP-or-native at a glance */}
            <div className="ds-skillpanel__badges">
              <span className="ds-skillpanel__badge" data-on={bundle.needsMcp}>
                {bundle.needsMcp ? "needs MCP" : "native tools"}
              </span>
              {noManifest && <span className="ds-skillpanel__badge ds-skillpanel__badge--muted">no manifest — none declared</span>}
            </div>

            {/* tools it needs (the requires FLOOR) + the wider allowed ceiling */}
            {requires.length > 0 && (
              <div className="ds-skillpanel__row">
                <span className="ds-skillpanel__key">requires</span>
                <span className="ds-skillpanel__tags">
                  {requires.map((t) => <ToolTag key={t} name={t} title={`${t} — required by this skill`} />)}
                </span>
              </div>
            )}
            {extraAllowed.length > 0 && (
              <div className="ds-skillpanel__row">
                <span className="ds-skillpanel__key">allowed</span>
                <span className="ds-skillpanel__tags">
                  {extraAllowed.map((t) => <ToolTag key={t} name={t} className="ds-tooltag--deny" title={`${t} — permitted (ceiling)`} />)}
                </span>
              </div>
            )}

            {/* the SKILL.md content — partial by default, expandable to the full body */}
            {bundle.body?.trim() && (
              <div className="ds-skillpanel__content">
                <div className="ds-skillpanel__key">content</div>
                <div className={`ds-skillpanel__md${showFull ? " is-full" : ""}`}>
                  <MarkdownReader source={bundle.body} />
                </div>
                <button type="button" className="ds-skillpanel__more" onClick={() => setShowFull((v) => !v)}>
                  {showFull ? "show less" : "show full SKILL.md"}
                </button>
              </div>
            )}

            {bundle.resolvedFrom && (
              <div className="ds-skillpanel__from" title={bundle.resolvedFrom}>from {bundle.resolvedFrom}</div>
            )}
          </div>
        )}
      </GlassSurface>
    </div>,
    document.body,
  );
}
