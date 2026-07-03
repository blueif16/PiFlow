/**
 * SkillMarketPanel — the skill MARKETPLACE: a full-height glass rail on the LEFT edge (mirroring the
 * Companion's right rail), layered over the flowmap with no backdrop, one tier below the floating
 * MenuBar/ModeBar. Toggled by the ModeBar's "S" key (the 'd' digest wiring, cloned).
 *
 * DATA: pure projection of `/__piflow/skills/<run>` (loadSkills) — the server resolves every skill across the
 * WORKSPACE (this repo's `.piflow`/skill dirs) and INSTALLED (global) rings. The panel fetches once on open;
 * a search box + ring toggle narrow the list via the tested `marketFilter` projection (id + name + description,
 * case-insensitive). Each card renders the skill's identity + its `requires` floor + a provisioned/needs-catalog
 * badge + shadow/error hints. A card CLICK opens the existing left SkillPanel detail (SkillContext.openSkill —
 * reused, not duplicated); a card is DRAGGABLE (the SKILL_CHIP_DND_MIME payload) — drop it on a node's skill
 * slot to set that node's loadout skill. The endpoint is built in parallel and may be unavailable ⇒ a graceful
 * empty state, never a throw.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GlassSurface } from "./GlassSurface";
import { ToolTag } from "./toolMeta";
import { useSkill } from "./SkillContext";
import { SKILL_CHIP_DND_MIME, buildSkillChip, marketFilter } from "../data/skillChips";
import { loadSkills, searchRemoteSkills, type MarketSkill, type RemoteSkill } from "../data/runView";
import "../styles/skillmarket.css";

/** The panel's lanes: the two LOCAL rings (bind-ready, draggable) + the ONLINE lane (the live remote
 *  indexes via `/__piflow/skill-search` — hundreds of thousands of rows; cards install via `skill add`). */
type Ring = MarketSkill["ring"] | "online";

export function SkillMarketPanel({ activeRun, open, onClose }: { activeRun: string; open: boolean; onClose: () => void }) {
  const { openSkill } = useSkill();
  const [skills, setSkills] = useState<MarketSkill[] | null>(null);
  const [mcpCatalog, setMcpCatalog] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "loaded" | "empty">("idle");
  const [query, setQuery] = useState("");
  const [ring, setRing] = useState<Ring | null>(null);
  // The ONLINE lane's own state: debounced live search over the remote indexes (only while ring==='online').
  const [remote, setRemote] = useState<RemoteSkill[] | null>(null);
  const [remoteStatus, setRemoteStatus] = useState<"idle" | "searching" | "done" | "error">("idle");
  const [remoteError, setRemoteError] = useState("");
  const remoteSeq = useRef(0);

  // Fetch on open (and when the run changes); the marketplace is ~static so there is no poll. Reset filters
  // each open so the panel starts unfiltered.
  useEffect(() => {
    if (!open || !activeRun) { setSkills(null); setStatus("idle"); return; }
    let alive = true;
    setStatus("loading"); setQuery(""); setRing(null);
    loadSkills(activeRun).then((m) => {
      if (!alive) return;
      setSkills(m?.skills ?? []);
      setMcpCatalog(m?.mcpCatalog ?? false);
      setStatus(m && m.skills.length ? "loaded" : "empty");
    });
    return () => { alive = false; };
  }, [open, activeRun]);

  // ONLINE lane: debounce the query into a live remote search. A stale response (an earlier query resolving
  // after a later one) is dropped via the sequence guard. An empty query just shows the type-to-search hint.
  useEffect(() => {
    if (ring !== "online" || !open) { setRemote(null); setRemoteStatus("idle"); setRemoteError(""); return; }
    const q = query.trim();
    if (!q) { setRemote(null); setRemoteStatus("idle"); setRemoteError(""); return; }
    const seq = ++remoteSeq.current;
    setRemoteStatus("searching");
    const t = setTimeout(async () => {
      const r = await searchRemoteSkills(q);
      if (seq !== remoteSeq.current) return; // a newer query superseded this one
      if ("error" in r) { setRemote(null); setRemoteError(r.error); setRemoteStatus("error"); }
      else { setRemote(r.rows); setRemoteError(""); setRemoteStatus("done"); }
    }, 350);
    return () => clearTimeout(t);
  }, [ring, query, open]);

  // Escape closes (the shell-wide convention); the panel is layered (no scrim), so no click-away trap.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // the filtered projection (tested pure fn) — narrows by ring + query, PRESERVING the server's order.
  // (the online lane renders its own remote list; marketFilter only understands the two LOCAL rings)
  const localRing = ring === "online" ? undefined : (ring ?? undefined);
  const shown = useMemo(() => marketFilter(skills ?? [], query, localRing), [skills, query, localRing]);
  const counts = useMemo(() => {
    const all = skills ?? [];
    return { all: all.length, workspace: all.filter((s) => s.ring === "workspace").length, installed: all.filter((s) => s.ring === "installed").length };
  }, [skills]);

  if (!open) return null;

  return createPortal(
    <div className="ds-market-layer">
      <GlassSurface variant="window" className="ds-market" legibleText aria-label="Skill marketplace">
        <button type="button" className="ds-market__close" onClick={onClose} title="Close (S)" aria-label="Close marketplace">✕</button>

        <header className="ds-market__head">
          <div className="ds-market__title">
            <span className="ds-market__eyebrow">skill marketplace</span>
            <h2 className="ds-market__name">Skills · {counts.all}</h2>
          </div>
          {!mcpCatalog && status === "loaded" && (
            <span className="ds-market__mcpwarn" title="No MCP catalog is wired — skills that need MCP tools show 'needs catalog sync'.">no MCP catalog</span>
          )}
        </header>

        <div className="ds-market__controls">
          <input
            type="search"
            className="ds-market__search"
            placeholder={ring === "online" ? "Search the live skill indexes…" : "Search skills…"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={ring === "online" ? "Search remote skill indexes" : "Search skills by name or description"}
          />
          <div className="ds-market__rings" role="group" aria-label="Filter by ring">
            <button type="button" className={`ds-market__ring${ring === null ? " is-active" : ""}`} aria-pressed={ring === null} onClick={() => setRing(null)}>all <b>{counts.all}</b></button>
            <button type="button" className={`ds-market__ring${ring === "workspace" ? " is-active" : ""}`} aria-pressed={ring === "workspace"} onClick={() => setRing("workspace")}>workspace <b>{counts.workspace}</b></button>
            <button type="button" className={`ds-market__ring${ring === "installed" ? " is-active" : ""}`} aria-pressed={ring === "installed"} onClick={() => setRing("installed")}>installed <b>{counts.installed}</b></button>
            <button type="button" className={`ds-market__ring${ring === "online" ? " is-active" : ""}`} aria-pressed={ring === "online"} onClick={() => setRing("online")} title="Search the live remote skill indexes (600k+ skills across 7 sources)">online</button>
          </div>
        </div>

        {ring === "online" ? (
          <>
            {remoteStatus === "idle" && (
              <div className="ds-market__muted">Type to search the live remote indexes — 600k+ skills across topagentskills · agentskill · claude-plugins · claudskills. Install a result with <code>piflowctl skill add &lt;source&gt;</code> (click a card to copy).</div>
            )}
            {remoteStatus === "searching" && <div className="ds-market__muted">searching the remote indexes…</div>}
            {remoteStatus === "error" && <div className="ds-market__muted" role="alert">remote search failed: {remoteError}</div>}
            {remoteStatus === "done" && (remote?.length ?? 0) === 0 && (
              <div className="ds-market__muted">No remote skills match “{query}”.</div>
            )}
            {remoteStatus === "done" && (remote?.length ?? 0) > 0 && (
              <ul className="ds-market__list">
                {remote!.map((s) => (
                  <li key={`${s.index}:${s.slug}`}>
                    <RemoteSkillCard skill={s} />
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <>
            {status === "loading" && <div className="ds-market__muted">loading skills…</div>}
            {status === "empty" && (
              <div className="ds-market__muted">
                No skills resolved for this run — the marketplace endpoint may be unavailable, or no skill dirs are declared.
              </div>
            )}
            {status === "loaded" && shown.length === 0 && (
              <div className="ds-market__muted">No skills match “{query}”{ring ? ` in ${ring}` : ""}.</div>
            )}

            {status === "loaded" && shown.length > 0 && (
              <ul className="ds-market__list">
                {shown.map((s) => (
                  <li key={`${s.ring}:${s.id}`}>
                    <SkillCard skill={s} onOpen={() => openSkill(s.id)} />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </GlassSurface>
    </div>,
    document.body,
  );
}

/** One ONLINE result card — NOT draggable (the skill isn't in a local ring yet, so a node can't bind it);
 *  clicking copies the exact install command, and the source link opens the repo. After `skill add` the
 *  skill appears in the installed ring and becomes a bindable, draggable local card. */
function RemoteSkillCard({ skill }: { skill: RemoteSkill }) {
  const [copied, setCopied] = useState(false);
  const cmd = `piflowctl skill add ${skill.source}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable (permissions/http) — the title still shows the command */
    }
  };

  return (
    <div
      className="ds-skillcard"
      role="button"
      tabIndex={0}
      onClick={copy}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void copy(); } }}
      title={`${skill.name} — click to copy: ${cmd}`}
      aria-label={`Remote skill ${skill.name} from ${skill.index}. Click to copy its install command.`}
    >
      <div className="ds-skillcard__head">
        <span className="ds-skillcard__mark">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 2.5h8v11l-4-2.6-4 2.6z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="ds-skillcard__name">{skill.name}</span>
        <span className="ds-skillcard__ring" data-ring="online">{skill.index}</span>
      </div>

      {skill.description && <p className="ds-skillcard__desc">{skill.description}</p>}

      {/* the VISIBLE install affordance: the exact command, one click to copy — never only a tooltip */}
      <div className={`ds-skillcard__cmd${copied ? " is-copied" : ""}`} aria-live="polite">
        <code className="ds-skillcard__cmdtext">{cmd}</code>
        <span className="ds-skillcard__cmdcopy">{copied ? "copied ✓" : "copy"}</span>
      </div>

      <div className="ds-skillcard__badges">
        {skill.author && <span className="ds-skillcard__badge" data-tone="muted">{skill.author}</span>}
        <a
          className="ds-skillcard__srclink"
          href={skill.source}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          title={skill.source}
        >
          source ↗
        </a>
      </div>
    </div>
  );
}

/** One marketplace card — draggable (the skill MIME) + clickable (opens the SkillPanel detail). */
function SkillCard({ skill, onOpen }: { skill: MarketSkill; onOpen: () => void }) {
  const name = skill.display?.label ?? skill.name ?? skill.id;
  const requires = skill.requires ?? [];
  // provisioned=false + declared MCP tools ⇒ the skill can't bind until an MCP catalog is synced.
  const needsCatalog = skill.provisioned === false && (skill.mcpRequires?.length ?? 0) > 0;

  return (
    <div
      className="ds-skillcard"
      role="button"
      tabIndex={0}
      draggable
      data-shadowed={skill.shadowed ? "true" : undefined}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      onDragStart={(ev) => {
        ev.dataTransfer.setData(SKILL_CHIP_DND_MIME, JSON.stringify(buildSkillChip(skill.id)));
        ev.dataTransfer.effectAllowed = "copy";
      }}
      title={`${name} — click to inspect, drag onto a node to set its skill`}
      aria-label={`Skill ${name}${skill.description ? ` — ${skill.description}` : ""}. Click to inspect; drag onto a node to set its loadout skill.`}
    >
      <div className="ds-skillcard__head">
        <span className="ds-skillcard__mark" style={skill.display?.color ? { color: skill.display.color } : undefined}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 2.5h8v11l-4-2.6-4 2.6z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="ds-skillcard__name">{name}</span>
        <span className="ds-skillcard__ring" data-ring={skill.ring}>{skill.ring}</span>
      </div>

      {skill.description && <p className="ds-skillcard__desc">{skill.description}</p>}

      <div className="ds-skillcard__badges">
        {needsCatalog && <span className="ds-skillcard__badge" data-tone="warn" title={`Needs MCP tools: ${skill.mcpRequires.join(", ")}`}>needs catalog sync</span>}
        {skill.shadowed && <span className="ds-skillcard__badge" data-tone="muted" title="A higher-priority skill dir declares this id too.">shadowed</span>}
        {skill.error && <span className="ds-skillcard__badge" data-tone="err" role="alert" title={skill.error}>parse error</span>}
      </div>

      {requires.length > 0 && (
        <div className="ds-skillcard__tags">
          {requires.slice(0, 6).map((t) => <ToolTag key={t} name={t} title={`${t} — required by this skill`} />)}
          {requires.length > 6 && <span className="ds-skillcard__more">+{requires.length - 6}</span>}
        </div>
      )}
    </div>
  );
}
