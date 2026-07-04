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
import { useRemoteSkill } from "./RemoteSkillContext";
import { SKILL_CHIP_DND_MIME, buildSkillChip, marketFilter } from "../data/skillChips";
import { installRemoteSkill, loadSkills, searchRemoteSkills, type MarketSkill, type RemoteSkill } from "../data/runView";
import { loadSkillIndex, searchSkillIndex, type SkillIndexArtifact } from "../data/skillIndex";
import "../styles/skillmarket.css";

/** The panel's lanes: the two LOCAL rings (bind-ready, draggable) + the ONLINE lane (the live remote
 *  indexes via `/__piflow/skill-search` — hundreds of thousands of rows; a card opens a detail page and
 *  one-click Installs into the local rings). */
type Ring = MarketSkill["ring"] | "online";

export function SkillMarketPanel({ activeRun, open, onClose }: { activeRun: string; open: boolean; onClose: () => void }) {
  const { openSkill } = useSkill();
  const { openRemote, installedNonce, bumpInstalled } = useRemoteSkill();
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
  // The BUNDLED index (the site's static artifact): loaded once when the online lane opens; when present,
  // search is INSTANT and client-side, and the live fan-out becomes an explicit "deep search" action.
  const [indexArt, setIndexArt] = useState<SkillIndexArtifact | null | undefined>(undefined);
  const [deepQuery, setDeepQuery] = useState<string | null>(null); // the query a deep search was requested for

  // Fetch on open (and when the run changes); the marketplace is ~static so there is no poll. A successful
  // install bumps `installedNonce` → the rings re-fetch so the new skill shows in the installed lane (but the
  // filter reset is a SEPARATE effect below, so an install refresh never yanks the user out of their search).
  useEffect(() => {
    if (!open || !activeRun) { setSkills(null); setStatus("idle"); return; }
    let alive = true;
    setStatus("loading");
    loadSkills(activeRun).then((m) => {
      if (!alive) return;
      setSkills(m?.skills ?? []);
      setMcpCatalog(m?.mcpCatalog ?? false);
      setStatus(m && m.skills.length ? "loaded" : "empty");
    });
    return () => { alive = false; };
  }, [open, activeRun, installedNonce]);

  // Reset the search + ring filter each (re)open so the panel starts unfiltered — but NOT on an install refresh.
  useEffect(() => {
    if (open) { setQuery(""); setRing(null); }
  }, [open, activeRun]);

  // ONLINE lane, load-once: the bundled index (same-origin on the deployed site, canonical URL locally).
  useEffect(() => {
    if (ring !== "online" || !open || indexArt !== undefined) return;
    let alive = true;
    void loadSkillIndex().then((a) => { if (alive) setIndexArt(a); });
    return () => { alive = false; };
  }, [ring, open, indexArt]);

  // A new query invalidates a prior deep-search view (back to the instant index results).
  useEffect(() => { setDeepQuery(null); }, [query]);

  // The INSTANT path: rank the bundled index client-side on every keystroke (pure, single-digit ms).
  const indexHits = useMemo(() => {
    if (ring !== "online" || !indexArt || !query.trim()) return null;
    return searchSkillIndex(indexArt.docs, query.trim(), 30);
  }, [ring, indexArt, query]);

  // The LIVE path (deep search): debounced remote fan-out. It runs when the bundled index is UNAVAILABLE
  // (degrade), or when the user explicitly asked for the long tail (deepQuery). A stale response (an
  // earlier query resolving after a later one) is dropped via the sequence guard.
  const liveActive = ring === "online" && open && (indexArt === null || deepQuery === query.trim());
  useEffect(() => {
    if (!liveActive) { setRemote(null); setRemoteStatus("idle"); setRemoteError(""); return; }
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
  }, [liveActive, query]);

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
            {/* idle hint — honest about which path answers */}
            {!query.trim() && (
              <div className="ds-market__muted">
                {indexArt
                  ? <>Instant index: <b>{indexArt.docs.length.toLocaleString()}</b> curated skills, built {new Date(indexArt.builtAt).toLocaleDateString()} — type to search. The full 600k+ live universe is one “deep search” away.</>
                  : indexArt === null
                    ? <>Type to search the live remote indexes — 600k+ skills across topagentskills · agentskill · claude-plugins · claudskills. (The bundled instant index isn’t reachable from here.)</>
                    : <>loading the bundled index…</>}
                {" "}Click a card to open its detail; <b>Install</b> adds it to your installed ring — then drag it onto a node.
              </div>
            )}

            {/* the INSTANT path — bundled-index hits, ranked client-side as you type */}
            {indexArt && query.trim() && deepQuery !== query.trim() && (
              <>
                {(indexHits?.length ?? 0) === 0 && (
                  <div className="ds-market__muted">No indexed skills match “{query}”.</div>
                )}
                {(indexHits?.length ?? 0) > 0 && (
                  <ul className="ds-market__list">
                    {indexHits!.map((s) => (
                      <li key={`idx:${s.index}:${s.slug}`}>
                        <RemoteSkillCard skill={s} onOpen={() => openRemote(s)} onInstalled={bumpInstalled} />
                      </li>
                    ))}
                  </ul>
                )}
                <button type="button" className="ds-market__deep" onClick={() => setDeepQuery(query.trim())}>
                  need more? deep-search the live indexes (600k+, a few seconds) →
                </button>
              </>
            )}

            {/* the LIVE path — index unavailable (degrade) or an explicit deep search */}
            {(indexArt === null || deepQuery === query.trim()) && query.trim() && (
              <>
                {remoteStatus === "searching" && <div className="ds-market__muted">searching the live indexes…</div>}
                {remoteStatus === "error" && <div className="ds-market__muted" role="alert">live search failed: {remoteError}</div>}
                {remoteStatus === "done" && (remote?.length ?? 0) === 0 && (
                  <div className="ds-market__muted">No remote skills match “{query}”.</div>
                )}
                {remoteStatus === "done" && (remote?.length ?? 0) > 0 && (
                  <ul className="ds-market__list">
                    {remote!.map((s) => (
                      <li key={`${s.index}:${s.slug}`}>
                        <RemoteSkillCard skill={s} onOpen={() => openRemote(s)} onInstalled={bumpInstalled} />
                      </li>
                    ))}
                  </ul>
                )}
              </>
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

/** One ONLINE result card — clicking OPENS the RemoteSkillPanel detail (the fuller description + the fetched
 *  SKILL.md); an explicit Install button adds it to the installed ring (after which it becomes a bindable,
 *  draggable local card); the source link opens the repo. Not draggable: a remote hit has no local id a node
 *  can bind yet — Install is the bridge. */
function RemoteSkillCard({ skill, onOpen, onInstalled }: { skill: RemoteSkill; onOpen: () => void; onInstalled: () => void }) {
  const [install, setInstall] = useState<{ state: "idle" | "busy" | "done" | "error"; msg?: string }>({ state: "idle" });

  const doInstall = async () => {
    if (install.state === "busy" || install.state === "done") return;
    setInstall({ state: "busy" });
    const r = await installRemoteSkill(skill.source);
    if (r.ok) { setInstall({ state: "done" }); onInstalled(); }
    else setInstall({ state: "error", msg: r.error });
  };

  return (
    <div
      className="ds-skillcard"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}
      title={`${skill.name} — click to open its detail`}
      aria-label={`Online skill ${skill.name} from ${skill.index}. Click to open its detail.`}
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

      <div className="ds-skillcard__badges">
        {/* the one-click INSTALL (also on the detail page) — stopPropagation so it doesn't open the detail */}
        <button
          type="button"
          className="ds-skillcard__install"
          disabled={install.state === "busy" || install.state === "done"}
          onClick={(e) => { e.stopPropagation(); void doInstall(); }}
        >
          {install.state === "busy" ? "Installing…" : install.state === "done" ? "Installed ✓" : "Install"}
        </button>
        {install.state === "error" && (
          <span className="ds-skillcard__badge" data-tone="err" role="alert" title={install.msg}>install failed</span>
        )}
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
