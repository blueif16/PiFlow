/**
 * NodeHud — the "clicked-up" view, laid out around the node.
 *
 *      ┌ IDENT ┐  model·tools        (top-right corner: the shell MenuBar floats here)
 *      │ LEFT  │      CENTER      │ RIGHT │   inputs/scope · content · output
 *      └──────────── BOTTOM ──────────────┘   progress (avg-of-prior-runs ETA)
 *
 * IDENT (top-left) is the morph target: the canvas node grows into the identity card
 * (shared layoutId). CENTER is ONE in-place content surface — an at-rest Overview that
 * is REPLACED directly (no floating card, no container background) by a region's full
 * detail on HOVER, or an input file's parsed content on CLICK. The swap is STICKY: it
 * stays after the cursor leaves and only returns to the Overview on a background click
 * (or the in-panel "back" control). A down-chevron cue stands in for the scrollbar.
 *
 * Every value is real (data.rv = the distilled run-view node). Nothing is mocked;
 * a region with no backing data renders empty.
 */
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import * as motion from "motion/react-client";
import { Button } from "./Button";
import { ProgressBar } from "./ProgressBar";
import { StatusPill, HudCorners } from "./HudBits";
import { MarkdownReader } from "./MarkdownReader";
import { JsonReader } from "./JsonReader";
import { CacheDonut } from "./CacheDonut";
import { expandTransition, easing } from "../motion/transitions";
import type { FlowNodeData } from "./WorkflowNode";
import { formatMs, formatBytes, fileUrl, isImagePath, type RunViewNode, type ScopeKind } from "../data/runView";
import "../styles/hud.css";
import "../styles/reader.css";

type RegionKey = "model" | "tools" | "output" | "progress";
const REGION_KEYS: readonly RegionKey[] = ["model", "tools", "output", "progress"];

// A file the CENTER can render — ANY path the node touched (input read, output artifact, or write).
// `preview` (when present, from a read's telemetry snapshot) paints instantly while the real bytes load.
type FileTarget = { path: string; displayPath: string; preview?: string };

// what the CENTER shows beyond the at-rest Overview: a hovered region's detail (sticky)
// or a clicked file's content. `null` = the Overview.
type CenterView = { kind: "region"; region: RegionKey } | { kind: "file"; file: FileTarget } | null;

// Deep-link a region open via `?peek=<region>` (also how the hover-expand is verified/screenshotted).
const initialPeek: RegionKey | null =
  typeof window !== "undefined"
    ? (REGION_KEYS as readonly string[]).includes(new URLSearchParams(window.location.search).get("peek") ?? "")
      ? (new URLSearchParams(window.location.search).get("peek") as RegionKey)
      : null
    : null;

// Deep-link a selected input file via `?file=<index>` (handy + how the file view is screenshotted).
const initialFile: number | null =
  typeof window !== "undefined"
    ? (() => {
        const v = new URLSearchParams(window.location.search).get("file");
        const n = v == null ? NaN : Number(v);
        return Number.isInteger(n) && n >= 0 ? n : null;
      })()
    : null;

// the ?file= deep-link is an index into rv.reads, resolved to a FileTarget in the component (rv-dependent);
// only the region peek can be applied before rv is known.
const initialView: CenterView = initialPeek ? { kind: "region", region: initialPeek } : null;

const SCOPE_META: Record<ScopeKind, { label: string; hint: string }> = {
  run: { label: "Run workspace", hint: "filesystem" },
  skill: { label: "Skill", hint: "loaded skill" },
  template: { label: "Templates", hint: "shared" },
  package: { label: "Packages", hint: "repo" },
  repo: { label: "Repo source", hint: "repo" },
};

// tool → accent class (read=accent, write/edit=success, others neutral) for the bar chart + tags.
export const TOOL_TONE: Record<string, string> = {
  read: "accent", grep: "accent", ls: "muted", find: "muted",
  edit: "success", write: "success", bash: "warn", submit_result: "accent",
};
export const toolTone = (t: string) => TOOL_TONE[t] ?? "muted";

// status → the progress eyebrow word
const STATUS_LABEL: Record<NonNullable<FlowNodeData["status"]>, string> = {
  idle: "Idle", selected: "Selected", running: "Running", success: "Complete", error: "Failed",
};

const fileName = (p: string) => p.split("/").pop() || p;

export interface NodeHudProps {
  id: string;
  data: FlowNodeData;
  /** the run id — used to fetch a file's real bytes from the read-back endpoint. */
  run: string;
  onClose: () => void;
  reduce: boolean;
  dialogRef: Ref<HTMLDivElement>;
}

export function NodeHud({ id, data, run, onClose, reduce, dialogRef }: NodeHudProps) {
  const rv = data.rv;
  const status = data.status ?? "idle";
  // the single CENTER state: a hovered region (sticky), a clicked file, or null (Overview)
  const [view, setView] = useState<CenterView>(initialView);
  const pin = (region: RegionKey) => setView({ kind: "region", region });
  const openFile = (f: FileTarget) => setView({ kind: "file", file: { path: f.path, displayPath: f.displayPath, preview: f.preview } });
  const reset = () => setView(null);

  // apply the ?file=<idx> deep-link once (rv-dependent, so it can't be in the module-level initialView).
  useEffect(() => {
    if (initialFile != null && rv?.reads[initialFile]) openFile(rv.reads[initialFile]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // progress: a completed node is 100%; the ETA is the mean of prior runs (rv.expectedMs)
  const done = status === "success" || status === "error";
  const pct = data.progress != null ? data.progress : done ? 1 : undefined;
  const expected = rv?.expectedMs ?? rv?.durationMs ?? null;

  if (!rv) {
    // graceful fallback if a node has no run-view payload (shouldn't happen with real data)
    return (
      <div className="ds-hud" role="dialog" aria-modal="true" aria-label={`${data.title} details`} tabIndex={-1} ref={dialogRef}>
        <Identity id={id} data={data} reduce={reduce} onClose={onClose} status={status} />
      </div>
    );
  }

  const breakdown = Object.entries(rv.toolBreakdown).sort((a, b) => b[1] - a[1]);

  // input files grouped by source — each read is opened by its path in the CENTER file viewer
  const sources = rv.scopes.map((s) => ({
    kind: s.kind,
    label: SCOPE_META[s.kind]?.label ?? s.label,
    items: rv.reads.map((r) => ({ r })).filter(({ r }) => r.scope === s.kind),
  }));

  const pinnedRegion = view?.kind === "region" ? view.region : null;
  const openPath = view?.kind === "file" ? view.file.path : null;

  return (
    <div
      className="ds-hud"
      role="dialog"
      aria-modal="true"
      aria-label={`${data.title} details`}
      tabIndex={-1}
      ref={dialogRef}
      onClick={(e) => { if (e.target === e.currentTarget) reset(); }}
    >
      {/* ── TOP-LEFT: identity (morph target). TOP-RIGHT corner is left free for the floating MenuBar. ── */}
      <Identity id={id} data={data} reduce={reduce} onClose={onClose} status={status} />

      {/* ── TOP-CENTER: model/provider · tool-call telemetry ── */}
      <div className="ds-hud__meta">
        <Region rk="model" label="Model" active={pinnedRegion === "model"} onEnter={() => pin("model")}>
          <div className="ds-hud-stat">
            <span className="ds-hud-stat__v">{rv.model ?? "—"}</span>
            <span className="ds-hud-stat__k">{rv.provider ?? "provider"}{rv.api ? ` · ${rv.api}` : ""}</span>
          </div>
        </Region>
        <Region rk="tools" label="Tool calls" active={pinnedRegion === "tools"} onEnter={() => pin("tools")}>
          <div className="ds-hud-stat">
            <span className="ds-hud-stat__v">{rv.toolCalls}</span>
            <span className="ds-hud-stat__k ds-hud-stat__k--wrap">
              {breakdown.map(([t, c]) => (
                <span key={t} className="ds-tooltag" data-tone={toolTone(t)}>{t} {c}</span>
              ))}
            </span>
          </div>
        </Region>
      </div>

      {/* ── LEFT: input SOURCES (no wrapper) — click any file to read it in the CENTER ── */}
      <div className="ds-hud__left" style={{ gridArea: "left" }}>
        {sources.length === 0 && <div className="ds-hud-empty">no reads recorded</div>}
        {sources.map((g) => (
          <div key={g.kind} className="ds-source" data-scope={g.kind}>
            <div className="ds-source__head">
              <ScopeGlyph kind={g.kind} />
              <span>{g.label}</span>
              <span className="ds-source__count">{g.items.length}</span>
            </div>
            <div className="ds-source__files">
              {g.items.map(({ r }) => (
                <button
                  key={r.path}
                  type="button"
                  className={`ds-filebtn${openPath === r.path ? " is-sel" : ""}`}
                  onClick={() => openFile(r)}
                  title={r.path}
                >
                  {fileName(r.displayPath)}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* ── CENTER: one in-place surface — Overview at rest, REPLACED by a region detail (hover,
           sticky) or a file's parsed content (click). Click the gutter/background to return. ── */}
      <div
        className="ds-hud__mid"
        style={{ gridArea: "mid" }}
        onClick={(e) => { if (e.target === e.currentTarget) reset(); }}
      >
        {view === null && <Overview rv={rv} status={status} expected={expected} />}
        {pinnedRegion && (
          <CenterPanel key={`r-${pinnedRegion}`} title={DETAIL_TITLE[pinnedRegion]} onBack={reset} reduce={reduce}>
            <Detail region={pinnedRegion} rv={rv} expected={expected} pct={pct} onOpenFile={openFile} />
          </CenterPanel>
        )}
        {view?.kind === "file" && (
          <CenterPanel key={`f-${view.file.path}`} title={view.file.displayPath} onBack={reset} reduce={reduce} wide>
            <FileView run={run} file={view.file} />
          </CenterPanel>
        )}
      </div>

      {/* ── RIGHT: output panel (distinct, "emitted" feel) ────────────────── */}
      <Region rk="output" area="right" label={`Output · ${rv.artifacts.length || rv.writes.length}`} active={pinnedRegion === "output"} onEnter={() => pin("output")}>
        <div className="ds-out">
          {rv.artifacts.length === 0 && rv.writes.length === 0 && <div className="ds-hud-empty">no artifacts</div>}
          {rv.artifacts.map((a) => (
            <button
              key={a.path} type="button"
              className={`ds-out__row ds-out__row--btn${openPath === a.path ? " is-sel" : ""}`}
              data-ok={a.exists} onClick={() => openFile(a)} title={a.displayPath}
            >
              <span className="ds-out__spark" aria-hidden="true" />
              <span className="ds-out__name">{fileName(a.displayPath)}</span>
              <span className="ds-out__meta">{formatBytes(a.bytes)}{a.exists ? " ✓" : " ✗"}</span>
            </button>
          ))}
          {rv.writes.filter((w) => !rv.artifacts.some((a) => a.displayPath === w.displayPath)).map((w) => (
            <button
              key={w.path} type="button"
              className={`ds-out__row ds-out__row--btn${openPath === w.path ? " is-sel" : ""}`}
              data-ok={w.verified} onClick={() => openFile(w)} title={w.displayPath}
            >
              <span className="ds-out__spark" aria-hidden="true" />
              <span className="ds-out__name">{fileName(w.displayPath)}</span>
              <span className="ds-out__meta">{w.bytes != null ? formatBytes(w.bytes) : "wrote"}</span>
            </button>
          ))}
        </div>
      </Region>

      {/* ── BOTTOM: quiet 8px bar with state + % head and elapsed/avg meta ── */}
      <Region rk="progress" area="bottom" label="Progress" bare active={pinnedRegion === "progress"} onEnter={() => pin("progress")}>
        <div className="ds-prog">
          <div className="ds-prog__head">
            <span className="ds-prog__state">{STATUS_LABEL[status]}</span>
            <span className="ds-prog__pct">{pct != null ? `${Math.round(pct * 100)}%` : "—"}</span>
          </div>
          <ProgressBar size="block" value={pct} status={status} aria-label={`${data.title} progress · ${pct != null ? `${Math.round(pct * 100)}%` : "running"}`} />
          <div className="ds-prog__meta">
            <b>{formatMs(rv.durationMs)}</b> elapsed{expected != null ? ` · avg ${formatMs(expected)} / ${rv.priorSamples || 1} run${(rv.priorSamples || 1) === 1 ? "" : "s"}` : ""}
          </div>
        </div>
      </Region>
    </div>
  );
}

/* ── the identity card (morph target), now pinned TOP-LEFT — compact chrome ── */
function Identity({ id, data, reduce, onClose, status }: { id: string; data: FlowNodeData; reduce: boolean; onClose: () => void; status: FlowNodeData["status"] }) {
  return (
    <motion.div
      layoutId={`node-${id}`}
      transition={expandTransition(reduce)}
      className="ds-glass ds-glass--soft ds-hud-card ds-hud__ident"
    >
      <HudCorners />
      <div className="ds-hud-card__body">
        <div className="ds-hud__ident-row">
          <div className="ds-hud__ident-id">
            <div className="ds-hud__eyebrow">{data.typeLabel}</div>
            <h2 className="ds-hud__title">{data.title}</h2>
          </div>
          <StatusPill status={status ?? "idle"} />
          <Button iconOnly size="sm" variant="ghost" aria-label="Close" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </Button>
        </div>
      </div>
    </motion.div>
  );
}

/* ── CENTER overview (at rest): the summary + the REAL extra telemetry not shown
   elsewhere — phase, issues/warnings, context peak, timing. Replaced in-place by the
   region/file panel on hover/click. (Token cost is intentionally NOT shown — broken upstream.) ── */
function Overview({ rv, status, expected }: { rv: RunViewNode; status: NonNullable<FlowNodeData["status"]>; expected: number | null }) {
  const ctxPeak = rv.tokens?.contextPeak ?? 0;
  return (
    <div className="ds-hud__overview">
      {rv.summary
        ? <p className="ds-hud__summary">{rv.summary}</p>
        : <p className="ds-hud__summary ds-hud__summary--muted">No summary captured for this node.</p>}

      {rv.issues && rv.issues.length > 0 && (
        <div className="ds-hud__issues" role="status">
          {rv.issues.map((m, i) => (
            <div key={i} className="ds-hud__issue">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1.5l6.5 11.5h-13z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><path d="M8 6.5v3M8 11.2v.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
              <span>{m}</span>
            </div>
          ))}
        </div>
      )}

      <div className="ds-hud__facts">
        {rv.phase && <Fact k="Phase" v={rv.phase} />}
        <Fact k="Status" v={STATUS_LABEL[status]} />
        <Fact k="Duration" v={formatMs(rv.durationMs)} />
        {expected != null && <Fact k="Avg / prior" v={`${formatMs(expected)} · ${rv.priorSamples || 1} run${(rv.priorSamples || 1) === 1 ? "" : "s"}`} />}
        {ctxPeak > 0 && <Fact k="Context peak" v={`${ctxPeak.toLocaleString()} tok`} />}
      </div>

      <div className="ds-hud__hintline">Hover a panel, or click an input file.</div>
    </div>
  );
}

function Fact({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="ds-hud__fact">
      <span className="ds-hud__fact-k">{k}</span>
      <span className="ds-hud__fact-v">{v}</span>
    </div>
  );
}

/* ── a hoverable region box — hovering PINS its detail into the center (sticky) ──── */
function Region({ rk, area, label, active, onEnter, children, bare }: {
  rk: RegionKey; area?: string; label: string; active: boolean;
  onEnter: () => void; children: ReactNode; bare?: boolean;
}) {
  return (
    <section
      className={`ds-hud-region${active ? " is-active" : ""}${bare ? " ds-hud-region--bare" : ""}`}
      style={area ? { gridArea: area } : undefined}
      data-area={area}
      tabIndex={0}
      onMouseEnter={onEnter}
      onFocus={onEnter}
      aria-label={label}
    >
      {!bare && (
        <header className="ds-hud-region__label">
          <span>{label}</span>
          <span className="ds-hud-region__hint" aria-hidden="true">⤢</span>
        </header>
      )}
      <div className="ds-hud-region__body">{children}</div>
    </section>
  );
}

/* ── the in-place CENTER panel: a hairline header (back + title) over a scroll-hinted
   body. No card, no background — the content rides directly on the frosted scrim. ── */
function CenterPanel({ title, onBack, reduce, wide, children }: {
  title: string; onBack: () => void; reduce: boolean; wide?: boolean; children: ReactNode;
}) {
  return (
    <motion.div
      className={`ds-center${wide ? " ds-center--wide" : ""}`}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduce ? 0 : 0.16, ease: easing.standard }}
    >
      <div className="ds-center__head">
        <button type="button" className="ds-center__back" onClick={onBack} aria-label="Back to overview">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3 5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          back
        </button>
        <span className="ds-center__title" title={title}>{title}</span>
      </div>
      <ScrollHint>{children}</ScrollHint>
    </motion.div>
  );
}

/* ── a scroll region with NO scrollbar — a soft down-chevron cue appears while more
   content sits below (fades out at the bottom; click nudges the scroll). ──────────── */
function ScrollHint({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const measure = () => {
    const el = ref.current;
    if (el) setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 6);
  };
  // re-measure after every render (view/content change) and on viewport resize
  useEffect(() => { measure(); });
  useEffect(() => {
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const nudge = () => ref.current?.scrollBy({ top: ref.current.clientHeight * 0.8, behavior: "smooth" });
  return (
    <div className="ds-scrollhint">
      <div ref={ref} className="ds-scrollhint__scroll" onScroll={measure}>{children}</div>
      <button
        type="button"
        className={`ds-scrollhint__cue${more ? " is-show" : ""}`}
        aria-label="Scroll for more"
        tabIndex={more ? 0 : -1}
        onClick={nudge}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </button>
    </div>
  );
}

const DETAIL_TITLE: Record<RegionKey, string> = {
  model: "Model · tokens", tools: "Tool calls", output: "Output artifacts", progress: "Timeline",
};

/* ── the full-detail panels shown in the CENTER on hover ───────────────── */
function Detail({ region, rv, expected, pct, onOpenFile }: { region: RegionKey; rv: RunViewNode; expected: number | null; pct?: number; onOpenFile: (f: FileTarget) => void }) {
  if (region === "model") {
    const t = rv.tokens;
    return (
      <div className="ds-model-detail">
        <div className="ds-kv">
          <KV k="Model" v={rv.model ?? "—"} mono />
          <KV k="Provider" v={rv.provider ?? "—"} mono />
          <KV k="API" v={rv.api ?? "—"} mono />
          {t && <>
            <KV k="Input tokens" v={t.input.toLocaleString()} />
            <KV k="Output tokens" v={t.output.toLocaleString()} />
            <KV k="Cache read" v={t.cacheRead.toLocaleString()} />
            <KV k="Billable" v={t.billable.toLocaleString()} />
            <KV k="Context peak" v={t.contextPeak.toLocaleString()} />
          </>}
        </div>
        {t && <CacheDonut cacheRead={t.cacheRead} input={t.input} />}
      </div>
    );
  }

  if (region === "tools") {
    // ONE per-tool bar chart (sorted desc, count + %), NOT a pie — per the telemetry research
    // (docs/research/telemetry-observability-2026.md §4.1). The chips above are the signals that
    // actually matter for tool use: error rate (§3.5), provider retries (§3.8), truncation (§3.7),
    // single-tool dominance (§3.9). All derived from real fields.
    const bars = Object.entries(rv.toolBreakdown).sort((a, b) => b[1] - a[1]);
    const total = bars.reduce((s, [, c]) => s + c, 0) || rv.toolCalls || 1;
    const max = Math.max(1, ...bars.map(([, c]) => c));
    const errors = rv.timeline.filter((s) => !s.ok).length;
    const errRate = rv.toolCalls ? errors / rv.toolCalls : 0;
    const top = bars[0];
    const dominance = top ? top[1] / total : 0;
    return (
      <div className="ds-tools-detail">
        <div className="ds-tools-flags">
          <span className="ds-tools-total"><b>{rv.toolCalls}</b> calls · {bars.length} tool{bars.length === 1 ? "" : "s"}</span>
          {errors > 0 && (
            <span className="ds-flag" data-tone={errRate > 0.15 ? "error" : errRate > 0.05 ? "warn" : "muted"} title="failed tool-call spans / total calls">
              {errors} error{errors === 1 ? "" : "s"} · {Math.round(errRate * 100)}%
            </span>
          )}
          {rv.retries > 0 && (
            <span className="ds-flag" data-tone={rv.retries >= 5 ? "error" : "warn"} title="provider rate-limit / overload retries">
              {rv.retries} retr{rv.retries === 1 ? "y" : "ies"}
            </span>
          )}
          {rv.truncated && <span className="ds-flag" data-tone="error" title="output was cut off by the token cap">truncated</span>}
          {top && dominance > 0.8 && rv.toolCalls > 5 && (
            <span className="ds-flag" data-tone="warn" title="one tool dominates — possible stuck loop">{top[0]} {Math.round(dominance * 100)}%</span>
          )}
        </div>
        <div className="ds-bars">
          {bars.length === 0 && <div className="ds-hud-empty">no tool calls recorded</div>}
          {bars.map(([t, c]) => (
            <div key={t} className="ds-bar" data-tone={toolTone(t)}>
              <span className="ds-bar__label">{t}</span>
              <span className="ds-bar__track"><span className="ds-bar__fill" style={{ width: `${(c / max) * 100}%` }} /></span>
              <span className="ds-bar__val">{c}<span className="ds-bar__pct">{Math.round((c / total) * 100)}%</span></span>
            </div>
          ))}
        </div>
        {rv.bash.length > 0 && (
          <details className="ds-cmds" open={rv.bash.length <= 6}>
            <summary className="ds-cmds__head">bash · {rv.bash.length}</summary>
            <div className="ds-cmds__list">
              {rv.bash.slice(0, 24).map((b, i) => <code key={i} className="ds-cmd" title={b.command}>$ {b.command}</code>)}
            </div>
          </details>
        )}
      </div>
    );
  }

  if (region === "output") {
    return (
      <div className="ds-files">
        {rv.summary && <p className="ds-detail-prose">{rv.summary}</p>}
        {rv.artifacts.map((a) => (
          <button key={a.path} type="button" className="ds-out__row ds-out__row--lg ds-out__row--btn" data-ok={a.exists} onClick={() => onOpenFile(a)} title={a.displayPath}>
            <span className="ds-out__spark" aria-hidden="true" />
            <span className="ds-out__name">{a.displayPath}</span>
            <span className="ds-out__meta">{formatBytes(a.bytes)}{a.exists ? " ✓ verified" : " ✗ missing"}</span>
          </button>
        ))}
        {rv.writes.map((w) => (
          <button key={`w-${w.path}`} type="button" className="ds-out__row ds-out__row--lg ds-out__row--btn" data-ok={w.verified} onClick={() => onOpenFile(w)} title={w.displayPath}>
            <span className="ds-out__spark" aria-hidden="true" />
            <span className="ds-out__name">{w.displayPath}</span>
            <span className="ds-out__meta">{w.bytes != null ? formatBytes(w.bytes) : "wrote"}{w.verified ? " ✓" : ""}</span>
          </button>
        ))}
        {rv.artifacts.length === 0 && rv.writes.length === 0 && <div className="ds-hud-empty">no artifacts emitted</div>}
      </div>
    );
  }

  // progress — timestamped timeline of every tool call
  const total = Math.max(1, rv.durationMs ?? Math.max(...rv.timeline.map((s) => (s.tStartMs ?? 0) + s.durMs), 1));
  return (
    <div className="ds-timeline">
      <div className="ds-timeline__summary">
        <span><b>{Math.round((pct ?? 1) * 100)}%</b> · {formatMs(rv.durationMs)} elapsed</span>
        {expected != null && <span className="ds-timeline__exp">avg {formatMs(expected)} / {rv.priorSamples || 1} run{(rv.priorSamples || 1) === 1 ? "" : "s"}</span>}
      </div>
      <div className="ds-timeline__track" aria-hidden="true">
        {rv.timeline.map((s, i) => (
          <span
            key={i}
            className="ds-timeline__tick"
            data-tone={toolTone(s.name)}
            style={{ left: `${((s.tStartMs ?? 0) / total) * 100}%`, width: `${Math.max(0.4, (s.durMs / total) * 100)}%` }}
            title={`${s.name} · t+${formatMs(s.tStartMs ?? 0)} · ${formatMs(s.durMs)}`}
          />
        ))}
      </div>
      <div className="ds-timeline__list">
        {rv.timeline.map((s, i) => (
          <div key={i} className="ds-timeline__row" data-tone={toolTone(s.name)} data-ok={s.ok}>
            <span className="ds-timeline__t">t+{formatMs(s.tStartMs ?? 0)}</span>
            <span className="ds-timeline__name">{s.name}</span>
            <span className="ds-timeline__dur">{formatMs(s.durMs)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── a clicked file's REAL content, fetched from disk via the read-back endpoint and rendered BARE
   (no card/background): images as <img>, markdown parsed to themed nodes, everything else as mono text.
   Works for ANY path — input read, output, or artifact. A read's telemetry `preview` paints instantly
   while the full bytes load, and is the fallback if the fetch fails (e.g. the file was since removed). ── */
function FileView({ run, file }: { run: string; file: FileTarget }) {
  const src = fileUrl(run, file.path);
  const isImage = isImagePath(file.displayPath);
  const [state, setState] = useState<{ status: "loading" | "ok" | "error"; text?: string; error?: string }>({ status: "loading" });

  useEffect(() => {
    if (isImage) return; // images load through <img>, no text fetch
    let alive = true;
    setState({ status: "loading" });
    fetch(src)
      .then(async (r) => { if (!r.ok) throw new Error(`${r.status} ${r.statusText}`); return r.text(); })
      .then((text) => { if (alive) setState({ status: "ok", text }); })
      .catch((e) => { if (alive) setState({ status: "error", error: String(e?.message ?? e) }); });
    return () => { alive = false; };
  }, [src, isImage]);

  if (isImage) return <div className="ds-fileimg"><img src={src} alt={file.displayPath} loading="lazy" /></div>;
  if (state.status === "loading")
    return file.preview ? renderFileText(file.displayPath, file.preview) : <div className="ds-hud-empty">loading {file.displayPath}…</div>;
  if (state.status === "error")
    return file.preview ? renderFileText(file.displayPath, file.preview) : <div className="ds-hud-empty">couldn’t read {file.displayPath} — {state.error}</div>;
  return renderFileText(file.displayPath, state.text ?? "");
}

// markdown → themed reader; anything else → plain mono. Shared by the live fetch + the preview fallback.
function renderFileText(displayPath: string, text: string) {
  const ext = (displayPath.split(".").pop() || "").toLowerCase();
  if (ext === "md" || ext === "markdown") return <MarkdownReader source={text} />;
  if (ext === "json") return <JsonReader source={text} />;
  return <pre className="ds-codeblock">{text}</pre>;
}

function KV({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div className="ds-kv__row">
      <span className="ds-kv__k">{k}</span>
      <span className={`ds-kv__v${mono ? " ds-kv__v--mono" : ""}`}>{v}</span>
    </div>
  );
}

function ScopeGlyph({ kind }: { kind: ScopeKind }) {
  // run = a filesystem/folder hint; everything else = a tag hint
  if (kind === "run") {
    return (
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="ds-scope__glyph">
        <path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.2 1.5h5A1.5 1.5 0 0 1 14 6v5.5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="ds-scope__glyph">
      <path d="M7.5 2.5 13 8l-5 5-5.5-5.5V2.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <circle cx="5.3" cy="5.3" r="0.9" fill="currentColor" />
    </svg>
  );
}
