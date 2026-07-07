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
import { FileView, type FileTarget } from "./FileContent";
import { CacheDonut } from "./CacheDonut";
import { NodeHooks } from "./NodeGates";
import { useSkill } from "./SkillContext";
import { IssueCountCluster, IssueRow, IssueContent } from "./IssueBits";
import { loadNodeIssues, sortIssues, issueCounts, type IssueRecord } from "../data/nodeIssues";
import { expandTransition, easing } from "../motion/transitions";
import type { FlowNodeData } from "./WorkflowNode";
import { formatMs, formatBytes, formatTokens, type RunViewNode, type ScopeKind, type Tone } from "../data/runView";
import "../styles/hud.css";
import "../styles/reader.css";

type RegionKey = "model" | "tools" | "output" | "progress";
const REGION_KEYS: readonly RegionKey[] = ["model", "tools", "output", "progress"];

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

// tool → accent class + the shared tool-icon vocabulary live in one module (toolMeta) so every surface
// (this HUD, the ToolStackBar legend, the agent-definition tool row) tints + icons tools identically.
// Imported for local use AND re-exported for the existing importers (ToolStackBar).
import { TOOL_TONE, toolTone, ToolTag } from "./toolMeta";
export { TOOL_TONE, toolTone };

// Tone → the flag's CSS data-tone vocabulary. A pure VIEW mapping: the attention level is computed in the
// observe surface (node.derived.*); here we only pick the class the HUD styles (high→error, warn→warn, ok→muted).
const toneToFlag = (t: Tone): "error" | "warn" | "muted" => (t === "high" ? "error" : t === "warn" ? "warn" : "muted");

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
  /** when the run-level issues card jumps here, the issue to open in issues-mode (node id + issue id). */
  focusIssue?: { node: string; issueId: string } | null;
}

export function NodeHud({ id, data, run, onClose, reduce, dialogRef, focusIssue }: NodeHudProps) {
  const rv = data.rv;
  const status = data.status ?? "idle";
  // the single CENTER state: a hovered region (sticky), a clicked file, or null (Overview)
  const [view, setView] = useState<CenterView>(initialView);
  const pin = (region: RegionKey) => setView({ kind: "region", region });
  const openFile = (f: FileTarget) => setView({ kind: "file", file: { path: f.path, displayPath: f.displayPath, preview: f.preview } });
  const reset = () => setView(null);

  // (M8) issues-mode: the identity count-cluster toggles the HUD into an in-place issue browser — the LEFT
  // column becomes this node's issue list, the CENTER renders the selected issue's content. Node-TYPE-scoped
  // (the ledger is run-agnostic); this component is remounted per node (key=id) so the state starts fresh.
  const focusHere = focusIssue?.node === id;
  const [issues, setIssues] = useState<IssueRecord[] | null>(null);
  const [issuesMode, setIssuesMode] = useState<boolean>(!!focusHere);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(focusHere ? focusIssue!.issueId : null);
  useEffect(() => {
    let alive = true;
    loadNodeIssues(run, id).then((r) => { if (alive) setIssues(r); }).catch(() => { if (alive) setIssues([]); });
    return () => { alive = false; };
  }, [run, id]);
  // a run-level jump for the SAME already-open node (no remount) still opens issues-mode on that issue.
  useEffect(() => {
    if (focusHere) { setIssuesMode(true); setSelectedIssueId(focusIssue!.issueId); }
  }, [focusHere, focusIssue]);
  const sortedIssues = issues ? sortIssues(issues) : [];
  const counts = issueCounts(issues ?? []);
  const hasIssues = counts.open + counts.closed > 0;
  const selectedIssue = sortedIssues.find((r) => r.issue.id === selectedIssueId) ?? sortedIssues[0] ?? null;
  const enterIssues = () => { setIssuesMode(true); setSelectedIssueId((cur) => cur ?? sortedIssues[0]?.issue.id ?? null); };

  // apply the ?file=<idx> deep-link once (rv-dependent, so it can't be in the module-level initialView).
  useEffect(() => {
    if (initialFile != null && rv?.reads[initialFile]) openFile(rv.reads[initialFile]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live elapsed clock: a RUNNING node has no final durationMs yet, so tick once a second and render
  // elapsed-so-far (now − startedAt). A finished node carries durationMs and needs no clock.
  const running = status === "running";
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  // progress: a completed node is 100%; the ETA is the mean of prior runs (rv.expectedMs)
  const done = status === "success" || status === "error";
  const pct = data.progress != null ? data.progress : done ? 1 : undefined;
  const expected = rv?.expectedMs ?? rv?.durationMs ?? null;
  // elapsed = the node's final durationMs, or — while it's still running — the live now−startedAt, so the
  // HUD always shows how long the node has been going even before it finishes and with no prior-run average.
  const startedMs = rv?.startedAt ? Date.parse(rv.startedAt) : NaN;
  const elapsedMs = rv?.durationMs ?? (Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : null);

  if (!rv) {
    // graceful fallback if a node has no run-view payload (shouldn't happen with real data)
    return (
      <div className="ds-hud" role="dialog" aria-modal="true" aria-label={`${data.title} details`} tabIndex={-1} ref={dialogRef}>
        <Identity id={id} data={data} reduce={reduce} onClose={onClose} status={status} />
      </div>
    );
  }

  // the ranked tool list is derived once in the observe surface (node.derived.topTools) — render it, don't re-sort.
  const topTools = rv.derived?.topTools ?? [];

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
      <Identity
        id={id} data={data} reduce={reduce} onClose={onClose} status={status}
        counts={counts}
        issuesActive={issuesMode}
        onToggleIssues={hasIssues ? () => (issuesMode ? setIssuesMode(false) : enterIssues()) : undefined}
      />

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
              {topTools.map((b) => (
                <ToolTag
                  key={b.name}
                  name={b.name}
                  count={b.count}
                  errors={b.errors}
                  onClick={() => pin("tools")}
                  title={b.errors ? `${b.name} · ${b.count} calls · ${b.errors} rejected` : `${b.name} · ${b.count} calls`}
                />
              ))}
            </span>
          </div>
        </Region>
      </div>

      {/* ── LEFT: input SOURCES — OR, in issues-mode, this node's issue list (replaces the files). ── */}
      <div className="ds-hud__left" style={{ gridArea: "left" }}>
        {issuesMode ? (
          <div className="ds-hud-issues">
            <div className="ds-hud-issues__head">
              <span className="ds-hud-issues__title">Issues · {sortedIssues.length}</span>
              <IssueCountCluster open={counts.open} closed={counts.closed} compact />
            </div>
            {sortedIssues.length === 0 && <div className="ds-hud-empty">no issues recorded</div>}
            <div className="ds-hud-issues__list">
              {sortedIssues.map((rec) => (
                <IssueRow
                  key={rec.issue.id}
                  record={rec}
                  activeRun={run}
                  selected={selectedIssue?.issue.id === rec.issue.id}
                  onClick={() => setSelectedIssueId(rec.issue.id)}
                />
              ))}
            </div>
          </div>
        ) : (
          <>
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
          </>
        )}
      </div>

      {/* ── CENTER: one in-place surface — Overview at rest, REPLACED by a region detail (hover,
           sticky) or a file's parsed content (click). Click the gutter/background to return. ── */}
      <div
        className="ds-hud__mid"
        style={{ gridArea: "mid" }}
        onClick={(e) => { if (e.target === e.currentTarget) reset(); }}
      >
        {issuesMode ? (
          selectedIssue ? (
            <CenterPanel key={`issue-${selectedIssue.issue.id}`} title={selectedIssue.issue.title} onBack={() => setIssuesMode(false)} reduce={reduce} wide>
              <IssueContent record={selectedIssue} />
            </CenterPanel>
          ) : (
            <div className="ds-hud-empty">No issues recorded for this node.</div>
          )
        ) : (
          <>
            {view === null && <Overview rv={rv} data={data} status={status} expected={expected} elapsedMs={elapsedMs} onPinTools={() => pin("tools")} />}
            {pinnedRegion && (
              <CenterPanel key={`r-${pinnedRegion}`} title={DETAIL_TITLE[pinnedRegion]} onBack={reset} reduce={reduce}>
                <Detail region={pinnedRegion} rv={rv} expected={expected} elapsedMs={elapsedMs} pct={pct} onOpenFile={openFile} />
              </CenterPanel>
            )}
            {view?.kind === "file" && (
              <CenterPanel key={`f-${view.file.path}`} title={view.file.displayPath} onBack={reset} reduce={reduce} wide>
                <FileView run={run} file={view.file} />
              </CenterPanel>
            )}
          </>
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
            <b>{formatMs(elapsedMs)}</b> elapsed{expected != null ? ` · avg ${formatMs(expected)} / ${rv.priorSamples || 1} run${(rv.priorSamples || 1) === 1 ? "" : "s"}` : ""}
          </div>
        </div>
      </Region>
    </div>
  );
}

/* ── the identity card (morph target), now pinned TOP-LEFT — compact chrome ── */
function Identity({ id, data, reduce, onClose, status, counts, issuesActive, onToggleIssues }: {
  id: string; data: FlowNodeData; reduce: boolean; onClose: () => void; status: FlowNodeData["status"];
  counts?: { open: number; closed: number }; issuesActive?: boolean; onToggleIssues?: () => void;
}) {
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
          {/* (M8) node-TYPE issue counts — click to toggle the in-place issue browser (issues-mode). Only
              shown when the node has issues; the ledger is run-agnostic (current status of all issues). */}
          {onToggleIssues && counts && (
            <button
              type="button"
              className={`ds-issue-countbtn${issuesActive ? " is-active" : ""}`}
              aria-pressed={issuesActive}
              aria-label={`Issues: ${counts.open} open, ${counts.closed} closed — toggle browser`}
              title="Issues for this node — open the in-place browser"
              onClick={onToggleIssues}
            >
              <IssueCountCluster open={counts.open} closed={counts.closed} compact />
            </button>
          )}
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
   elsewhere — phase, issues/warnings, context peak, tokens/cost, timing. Replaced in-place by the
   region/file panel on hover/click. Tokens/cost render only when non-zero: legacy Claude replay is
   fixed upstream (driver-sniffed accumulator), and a subscription-flat executor's honest cost IS 0 —
   a "$0.00" row would read as broken, so zero stays silent. ── */
function Overview({ rv, data, status, expected, elapsedMs, onPinTools }: { rv: RunViewNode; data: FlowNodeData; status: NonNullable<FlowNodeData["status"]>; expected: number | null; elapsedMs: number | null; onPinTools: () => void }) {
  const ctxPeak = rv.tokens?.contextPeak ?? 0;
  const tokIn = rv.tokens?.input ?? 0;
  const tokOut = rv.tokens?.output ?? 0;
  const cost = rv.tokens?.cost ?? 0;
  const running = status === "running";
  const loop = loopSignal(rv);
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

      {/* The agent DEFINITION, surfaced in the resting default view (no longer hover-only): the loadout
          (skill · tools · read/write scope · carries) + the role prompt — the "associated context" at a
          glance. Tools are clickable → the per-tool telemetry breakdown. */}
      <AgentDefinition rv={rv} data={data} onPinTools={onPinTools} />

      <div className="ds-hud__facts">
        {rv.phase && <Fact k="Phase" v={rv.phase} />}
        <Fact k="Status" v={STATUS_LABEL[status]} />
        <Fact k={running ? "Elapsed" : "Duration"} v={formatMs(elapsedMs)} />
        {expected != null && <Fact k="Avg / prior" v={`${formatMs(expected)} · ${rv.priorSamples || 1} run${(rv.priorSamples || 1) === 1 ? "" : "s"}`} />}
        <Fact k="Tool calls" v={rv.modelCalls != null ? `${rv.toolCalls} · ${rv.modelCalls} model call${rv.modelCalls === 1 ? "" : "s"}` : String(rv.toolCalls)} />
        {ctxPeak > 0 && <Fact k="Context peak" v={`${ctxPeak.toLocaleString()} tok`} />}
        {(tokIn > 0 || tokOut > 0) && <Fact k="Tokens" v={`${formatTokens(tokIn)} in · ${formatTokens(tokOut)} out`} />}
        {cost > 0 && <Fact k="Cost" v={rv.expectedCost != null && rv.expectedCost > 0 ? `$${cost.toFixed(cost < 1 ? 3 : 2)} · avg $${rv.expectedCost.toFixed(rv.expectedCost < 1 ? 3 : 2)}` : `$${cost.toFixed(cost < 1 ? 3 : 2)}`} />}
        {rv.stopReason && <Fact k="Finish" v={rv.stopReason} />}
        {loop && <Fact k="Loop" v={<span className="ds-fact-flag" data-tone={loop.tone}>{loop.label}</span>} />}
      </div>

      {/* (POLICY channel) "Hooks" — the node's authored gate lane + policy + checkpoint in plain-language
          pre / post / human lanes, projected from observe (config.gates). One honest rendering from config. */}
      <NodeHooks gates={rv.config?.gates} />

      <div className="ds-hud__hintline">Hover a panel, click a tool tag, or open an input file.</div>
    </div>
  );
}

/** A stuck-loop signal from the cross-run loop metrics core ships: the longest CONSECUTIVE near-identical
 *  run (`loopScore`) and the peak identical-args repeat (`maxToolRepeat` on `repeatedTool`). Returns a
 *  toned label, or null when neither trips (loopScore ≥3 or maxToolRepeat ≥3 = a probable stuck loop). */
function loopSignal(rv: RunViewNode): { label: string; tone: "warn" | "high" } | null {
  const loopScore = rv.loopScore ?? 0;
  const maxRepeat = rv.maxToolRepeat ?? 0;
  if (loopScore < 3 && maxRepeat < 3) return null;
  const tone = loopScore >= 3 || maxRepeat >= 5 ? "high" : "warn";
  const label = rv.repeatedTool
    ? `${rv.repeatedTool} ×${Math.max(maxRepeat, loopScore)}`
    : `×${Math.max(maxRepeat, loopScore)} repeats`;
  return { label, tone };
}

/** The agent's DEFINITION block for the resting Overview: skill (chip) · tools (clickable ToolTags) ·
 *  read/write scope · carries (model·tier·executor) · role prompt. An honest projection of the recorded
 *  loadout (`rv.config`) with the preset as fallback — the SAME sources the AgentHoverCard reads, promoted
 *  from hover into the default view. Renders nothing when a node carries no loadout at all. */
function AgentDefinition({ rv, data, onPinTools }: { rv: RunViewNode; data: FlowNodeData; onPinTools: () => void }) {
  const { openSkill } = useSkill();
  const preset = data.agentPreset;
  const skill = rv.config?.skill ?? preset?.skills?.[0];
  const tools = rv.config?.tools?.allow ?? preset?.tools?.allow ?? [];
  const deny = rv.config?.tools?.deny ?? preset?.tools?.deny ?? [];
  const readScope = rv.config?.sandbox?.readScope ?? [];
  const owns = rv.config?.sandbox?.owns ?? [];
  const prompt = preset?.prompt;
  const carries = [rv.model ?? rv.config?.model ?? preset?.model, rv.config?.tier ?? preset?.tier, rv.executor ?? "pi"]
    .filter(Boolean).join(" · ");
  const nothing = !skill && tools.length === 0 && !prompt && readScope.length === 0 && owns.length === 0 && !carries;
  if (nothing) return null;
  return (
    <div className="ds-hud__agentdef">
      {skill && (
        <div className="ds-hud__defrow">
          <span className="ds-hud__defkey">skill</span>
          <button type="button" className="ds-chip ds-chip--skill ds-chip--btn" title={`${skill} — open skill bundle`} onClick={() => openSkill(skill)}>
            {skillName(skill)}
          </button>
        </div>
      )}
      {tools.length > 0 && (
        <div className="ds-hud__defrow">
          <span className="ds-hud__defkey">tools</span>
          <span className="ds-hud__deftags">
            {tools.map((t) => (
              <ToolTag key={t} name={t} onClick={onPinTools} title={`${t} — see tool-call breakdown`} />
            ))}
            {deny.map((t) => <ToolTag key={`deny-${t}`} name={t} title={`${t} — denied`} className="ds-tooltag--deny" />)}
          </span>
        </div>
      )}
      {(readScope.length > 0 || owns.length > 0) && (
        <div className="ds-hud__defrow">
          <span className="ds-hud__defkey">scope</span>
          <span className="ds-hud__deftags">
            {readScope.map((p) => <span key={`r-${p}`} className="ds-chip" title={`reads ${p}`}>{scopeTag(p)}</span>)}
            {owns.map((p) => <span key={`o-${p}`} className="ds-chip ds-chip--owns" title={`owns ${p}`}>{scopeTag(p)}</span>)}
          </span>
        </div>
      )}
      {carries && (
        <div className="ds-hud__defrow">
          <span className="ds-hud__defkey">carries</span>
          <span className="ds-hud__defval">{carries}</span>
        </div>
      )}
      {prompt && (
        <div className="ds-hud__prompt">
          <span className="ds-hud__defkey">role prompt</span>
          <pre className="ds-hud__prompttext">{prompt}</pre>
        </div>
      )}
    </div>
  );
}

/** `…/harden-blueprint/SKILL.md` → `harden-blueprint`; a bare id passes through. */
function skillName(p: string): string {
  const parts = p.replace(/\/SKILL\.md$/i, "").split("/");
  return parts[parts.length - 1] || p;
}
/** Shorten a scope path for a tag: keep tokens (`{{RUN}}`)/globs as-is, else the last 2 segments. */
function scopeTag(p: string): string {
  if (p.startsWith("{{")) return p;
  const parts = p.split("/").filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join("/") : p;
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
function Detail({ region, rv, expected, elapsedMs, pct, onOpenFile }: { region: RegionKey; rv: RunViewNode; expected: number | null; elapsedMs: number | null; pct?: number; onOpenFile: (f: FileTarget) => void }) {
  if (region === "model") {
    const t = rv.tokens;
    return (
      <div className="ds-model-detail">
        <div className="ds-kv">
          <KV k="Model" v={rv.model ?? "—"} mono />
          <KV k="Provider" v={rv.provider ?? "—"} mono />
          <KV k="API" v={rv.api ?? "—"} mono />
          {rv.contextWindow != null && <KV k="Context window" v={rv.contextWindow.toLocaleString()} />}
          {t && <>
            <KV k="Input tokens" v={t.input.toLocaleString()} />
            <KV k="Output tokens" v={t.output.toLocaleString()} />
            <KV k="Cache read" v={t.cacheRead.toLocaleString()} />
            <KV k="Cache write" v={t.cacheWrite.toLocaleString()} />
            <KV k="Billable" v={t.billable.toLocaleString()} />
            <KV k="Context peak" v={t.contextPeak.toLocaleString()} />
            {t.cost > 0 && <KV k="Cost" v={`$${t.cost.toFixed(t.cost < 1 ? 3 : 2)}`} />}
          </>}
          {rv.modelCalls != null && <KV k="Model calls" v={String(rv.modelCalls)} />}
          {rv.thinkingChars > 0 && <KV k="Thinking" v={`${rv.thinkingChars.toLocaleString()} chars`} />}
        </div>
        {rv.derived?.cacheHit && <CacheDonut hit={rv.derived.cacheHit} />}
      </div>
    );
  }

  if (region === "tools") {
    // ONE per-tool bar chart (sorted desc, count + %), NOT a pie — per the telemetry research
    // (docs/research/telemetry-observability-2026.md §4.1). The chips above are the signals that
    // actually matter for tool use: error rate (§3.5), provider retries (§3.8), truncation (§3.7),
    // single-tool dominance (§3.9). All derived from real fields.
    // Every signal here is derived ONCE in the observe surface (node.derived) — the HUD renders it, and
    // re-derives no threshold: error rate (§3.5), provider retries (§3.8), truncation (§3.7), single-tool
    // dominance (§3.9), and the ranked per-tool bars (§4.1, count + share).
    const d = rv.derived;
    const bars = d?.topTools ?? [];
    const max = Math.max(1, ...bars.map((b) => b.count));
    const loop = loopSignal(rv);
    return (
      <div className="ds-tools-detail">
        <div className="ds-tools-flags">
          <span className="ds-tools-total"><b>{rv.toolCalls}</b> calls · {rv.modelCalls != null ? `${rv.modelCalls} model · ` : ""}{bars.length} tool{bars.length === 1 ? "" : "s"}</span>
          {loop && (
            <span className="ds-flag" data-tone={loop.tone === "high" ? "error" : "warn"} title="repeated near-identical tool calls — possible stuck loop">
              loop · {loop.label}
            </span>
          )}
          {d && d.toolError.errors > 0 && (
            <span className="ds-flag" data-tone={toneToFlag(d.toolError.tone)} title="failed tool-call spans / total calls">
              {d.toolError.errors} error{d.toolError.errors === 1 ? "" : "s"} · {Math.round(d.toolError.rate * 100)}%
            </span>
          )}
          {d && d.retries.count > 0 && (
            <span className="ds-flag" data-tone={toneToFlag(d.retries.tone)} title="provider rate-limit / overload retries">
              {d.retries.count} retr{d.retries.count === 1 ? "y" : "ies"}
            </span>
          )}
          {rv.truncated && <span className="ds-flag" data-tone="error" title="output was cut off by the token cap">truncated</span>}
          {d?.dominance.dominant && (
            <span className="ds-flag" data-tone="warn" title="one tool dominates — possible stuck loop">{d.dominance.tool} {Math.round(d.dominance.ratio * 100)}%</span>
          )}
        </div>
        <div className="ds-bars">
          {bars.length === 0 && <div className="ds-hud-empty">no tool calls recorded</div>}
          {bars.map((b) => (
            <div key={b.name} className="ds-bar" data-tone={toolTone(b.name)} title={b.errors ? `${b.errors} of ${b.count} calls rejected` : undefined}>
              <span className="ds-bar__label">{b.name}</span>
              <span className="ds-bar__track"><span className="ds-bar__fill" style={{ width: `${(b.count / max) * 100}%` }} /></span>
              <span className="ds-bar__val">
                {b.count}<span className="ds-bar__pct">{Math.round(b.pct * 100)}%</span>
                {!!b.errors && <span className="ds-tooltag__errors"> ✗{b.errors}</span>}
              </span>
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
        {/* de-dupe against artifacts (same as the collapsed RIGHT panel): a produced file is usually BOTH
            a declared artifact AND a captured write — show it once (as the verified artifact), not twice. */}
        {rv.writes.filter((w) => !rv.artifacts.some((a) => a.displayPath === w.displayPath)).map((w) => (
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
        <span>{pct != null && <><b>{Math.round(pct * 100)}%</b> · </>}{formatMs(elapsedMs)} elapsed</span>
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
