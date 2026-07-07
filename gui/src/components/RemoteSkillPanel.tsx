/**
 * RemoteSkillPanel — the left-edge detail inspector for an ONLINE marketplace row (the twin of SkillPanel for
 * a not-yet-installed skill). Opened by clicking a remote card; shows the row's FULLER description (unclamped),
 * its index/author + source link, and — best-effort — the skill's real SKILL.md fetched straight from GitHub
 * (raw.githubusercontent.com, CORS-open) and parsed with core's pure parseSkillDoc: the requires/allowed floor
 * + the SKILL.md body, so a human OR an agent composing a node can read what the skill does before binding it.
 * A non-GitHub source (a catalog page) has no fetchable SKILL.md ⇒ the panel degrades to the metadata + source
 * link, never blank. Carries the one-click INSTALL action too (mirroring the card): install → the skill lands in
 * the installed ring and becomes a bindable, draggable local card (via the context's installedNonce refresh).
 */
import { useEffect, useState } from "react";
import { SideCard } from "./SideCard";
import { MarkdownReader } from "./MarkdownReader";
import { ToolTag } from "./toolMeta";
import { useRemoteSkill } from "./RemoteSkillContext";
import { fetchRemoteSkillDoc, type RemoteSkillDetail } from "../data/remoteSkillDoc";
import { installRemoteSkill } from "../data/runView";
import "../styles/skillpanel.css";
import "../styles/skillmarket.css";

export function RemoteSkillPanel() {
  const { open, close, bumpInstalled } = useRemoteSkill();
  const [detail, setDetail] = useState<RemoteSkillDetail | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "done">("idle");
  const [showFull, setShowFull] = useState(false);
  const [install, setInstall] = useState<{ state: "idle" | "busy" | "done" | "error"; msg?: string }>({ state: "idle" });

  // Best-effort fetch of the full SKILL.md whenever the open row changes; reset the install + body-expand state.
  useEffect(() => {
    if (!open) { setDetail(null); setStatus("idle"); return; }
    let alive = true;
    setStatus("loading"); setShowFull(false); setInstall({ state: "idle" });
    fetchRemoteSkillDoc(open.source, open.slug).then((d) => { if (alive) { setDetail(d); setStatus("done"); } });
    return () => { alive = false; };
  }, [open?.source, open?.slug]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const doInstall = async () => {
    if (install.state === "busy" || install.state === "done") return;
    setInstall({ state: "busy" });
    const r = await installRemoteSkill(open.source);
    if (r.ok) { setInstall({ state: "done" }); bumpInstalled(); }
    else setInstall({ state: "error", msg: r.error });
  };

  const requires = detail?.requires ?? [];
  const extraAllowed = (detail?.allowed ?? []).filter((t) => !requires.includes(t));

  return (
    <SideCard open={!!open} onClose={close} accent="remote" ariaLabel={`online skill ${open.name}`}>
        <div className="ds-skillpanel__head">
          <div className="ds-skillpanel__title">
            <span className="ds-skillpanel__eyebrow">online skill · {open.index}</span>
            <h2 className="ds-skillpanel__name">{open.name}</h2>
          </div>
        </div>

        <div className="ds-skillpanel__body">
          {/* the FULLER description — the same field the card clamps to 3 lines, here unclamped */}
          {open.description
            ? <p className="ds-skillpanel__desc">{open.description}</p>
            : <p className="ds-skillpanel__desc ds-skillpanel__desc--muted">No description provided by the index.</p>}

          <div className="ds-skillpanel__badges">
            {open.author && <span className="ds-skillpanel__badge ds-skillpanel__badge--muted">{open.author}</span>}
            <a className="ds-skillcard__srclink" href={open.source} target="_blank" rel="noreferrer" title={open.source}>source ↗</a>
          </div>

          {/* the one-click INSTALL (also on the card) — install → it becomes a draggable local card */}
          <div className="ds-skillpanel__install">
            <button
              type="button"
              className="ds-skillcard__install"
              disabled={install.state === "busy" || install.state === "done"}
              onClick={() => void doInstall()}
            >
              {install.state === "busy" ? "Installing…" : install.state === "done" ? "Installed ✓" : "Install skill"}
            </button>
            {install.state === "done" && <span className="ds-skillpanel__muted">Added to your installed ring — drag it onto a node.</span>}
            {install.state === "error" && <span className="ds-skillpanel__muted" role="alert">install failed: {install.msg}</span>}
          </div>

          {status === "loading" && <div className="ds-skillpanel__muted">fetching the full SKILL.md…</div>}

          {status === "done" && detail && (
            <>
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
              {detail.body?.trim() && (
                <div className="ds-skillpanel__content">
                  <div className="ds-skillpanel__key">content</div>
                  <div className={`ds-skillpanel__md${showFull ? " is-full" : ""}`}>
                    <MarkdownReader source={detail.body} />
                  </div>
                  <button type="button" className="ds-skillpanel__more" onClick={() => setShowFull((v) => !v)}>
                    {showFull ? "show less" : "show full SKILL.md"}
                  </button>
                </div>
              )}
              <div className="ds-skillpanel__from" title={detail.fetchedFrom}>from {detail.fetchedFrom}</div>
            </>
          )}

          {status === "done" && !detail && (
            <div className="ds-skillpanel__muted">
              Full SKILL.md isn’t fetchable for this source — install it to inspect it locally, or open the source ↗.
            </div>
          )}
        </div>
    </SideCard>
  );
}
