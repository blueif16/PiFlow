/**
 * NodeHud — the "clicked-up" view, rebuilt as a 5-REGION HUD around the node.
 *
 *      ┌─────────────── TOP ───────────────┐   model/provider · tool-call summary
 *      │ LEFT │       MIDDLE        │ RIGHT │   inputs/scope · identity · output
 *      └─────────────── BOTTOM ────────────┘   progress (avg-of-prior-runs ETA)
 *
 * MIDDLE is the morph target: the canvas node grows into the identity card here
 * (shared layoutId). HOVER any region and it expands into MIDDLE, showing the full
 * detail — the whole file for an input, the tool bar-chart for the summary, the
 * timestamped timeline for progress. A short grace timer bridges the gap so you can
 * move the cursor INTO the detail to read/scroll it.
 *
 * Every value is real (data.rv = the distilled run-view node). Nothing is mocked;
 * a region with no backing data renders empty.
 */
import { useRef, useState, type ReactNode, type Ref } from "react";
import { AnimatePresence } from "motion/react";
import * as motion from "motion/react-client";
import { Button } from "./Button";
import { ProgressBar } from "./ProgressBar";
import { StatusPill, HudCorners } from "./HudBits";
import { expandTransition, easing } from "../motion/transitions";
import type { FlowNodeData } from "./WorkflowNode";
import { formatMs, formatBytes, type RunViewNode, type ScopeKind } from "../data/runView";
import "../styles/hud.css";

type RegionKey = "model" | "tools" | "files" | "output" | "progress";
const REGION_KEYS: readonly RegionKey[] = ["model", "tools", "files", "output", "progress"];

// Deep-link a region open via `?peek=<region>` (also how the hover-expand is verified/screenshotted).
const initialPeek: RegionKey | null =
  typeof window !== "undefined"
    ? (REGION_KEYS as readonly string[]).includes(new URLSearchParams(window.location.search).get("peek") ?? "")
      ? (new URLSearchParams(window.location.search).get("peek") as RegionKey)
      : null
    : null;

const SCOPE_META: Record<ScopeKind, { label: string; hint: string }> = {
  run: { label: "Run workspace", hint: "filesystem" },
  skill: { label: "Skill", hint: "loaded skill" },
  template: { label: "Templates", hint: "shared" },
  package: { label: "Packages", hint: "repo" },
  repo: { label: "Repo source", hint: "repo" },
};

// tool → accent class (read=accent, write/edit=success, others neutral) for the bar chart + tags
const TOOL_TONE: Record<string, string> = {
  read: "accent", grep: "accent", ls: "muted", find: "muted",
  edit: "success", write: "success", bash: "warn", submit_result: "accent",
};
const toolTone = (t: string) => TOOL_TONE[t] ?? "muted";

const fileName = (p: string) => p.split("/").pop() || p;

export interface NodeHudProps {
  id: string;
  data: FlowNodeData;
  onClose: () => void;
  reduce: boolean;
  dialogRef: Ref<HTMLDivElement>;
}

export function NodeHud({ id, data, onClose, reduce, dialogRef }: NodeHudProps) {
  const rv = data.rv;
  const status = data.status ?? "idle";
  // focus drives which region is expanded into MIDDLE. Hover sets it; `?peek=<region>` deep-links it.
  const [focus, setFocus] = useState<RegionKey | null>(initialPeek);
  const clearTimer = useRef<number | undefined>(undefined);

  // hover bridge: keep a region open while the cursor travels from it into the MIDDLE detail
  const hold = (k: RegionKey) => { window.clearTimeout(clearTimer.current); setFocus(k); };
  const release = () => { window.clearTimeout(clearTimer.current); clearTimer.current = window.setTimeout(() => setFocus(null), 160); };

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
  const maxCount = Math.max(1, ...breakdown.map(([, c]) => c));

  return (
    <div
      className="ds-hud"
      role="dialog"
      aria-modal="true"
      aria-label={`${data.title} details`}
      tabIndex={-1}
      ref={dialogRef}
      onMouseLeave={release}
    >
      {/* ── TOP: two containers — model/provider · tool-call summary ───────── */}
      <div className="ds-hud__top">
        <Region rk="model" label="Model" focus={focus} hold={hold} release={release}>
          <div className="ds-hud-stat">
            <span className="ds-hud-stat__v">{rv.model ?? "—"}</span>
            <span className="ds-hud-stat__k">{rv.provider ?? "provider"}{rv.api ? ` · ${rv.api}` : ""}</span>
          </div>
        </Region>
        <Region rk="tools" label="Tool calls" focus={focus} hold={hold} release={release}>
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

      {/* ── LEFT: input files, bucketed by scope ──────────────────────────── */}
      <Region rk="files" area="left" label={`Inputs · ${rv.reads.length} files`} focus={focus} hold={hold} release={release}>
        <div className="ds-scopes">
          {rv.scopes.length === 0 && <div className="ds-hud-empty">no reads recorded</div>}
          {rv.scopes.map((s) => (
            <div key={s.kind} className="ds-scope" data-scope={s.kind}>
              <div className="ds-scope__head">
                <ScopeGlyph kind={s.kind} />
                <span className="ds-scope__label">{SCOPE_META[s.kind]?.label ?? s.label}</span>
                <span className="ds-scope__count">{s.count}</span>
              </div>
              <div className="ds-scope__files">
                {s.paths.slice(0, 4).map((p) => <span key={p} className="ds-chip" title={p}>{fileName(p)}</span>)}
                {s.paths.length > 4 && <span className="ds-chip ds-chip--more">+{s.paths.length - 4}</span>}
              </div>
            </div>
          ))}
        </div>
      </Region>

      {/* ── MIDDLE: identity (morph) + the hover-expanded detail overlay ───── */}
      <div className="ds-hud__mid" style={{ gridArea: "mid" }}>
        <Identity id={id} data={data} reduce={reduce} onClose={onClose} status={status} />
        <AnimatePresence>
          {focus && (
            <motion.div
              key={focus}
              className="ds-hud-detail ds-glass ds-glass--soft"
              initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.985 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.99 }}
              transition={{ duration: reduce ? 0 : 0.16, ease: easing.standard }}
              onMouseEnter={() => hold(focus)}
              onMouseLeave={release}
            >
              <HudCorners />
              <div className="ds-hud-detail__head">{DETAIL_TITLE[focus]}</div>
              <div className="ds-hud-detail__body">
                <Detail region={focus} rv={rv} expected={expected} pct={pct} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ── RIGHT: output panel (distinct, "emitted" feel) ────────────────── */}
      <Region rk="output" area="right" label={`Output · ${rv.artifacts.length || rv.writes.length}`} focus={focus} hold={hold} release={release}>
        <div className="ds-out">
          {rv.artifacts.length === 0 && rv.writes.length === 0 && <div className="ds-hud-empty">no artifacts</div>}
          {rv.artifacts.map((a) => (
            <div key={a.path} className="ds-out__row" data-ok={a.exists}>
              <span className="ds-out__spark" aria-hidden="true" />
              <span className="ds-out__name" title={a.displayPath}>{fileName(a.displayPath)}</span>
              <span className="ds-out__meta">{formatBytes(a.bytes)}{a.exists ? " ✓" : " ✗"}</span>
            </div>
          ))}
          {rv.writes.filter((w) => !rv.artifacts.some((a) => a.displayPath === w.displayPath)).map((w) => (
            <div key={w.path} className="ds-out__row" data-ok={w.verified}>
              <span className="ds-out__spark" aria-hidden="true" />
              <span className="ds-out__name" title={w.displayPath}>{fileName(w.displayPath)}</span>
              <span className="ds-out__meta">{w.bytes != null ? formatBytes(w.bytes) : "wrote"}</span>
            </div>
          ))}
        </div>
      </Region>

      {/* ── BOTTOM: progress + avg-of-prior-runs ETA ──────────────────────── */}
      <Region rk="progress" area="bottom" label="Progress" focus={focus} hold={hold} release={release}>
        <div className="ds-prog">
          <ProgressBar size="block" value={pct} status={status} aria-label={`${data.title} progress`} />
          <span className="ds-prog__pct">{pct != null ? `${Math.round(pct * 100)}%` : "···"}</span>
          <span className="ds-prog__meta">
            took <b>{formatMs(rv.durationMs)}</b>
            {expected != null && (
              <> · avg <b>{formatMs(expected)}</b> over {rv.priorSamples || 1} run{(rv.priorSamples || 1) === 1 ? "" : "s"}</>
            )}
          </span>
        </div>
      </Region>
    </div>
  );
}

/* ── the identity card (morph target) ──────────────────────────────────── */
function Identity({ id, data, reduce, onClose, status }: { id: string; data: FlowNodeData; reduce: boolean; onClose: () => void; status: FlowNodeData["status"] }) {
  const rv = data.rv;
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
        {rv?.summary && <p className="ds-hud__summary">{rv.summary}</p>}
        <div className="ds-hud__hintline">Hover a panel for full detail.</div>
      </div>
    </motion.div>
  );
}

/* ── a hoverable region box ─────────────────────────────────────────────── */
function Region({ rk, area, label, focus, hold, release, children }: {
  rk: RegionKey; area?: string; label: string; focus: RegionKey | null;
  hold: (k: RegionKey) => void; release: () => void; children: ReactNode;
}) {
  return (
    <section
      className={`ds-hud-region${focus === rk ? " is-active" : ""}`}
      style={area ? { gridArea: area } : undefined}
      tabIndex={0}
      onMouseEnter={() => hold(rk)}
      onMouseLeave={release}
      onFocus={() => hold(rk)}
      onBlur={release}
      aria-label={label}
    >
      <header className="ds-hud-region__label">
        <span>{label}</span>
        <span className="ds-hud-region__hint" aria-hidden="true">⤢</span>
      </header>
      <div className="ds-hud-region__body">{children}</div>
    </section>
  );
}

const DETAIL_TITLE: Record<RegionKey, string> = {
  model: "Model · tokens", tools: "Tool calls", files: "Input files", output: "Output artifacts", progress: "Timeline",
};

/* ── the full-detail panels shown in MIDDLE on hover ───────────────────── */
function Detail({ region, rv, expected, pct }: { region: RegionKey; rv: RunViewNode; expected: number | null; pct?: number }) {
  if (region === "model") {
    const t = rv.tokens;
    return (
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
    );
  }

  if (region === "tools") {
    const bars = Object.entries(rv.toolBreakdown).sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...bars.map(([, c]) => c));
    return (
      <div className="ds-detail-cols">
        <div className="ds-bars">
          {bars.map(([t, c]) => (
            <div key={t} className="ds-bar" data-tone={toolTone(t)}>
              <span className="ds-bar__label">{t}</span>
              <span className="ds-bar__track"><span className="ds-bar__fill" style={{ width: `${(c / max) * 100}%` }} /></span>
              <span className="ds-bar__val">{c}</span>
            </div>
          ))}
        </div>
        {rv.bash.length > 0 && (
          <div className="ds-cmds">
            <div className="ds-cmds__head">bash · {rv.bash.length}</div>
            {rv.bash.slice(0, 24).map((b, i) => <code key={i} className="ds-cmd" title={b.command}>$ {b.command}</code>)}
          </div>
        )}
      </div>
    );
  }

  if (region === "files") {
    return (
      <div className="ds-files">
        {rv.reads.map((r) => (
          <details key={r.path} className="ds-file" data-scope={r.scope} open={rv.reads.length <= 3}>
            <summary className="ds-file__sum">
              <ScopeGlyph kind={r.scope} />
              <span className="ds-file__path" title={r.path}>{r.displayPath}</span>
              <span className="ds-file__via">{r.via}</span>
            </summary>
            {r.preview ? <pre className="ds-file__preview">{r.preview}</pre> : <div className="ds-hud-empty">content not captured</div>}
          </details>
        ))}
      </div>
    );
  }

  if (region === "output") {
    return (
      <div className="ds-files">
        {rv.summary && <p className="ds-detail-prose">{rv.summary}</p>}
        {rv.artifacts.map((a) => (
          <div key={a.path} className="ds-out__row ds-out__row--lg" data-ok={a.exists}>
            <span className="ds-out__spark" aria-hidden="true" />
            <span className="ds-out__name" title={a.displayPath}>{a.displayPath}</span>
            <span className="ds-out__meta">{formatBytes(a.bytes)}{a.exists ? " ✓ verified" : " ✗ missing"}</span>
          </div>
        ))}
        {rv.writes.map((w) => (
          <div key={`w-${w.path}`} className="ds-out__row ds-out__row--lg" data-ok={w.verified}>
            <span className="ds-out__spark" aria-hidden="true" />
            <span className="ds-out__name" title={w.displayPath}>{w.displayPath}</span>
            <span className="ds-out__meta">{w.bytes != null ? formatBytes(w.bytes) : "wrote"}{w.verified ? " ✓" : ""}</span>
          </div>
        ))}
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
          <div key={i} className="ds-timeline__row" data-tone={toolTone(s.name)}>
            <span className="ds-timeline__t">t+{formatMs(s.tStartMs ?? 0)}</span>
            <span className="ds-timeline__name">{s.name}</span>
            <span className="ds-timeline__dur">{formatMs(s.durMs)}</span>
          </div>
        ))}
      </div>
    </div>
  );
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
