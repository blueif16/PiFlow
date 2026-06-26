// ── pi-runner/tui/components.mjs ─────────────────────────────────────────────
// The Ink view layer: pure render helpers + the App. Split from the pi-tui.mjs
// entry so the components are unit-renderable headlessly (ink-testing-library).
// htm gives JSX-like syntax with no build step (runtime-bound to React.createElement).
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Box, Text, useInput, useApp, useWindowSize } from 'ink';
import htm from 'htm';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
// MIGRATED: the data-acquisition layer is now a THIN ADAPTER over the SHARED observability source
// (@piflow/core/observe, via ./model.mjs) — `buildModel`/`discoverNamespaces` map a `readRunModel`
// snapshot into this view shape; `subscribeRun` folds the live `watchRun` node-event stream into the
// per-node text tail. The TUI opens NO `.pi/` file itself. The view layer below is unchanged.
import { discoverNamespaces, discoverFleet, buildModel, subscribeRun } from './model.mjs';
import { StageDag, runToMermaid, dagViewport, scrollStart } from './dag.mjs';

export const html = htm.bind(React.createElement);

// ── visual vocabulary ──────────────────────────────────────────────────────────
export const GLYPH = { ok: '✔', running: '', error: '✘', blocked: '⊘', gap: '◐', reused: '↺', pending: '·', dry: '∅', done: '✔', failed: '✘' };
const COLOR = { ok: 'green', running: 'cyan', error: 'red', blocked: 'yellow', gap: 'yellow', reused: 'gray', pending: 'gray', dry: 'magenta', done: 'green', failed: 'red' };
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const BIN_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.gz', '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.wav', '.ogg', '.mp4', '.mov', '.bin', '.wasm']);

// Read a file for the in-terminal overlay viewer. Text files come back as lines; binaries (and very
// large files) come back flagged so the overlay shows metadata instead of garbage bytes.
function readForOverlay(abs) {
  try {
    const size = fs.statSync(abs).size;
    if (BIN_EXT.has(path.extname(abs).toLowerCase()) || size > 1024 * 1024) return { size, binary: true, lines: [] };
    const raw = fs.readFileSync(abs, 'utf8');
    if (raw.includes('\u0000')) return { size, binary: true, lines: [] };
    return { size, binary: false, lines: raw.split('\n') };
  } catch (e) { return { size: 0, binary: false, lines: [`(cannot read: ${e && e.message || e})`] }; }
}

// Fallback for binaries only (images, etc.) — hand off to the OS default app. Text is shown IN the TUI.
function openExternal(abs) {
  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', abs] : [abs];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch { /* best-effort */ }
}

const clampWrap = (i, n) => (n <= 0 ? 0 : ((i % n) + n) % n);
const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);
const fmtDur = (msV) => {
  if (msV == null) return '—';
  const s = Math.round(msV / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
};
const fmtTok = (t) => (!t ? '' : t > 999 ? `${(t / 1000).toFixed(1)}k` : String(t));
const fmtBytes = (b) => (b == null ? '' : b < 1024 ? `${b}b` : b < 1048576 ? `${(b / 1024).toFixed(1)}k` : `${(b / 1048576).toFixed(1)}M`);
// Sub-cell timeline bar: the start snaps to a cell, but the bar's END is drawn with
// 1/8-width left-anchored block glyphs (▏▎▍▌▋▊▉█) so a short or odd-length span reads at
// eighth-of-a-cell precision instead of jumping a whole column — the braille/eighths
// sub-cell trick that makes the Gantt look smooth rather than chunky.
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
function ganttBar(startMs, endMs, t0, t1, w) {
  if (!startMs) return ' '.repeat(w);
  const span = Math.max(1, t1 - t0);
  const a = Math.max(0, Math.min(w, Math.round(((startMs - t0) / span) * w)));
  const lenF = Math.max(0, Math.min(w - a, (((endMs || t1) - t0) / span) * w - a));
  let full = Math.floor(lenF);
  let frac = EIGHTHS[Math.round((lenF - full) * 8)] || '';
  if (frac === '█' || (lenF - full) >= 1) { full += 1; frac = ''; } // round-up landed on a full cell
  if (full === 0 && !frac && lenF > 0) frac = '▏';                  // never render a zero-width live span
  const used = full + (frac ? 1 : 0);
  return ' '.repeat(a) + '█'.repeat(full) + frac + ' '.repeat(Math.max(0, w - a - used));
}
function viewport(len, sel, size) {
  if (len <= size) return [0, len];
  const start = Math.max(0, Math.min(sel - Math.floor(size / 2), len - size));
  return [start, start + size];
}

// Fold the live per-node accumulators (from the shared watchRun node-event stream) into the adapted
// model's nodes — toolCalls · toolBreakdown · thinking chars · eventCount. These cosmetics have no
// snapshot source (they are NOT in the shared RunModel); they are DERIVED from the stream, in-place.
function foldLiveIntoModel(model, byNode) {
  for (const [id, acc] of Object.entries(byNode || {})) {
    const n = model.nodes[id];
    if (!n) continue;
    n.toolCalls = acc.toolCalls || n.toolCalls || 0;
    n.eventCount = acc.eventCount || n.eventCount || 0;
    if (acc.toolBreakdown && Object.keys(acc.toolBreakdown).length) n.toolBreakdown = acc.toolBreakdown;
    if (acc.thinkChars) n.thinking = { chars: acc.thinkChars };
  }
}

// ── pure render helpers (called inline; not React components, so no hook rules) ──
// overflow="hidden" is load-bearing, not cosmetic: a panel whose content (node list, file list, growing
// live-output tail) exceeds its fixed height would otherwise spill past the box and inflate the TOTAL
// output height beyond the terminal — which makes Ink fall back to a full-screen clear every frame (the
// flashing). Clipping each panel to its height keeps total output ≤ terminal rows, so Ink diffs instead.
export const Panel = (title, active, w, h, children, grow = false) => html`
  <${Box} key=${title} flexDirection="column" width=${grow ? undefined : w} flexGrow=${grow ? 1 : 0} height=${h}
          overflow="hidden" borderStyle="round" borderColor=${active ? 'cyan' : 'gray'} paddingX=${1}>
    <${Text} key="title" bold color=${active ? 'cyan' : 'gray'}>${title}<//>
    ${children}
  <//>`;

export function Header(nss) {
  const running = nss.reduce((a, n) => a + n.threads.filter((t) => t.state === 'running').length, 0);
  const threads = nss.reduce((a, n) => a + n.threads.length, 0);
  const tok = nss.reduce((a, n) => a + n.threads.reduce((x, t) => x + (t.tokensBillable || 0), 0), 0);
  return html`
    <${Box} key="hdr" paddingX=${1} justifyContent="space-between">
      <${Text} key="l"><${Text} bold color="cyan">⬢ pi-runner<//> <${Text} dimColor>monitor<//><//>
      <${Text} key="r">${nss.length} ns · <${Text} color="green">${running} running<//><${Text} dimColor>/${threads}<//> · ${fmtTok(tok) || '0'} tok<//>
    <//>`;
}

export function NamespaceCol(nss, sel, focus, h, w = 22) {
  const inner = Math.max(8, w - 4);
  const [s, e] = viewport(nss.length, sel, h - 2);
  const rows = nss.slice(s, e).map((n, i) => {
    const on = s + i === sel;
    const run = n.threads.filter((t) => t.state === 'running').length;
    const dot = run ? html`<${Text} color="green">●<//>` : html`<${Text} dimColor>○<//>`;
    const count = `${run ? `${run}/` : ''}${n.threads.length}`;
    const nameW = Math.max(4, inner - 3 - count.length); // dot+sp (2) + sp before count (1)
    return html`<${Text} key=${n.dir} inverse=${on && focus === 0} wrap="truncate">
      ${dot} ${pad(n.name, nameW)} <${Text} dimColor>${count}<//>
    <//>`;
  });
  return Panel('NAMESPACES', focus === 0, w, h, rows);
}

export function ThreadCol(threads, sel, focus, h, tick, w = 30) {
  if (!threads.length) return Panel('THREADS', focus === 1, w, h, [html`<${Text} key="x" dimColor>no runs in this namespace<//>`]);
  const [s, e] = viewport(threads.length, sel, h - 2);
  const rows = threads.slice(s, e).map((t, i) => {
    const on = s + i === sel && focus === 1;
    const stale = t.state === 'running' && t.staleMs > 90000;
    const g = t.state === 'running' ? SPIN[tick % SPIN.length] : GLYPH[t.state];
    const pc = stale ? 'red' : COLOR[t.state];
    const prog = `${t.nodesDone}/${t.nodesTotal}`;
    // Secondary context (truncated first): a running thread's current node; a failed thread's stop point.
    const live = t.state === 'running' && t.runningNode ? ` ${t.runningNode}${t.runningTool ? ':' + t.runningTool : ''}`
      : t.state === 'failed' && t.errorNode ? ` ✘ ${t.errorNode}` : '';
    // Flex layout, NOT width math: [glyph] [name … flex-fill, truncates] [count]. The name box is the
    // only flexible item — glyph and count have flexShrink=0, so the count is ALWAYS anchored to the
    // panel's right edge at whatever width the panel actually renders.
    return html`<${Box} key=${t.statusPath}>
      <${Box} key="g" flexShrink=${0}><${Text} color=${pc} inverse=${on}>${g} <//><//>
      <${Box} key="n" flexGrow=${1} flexShrink=${1} overflow="hidden">
        <${Text} wrap="truncate" inverse=${on}>${t.run}<${Text} dimColor>${live}<//><//>
      <//>
      <${Box} key="p" flexShrink=${0}><${Text} bold color=${pc} inverse=${on}> ${prog}<//><//>
    <//>`;
  });
  return Panel('THREADS', focus === 1, w, h, rows);
}

// The flat, ordered list of OPENABLE files for a node — inputs, then declared outputs, then any other
// files it actually produced. NodeSub renders these and App opens the selected one; they MUST share
// this order so the selection index (fi) lines up.
export function nodeFiles(n) {
  const io = n?.io || {};
  const declaredRels = new Set((io.outputs || []).map((o) => o.rel));
  return [
    ...(io.inputs || []).map((f) => ({ ...f, kind: 'in' })),
    ...(io.outputs || []).map((f) => ({ ...f, kind: 'out' })),
    ...(io.produced || []).filter((p) => !declaredRels.has(p.rel)).map((f) => ({ ...f, kind: 'extra' })),
  ];
}

function fileRow(f, gi, fi, filesFocused) {
  const on = filesFocused && gi === fi;
  const arrow = f.kind === 'in' ? '←' : '→';
  const nameColor = f.exists === false ? 'red' : f.kind === 'in' ? 'cyan' : 'green';
  const mark = f.exists == null ? '' : f.exists ? '✔' : '✘';
  const sz = f.bytes != null ? fmtBytes(f.bytes) : '';
  const whom = f.kind === 'in' ? `from ${f.fromLabel}`
    : f.kind === 'out' ? (f.toLabels?.length ? `→ ${f.toLabels.slice(0, 3).join(', ')}${f.toLabels.length > 3 ? ` +${f.toLabels.length - 3}` : ''}` : 'terminal')
    : 'also produced';
  const fn = f.functionality ? ` · ${f.functionality}` : '';
  return html`<${Text} key=${'f' + gi} inverse=${on} wrap="truncate">  ${arrow} <${Text} color=${nameColor}>${f.rel}<//>${mark ? html` <${Text} dimColor>${mark}${sz ? ' ' + sz : ''}<//>` : null} <${Text} dimColor>${whom}${fn}<//><//>`;
}

// The per-node inspector: what the node IS (description · skill), how it WIRES (mini data-flow), and
// its exact INPUT/OUTPUT files with functionality — selectable, ⏎ opens the real file. Everything is
// derived in viz-model from the recorded prompt + run status; this is pure presentation.
function NodeSub(n, tail, fi = 0, filesFocused = false) {
  if (!n) return html`<${Text} dimColor>—<//>`;
  const io = n.io || {};
  const files = nodeFiles(n);
  const preds = [...new Set((io.inputs || []).map((i) => i.fromLabel))];
  const succs = [...new Set((io.outputs || []).flatMap((o) => o.toLabels || []))];
  const brief = (a) => (a.length ? a.slice(0, 2).join(', ') + (a.length > 2 ? ` +${a.length - 2}` : '') : '·');
  const tb = n.toolBreakdown ? Object.entries(n.toolBreakdown).map(([k, v]) => `${k}:${v}`).join('  ') : '';

  // head section (no top margin): identity · runtime meta · description · skill
  const head = [];
  head.push(html`<${Text} key="t" bold color=${COLOR[n.status]} wrap="truncate">${GLYPH[n.status] || '·'} ${n.label} <${Text} dimColor>[${n.id}]${n.agentType ? ` · ${n.agentType}` : ''}${n.hasSchema ? ' · schema' : ''}<//><//>`);
  head.push(html`<${Text} key="m" dimColor wrap="truncate">${n.phase || ''} · stage ${n.stageIndex || '?'} · ${n.toolCalls || 0} tools · think ${fmtTok(n.thinking?.chars) || 0} · ctx ${fmtTok(n.tokens?.contextPeak) || 0}${tb ? ` · ${tb}` : ''}<//>`);
  if (io.description) head.push(html`<${Text} key="d">${io.description}<//>`);
  if (io.skill) head.push(html`<${Text} key="sk" wrap="truncate"><${Text} dimColor>skill ▸ <//>${io.skill}<//>`);

  const sections = [html`<${Box} key="head" flexDirection="column">${head}<//>`];
  // mini horizontal data-flow around this node
  sections.push(html`<${Box} key="flow" marginTop=${1}><${Text} wrap="truncate"><${Text} dimColor>flow  <//>${brief(preds)} <${Text} color="cyan">─▶<//> <${Text} bold>[${n.label}]<//> <${Text} color="green">─▶<//> ${brief(succs)}<//><//>`);

  // INPUTS / OUTPUTS — one continuous selectable index across both groups
  if (files.length) {
    const inFiles = files.filter((f) => f.kind === 'in');
    const outFiles = files.filter((f) => f.kind !== 'in');
    if (inFiles.length) {
      const rows = [html`<${Text} key="ih" bold color="cyan">INPUTS<//>`, ...inFiles.map((f, i) => fileRow(f, i, fi, filesFocused))];
      sections.push(html`<${Box} key="in" flexDirection="column" marginTop=${1}>${rows}<//>`);
    }
    if (outFiles.length) {
      const base = inFiles.length;
      const rows = [html`<${Text} key="oh" bold color="green">OUTPUTS<//>`, ...outFiles.map((f, i) => fileRow(f, base + i, fi, filesFocused))];
      sections.push(html`<${Box} key="out" flexDirection="column" marginTop=${1}>${rows}<//>`);
    }
  } else if (io.owns?.length) {
    sections.push(html`<${Box} key="own" marginTop=${1}><${Text} dimColor wrap="truncate">writes (owned)  ${io.owns.join(' · ')}<//><//>`);
  }

  const foot = [];
  if (n.summary) foot.push(html`<${Text} key="sum" dimColor wrap="truncate">summary  ${n.summary}<//>`);
  if (n.issues?.length) foot.push(html`<${Text} key="iss" color="yellow" wrap="truncate">! ${n.issues[0]}<//>`);
  if (n.pipelineFindings?.length) foot.push(html`<${Text} key="pf" dimColor>findings ▾ (${n.pipelineFindings.length})<//>`);
  if (foot.length) sections.push(html`<${Box} key="foot" flexDirection="column" marginTop=${1}>${foot}<//>`);

  if (tail) sections.push(html`<${Box} key="tail" flexDirection="column" marginTop=${1}>
      <${Text} key="h" dimColor>live output ▾<//>
      ${tail.split('\n').slice(-4).map((ln, i) => html`<${Text} key=${'lo' + i} dimColor wrap="truncate">${ln || ' '}<//>`)}
    <//>`);

  return html`<${Box} key="sub" flexDirection="column" marginTop=${1}>${sections}<//>`;
}

export function DetailCol(thread, detail, di, focus, h, fi = 0, view = 'list', detW = 60, labels = false, dagCol = 0) {
  if (!thread) return Panel('DETAIL', focus === 2, 0, h, [
    html`<${Text} key="a" dimColor>No runs here yet.<//>`,
    html`<${Text} key="b" dimColor>Start a pi-runner workflow — it auto-registers the project.<//>`,
    html`<${Text} key="c" dimColor>Or add one by hand:  pi-tui add &lt;project-dir&gt;<//>`,
  ], true);
  if (detail && detail.err && !detail.model) return Panel('DETAIL', focus === 2, 0, h, [html`<${Text} key="x" color="red">${detail.err}<//>`], true);
  if (!detail || detail.key !== thread.statusPath || !detail.model) return Panel('DETAIL', focus === 2, 0, h, [html`<${Text} key="x" dimColor>loading…<//>`], true);

  const m = detail.model;
  const order = [];
  m.stages.forEach((st) => st.nodeIds.forEach((id) => order.push(id)));
  const { t0, t1 } = m.timeline;
  // Cap the node list so the (now much richer) inspector below it has room; the list never needs more
  // rows than there are nodes, and viewport keeps the selected node visible.
  const listH = Math.max(3, Math.min(order.length, h - 16));
  const [s, e] = viewport(order.length, di, listH);
  const tick = detail.tick || 0;

  const head = html`<${Text} key="head" wrap="truncate">
    <${Text} bold>${m.run.id}<//> <${Text} color=${COLOR[m.run.done ? (m.run.ok === false ? 'failed' : 'done') : 'running']}>${m.run.done ? (m.run.ok === false ? 'FAILED' : 'DONE') : 'running'}<//> <${Text} dimColor>· ${m.run.provider || ''}/${m.run.model || ''} · ${fmtDur(m.run.durationMs ?? m.run.elapsedMs)} · ${m.totals.toolCalls} tools · ${fmtTok(m.totals.tokensBillable) || 0} tok<//>
  <//>`;

  const sub = NodeSub(m.nodes[order[Math.min(di, order.length - 1)]], detail.tail, fi, focus === 3);

  // ── GRAPH view: the structural layered DAG (toggle with `v`). Same `di` selection +
  //    NodeSub inspector as the list — only the middle (the node list) is swapped out. ──
  if (view === 'graph') {
    // The graph self-sizes to its content (see dag.mjs), so this is just the CAP: a linear DAG stays compact
    // at the top and the inspector gets the slack; a parallel DAG may grow to here before lanes start to clip.
    const graphH = Math.max(6, h - 9);
    const dag = StageDag({ model: m, di, focus, height: graphH, width: Math.max(24, detW - 2), tick, labels, dagCol });
    return Panel('GRAPH', focus === 2, 0, h, [head, dag, sub], true);
  }

  // ── LIST view (default): per-node rows with the sub-cell Gantt timeline ──
  let lastStage = null;
  const rows = order.slice(s, e).map((id, i) => {
    const idx = s + i;
    const n = m.nodes[id];
    const on = idx === di;
    const g = n.status === 'running' ? SPIN[tick % SPIN.length] : GLYPH[n.status];
    const dur = n.status === 'running' && n.live ? fmtDur(n.live.elapsedMs) : fmtDur(n.durationMs);
    const stageTag = n.stageIndex !== lastStage ? `s${n.stageIndex}` : '';
    lastStage = n.stageIndex;
    return html`<${Text} key=${id} inverse=${on && focus === 2} wrap="truncate">
      <${Text} dimColor>${pad(stageTag, 3)}<//><${Text} color=${COLOR[n.status]}>${g}<//> ${pad(n.label, 17)} ${pad(dur, 6)} ${pad(fmtTok(n.tokens?.billable), 5)} <${Text} color=${COLOR[n.status]} dimColor>${ganttBar(n.startMs, n.endMs, t0, t1, 14)}<//>
    <//>`;
  });
  return Panel('DETAIL', focus === 2, 0, h, [head, ...rows, sub], true);
}

export function Footer(every, focus, view = 'list', notice = null) {
  // The left side is the keymap — mode-aware so it tells the truth in each view; a transient
  // notice (e.g. the `e` export confirmation) replaces it until the next keypress.
  const drill = focus === 2 ? 'inspect files' : focus === 3 ? 'view file' : 'drill in';
  const left = notice
    ? html`<${Text} key="l" color="cyan">${notice}<//>`
    : view === 'graph'
      ? html`<${Text} key="l" dimColor>↑↓←→ move · tab pane · ⏎ inspect · <${Text} color="cyan">v<//> list · <${Text} color="cyan">l<//> files · <${Text} color="cyan">e<//> export · q quit<//>`
      : html`<${Text} key="l" dimColor>↑↓ select · ←→/tab pane · ⏎ ${drill} · <${Text} color="cyan">v<//> graph · <${Text} color="cyan">e<//> export · q quit<//>`;
  return html`
    <${Box} key="ftr" paddingX=${1} justifyContent="space-between">
      ${left}
      <${Text} key="r" dimColor>${['namespaces', 'threads', 'nodes', 'files'][focus]} · ${view} · live ${every}s<//>
    <//>`;
}

// In-terminal file viewer — opens OVER the dashboard (never spawns another app / screen). Text files
// scroll line-by-line; binaries show metadata + an 'o' escape hatch to the OS default app.
export function Overlay(ov, scroll, h) {
  const view = Math.max(1, h - 4);
  const total = ov.lines.length;
  const start = Math.min(Math.max(0, scroll), Math.max(0, total - view));
  const win = ov.lines.slice(start, start + view);
  const gut = String(start + win.length || 1).length;
  const body = ov.binary
    ? [
        html`<${Text} key="b1" color="yellow">binary file — ${fmtBytes(ov.size)} (${ov.size} bytes)<//>`,
        html`<${Text} key="b2" dimColor>Not shown as text. Press <${Text} color="cyan">o<//> to open with the OS default app, <${Text} color="cyan">esc<//> to close.<//>`,
      ]
    : win.map((ln, i) => html`<${Text} key=${'l' + i} wrap="truncate"><${Text} dimColor>${pad(String(start + i + 1), gut)} <//>${ln || ' '}<//>`);
  const pos = ov.binary ? '' : ` · ${total ? start + 1 : 0}-${start + win.length}/${total}`;
  return html`
    <${Box} flexDirection="column" width="100%" height=${h} borderStyle="round" borderColor="cyan" paddingX=${1}>
      <${Text} key="h" wrap="truncate"><${Text} bold color="cyan">▤ ${ov.rel}<//> <${Text} dimColor>· ${fmtBytes(ov.size)}${pos}<//><//>
      <${Box} key="bd" flexDirection="column" flexGrow=${1}>${body}<//>
      <${Text} key="f" dimColor>↑↓ scroll · space/PgDn page · g/G top/bottom${ov.binary ? ' · o open externally' : ''} · esc close<//>
    <//>`;
}

// ── the app ─────────────────────────────────────────────────────────────────────
export function App({ config }) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [nss, setNss] = useState([]);
  const [ni, setNi] = useState(0);
  const [ti, setTi] = useState(0);
  const [di, setDi] = useState(0);
  const [fi, setFi] = useState(0);
  const [focus, setFocus] = useState(0);
  const [view, setView] = useState('list'); // DETAIL pane: 'list' (rows+gantt) | 'graph' (layered DAG), toggled with `v`
  const [labels, setLabels] = useState(false); // graph view: draw the file basename on each edge (`l`)
  const [dagCol, setDagCol] = useState(0);     // graph view: leftmost visible stage (edge-triggered h-scroll)
  const [notice, setNotice] = useState(null);   // transient status line (e.g. after `e` export)
  const [detail, setDetail] = useState(null);
  const [tick, setTick] = useState(0);
  const [overlay, setOverlay] = useState(null); // { rel, abs, size, binary, lines } — in-terminal file viewer
  const [ovScroll, setOvScroll] = useState(0);
  // Leave one row of headroom below the app. Filling the terminal exactly risks a one-line overflow
  // (final-line cursor scroll), which trips Ink's full-screen-clear path → flicker.
  const H = Math.max(10, (rows || 24) - 1);
  // Responsive column widths so the layout squeezes gracefully; DETAIL takes the slack (flexGrow).
  const W = Math.max(48, columns || 80);
  // In GRAPH view the DAG is the star — collapse the side columns to their minimums so the diagram gets the
  // width instead of being squeezed into a few stages; the list view keeps the roomier proportional columns.
  const nsW = view === 'graph' ? 18 : Math.max(18, Math.min(24, Math.round(W * 0.20)));
  const thW = view === 'graph' ? 22 : Math.max(22, Math.min(38, Math.round(W * 0.32)));
  const detW = Math.max(30, W - nsW - thW - 6); // slack width the DETAIL/GRAPH panel actually gets
  const sel = useRef({ ni, ti });
  sel.current = { ni, ti };
  // Last-good model per thread. Switching threads renders the cached model INSTANTLY instead of blanking
  // the panel to "loading…" while buildModel awaits — that blank frame was the flash on navigation.
  const cache = useRef(new Map());
  const nssRef = useRef([]);
  nssRef.current = nss;

  // Live per-run accumulators folded from the SHARED watchRun node-event stream (subscribeRun): runDir →
  // { byNode: { id → { text, toolCalls, thinkChars, toolBreakdown } } }. The tail + tool/think cosmetics
  // are DERIVED from the stream, never re-read from `.pi/` files.
  const live = useRef(new Map());

  const refresh = useCallback(async () => {
    // A transient discover failure (or a momentary empty read while a run writes its files) must NOT blank
    // the whole UI — that empty frame was a periodic flash. Keep the last good list instead.
    // FLEET mode discovers ALL registered repos' runs (config.fleet); SINGLE mode projects the one run dir.
    let namespaces = null;
    try { namespaces = config.fleet ? await discoverFleet() : await discoverNamespaces(config); } catch { /* transient — keep last good */ }
    if (namespaces && namespaces.length) setNss(namespaces);
    const list = namespaces && namespaces.length ? namespaces : nssRef.current;
    const ns = list[Math.min(ni, Math.max(0, list.length - 1))];
    const thr = ns?.threads[Math.min(ti, Math.max(0, (ns?.threads.length || 1) - 1))];
    if (!ns || !thr) { setDetail(null); return; }
    try {
      // MIGRATED: buildModel adapts a `readRunModel(thr.runDir)` snapshot — the shared reader; no bespoke
      // `.pi/` read. The live text tail is folded in from the subscribeRun stream (the `live` ref).
      const model = await buildModel({ runDir: thr.runDir, run: thr.run });
      const byNode = live.current.get(thr.runDir)?.byNode || {};
      foldLiveIntoModel(model, byNode);
      const order = model.stages.flatMap((st) => st.nodeIds);
      const selId = order[Math.min(di, Math.max(0, order.length - 1))];
      const node = model.nodes[selId];
      const outNode = node && node.status === 'running' ? selId : (model.pathways.running[0] || selId);
      const to = byNode[outNode]?.text || null;
      cache.current.set(thr.statusPath, model);
      if (sel.current.ni === ni && sel.current.ti === ti) setDetail({ key: thr.statusPath, model, tail: to });
    } catch (err) {
      setDetail({ key: thr.statusPath, model: null, err: String(err && err.message || err) });
    }
  }, [config, ni, ti, di]);

  // Subscribe to the SHARED live stream for the current run dir; fold each node-event into `live`. The
  // subscription re-arms when the selected run dir changes; the periodic refresh above reads its result.
  const curRunDir = nss[ni]?.threads[ti]?.runDir || config.runDir;
  useEffect(() => {
    if (!curRunDir) return undefined;
    const stop = subscribeRun({
      runDir: curRunDir, run: undefined, pollMs: (config.every || 2) * 1000,
      onTail: (byNode) => { live.current.set(curRunDir, { byNode }); },
    });
    return stop;
  }, [curRunDir, config.every]);

  // Keep a live ref to refresh so the periodic interval below stays mounted across navigation (it depends
  // only on config.every). Recreating the interval on every keypress was extra churn behind the flicker.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => { setDetail((d) => (d && d.model ? { ...d, tick } : d)); }, [tick]);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { const h = setInterval(() => refreshRef.current(), config.every * 1000); return () => clearInterval(h); }, [config.every]);
  // The tick drives the spinner AND the graph's selected-node marquee, both of which need a clock. Run it
  // while something is running OR while the graph is open (so a long selected label can roll even on a
  // finished run). When nothing is actually animating the frame is byte-stable, so Ink skips the rewrite
  // entirely — no idle flashing; only a live spinner or an actually-scrolling label triggers a redraw.
  const anyRunning = nss.some((n) => n.threads.some((t) => t.state === 'running'));
  const ticking = anyRunning || view === 'graph';
  useEffect(() => {
    if (!ticking) return undefined;
    const h = setInterval(() => setTick((t) => t + 1), 140);
    return () => clearInterval(h);
  }, [ticking]);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') { exit(); return; }

    // ── in-terminal file overlay: scroll, never leaves the TUI; esc/q closes back to the dashboard ──
    if (overlay) {
      const view = Math.max(1, H - 4);
      const maxScroll = Math.max(0, overlay.lines.length - view);
      if (key.escape || input === 'q') { setOverlay(null); return; }
      if (key.downArrow || input === 'j') { setOvScroll((s) => Math.min(maxScroll, s + 1)); return; }
      if (key.upArrow || input === 'k') { setOvScroll((s) => Math.max(0, s - 1)); return; }
      if (key.pageDown || input === ' ') { setOvScroll((s) => Math.min(maxScroll, s + view)); return; }
      if (key.pageUp) { setOvScroll((s) => Math.max(0, s - view)); return; }
      if (input === 'g') { setOvScroll(0); return; }
      if (input === 'G') { setOvScroll(maxScroll); return; }
      if (input === 'o' && overlay.binary) { openExternal(overlay.abs); return; }
      return;
    }

    if (input === 'q') { exit(); return; }
    if (notice) setNotice(null);                                              // any key dismisses the transient notice
    if (input === 'v') { setView((vw) => (vw === 'list' ? 'graph' : 'list')); return; } // toggle DETAIL list ⇄ graph
    if (input === 'l') { setLabels((x) => !x); return; }                      // graph: toggle the per-edge file labels
    if (input === 'e') {                                                      // export this run as a Mermaid .mmd snapshot
      const m = detail?.model;
      if (m && m.run?.id && nss[ni]) {
        try {
          // MIGRATED: the run dir is the artifact home — export beside it (was out/<id>/graph.mmd).
          const file = path.join(nss[ni].runDir, 'graph.mmd');
          fs.writeFileSync(file, runToMermaid(m));
          setNotice(`✔ saved ${path.relative(nss[ni].dir, file)}`);
        } catch (e) { setNotice(`✘ export failed: ${(e && e.message) || e}`); }
      } else setNotice('no run to export');
      return;
    }
    const threads = nss[ni]?.threads || [];
    const order = detail?.model ? detail.model.stages.flatMap((st) => st.nodeIds) : [];
    const selId = order[Math.min(di, Math.max(0, order.length - 1))];
    const node = (detail?.model?.nodes && detail.model.nodes[selId]) || null;
    const files = node ? nodeFiles(node) : [];

    if (key.tab) { setFocus((f) => clampWrap(f + (key.shift ? -1 : 1), 4)); return; }
    // ── graph view: 2-D node navigation (↑↓ within a stage, ←→ across stages). At the grid edge,
    //    ← falls through to "pane left" and → falls through to "drill into files" (handlers below). ──
    if (view === 'graph' && focus === 2 && detail?.model) {
      const m = detail.model;
      const cur = m.nodes[selId];
      const si = (cur?.stageIndex || 1) - 1;
      const lane = cur?.lane || 0;
      const go = (id2) => { const k = order.indexOf(id2); if (k >= 0) { setDi(k); setFi(0); } };
      const laneIn = (sx, ln) => { const st = m.stages[sx]; return st ? st.nodeIds[Math.min(ln, st.nodeIds.length - 1)] : null; };
      // mirror the renderer's geometry so the deck scrolls on the SAME boundary it draws.
      const { S } = dagViewport(Math.max(24, detW - 2), m.stages.length, labels);
      const cross = (nsi) => { go(laneIn(nsi, lane)); setDagCol((c) => scrollStart(c, nsi, S, m.stages.length)); };
      if (key.upArrow) { const st = m.stages[si]; if (st) go(st.nodeIds[clampWrap(lane - 1, st.nodeIds.length)]); return; }
      if (key.downArrow) { const st = m.stages[si]; if (st) go(st.nodeIds[clampWrap(lane + 1, st.nodeIds.length)]); return; }
      if (key.leftArrow && si > 0) { cross(si - 1); return; }
      if (key.rightArrow && si < m.stages.length - 1) { cross(si + 1); return; }
      // edge cases (← at first stage, → at last stage, ⏎) fall through to the handlers below
    }
    if (key.leftArrow) { setFocus((f) => Math.max(0, f - 1)); return; }

    // focus 3 = the selected node's file list: ↑↓ move, ⏎ opens the file IN the TUI (overlay viewer).
    if (focus === 3) {
      if (key.upArrow) { setFi((i) => clampWrap(i - 1, files.length || 1)); return; }
      if (key.downArrow) { setFi((i) => clampWrap(i + 1, files.length || 1)); return; }
      if (key.return) {
        const f = files[clampWrap(fi, files.length || 1)];
        if (f && nss[ni]) {
          // MIGRATED: a node's files are relative to the run dir (was out/<id>/<rel>).
          const rel = f.path || f.rel;
          const abs = path.isAbsolute(rel) ? rel : path.join(nss[ni].runDir, rel);
          const data = readForOverlay(abs);
          setOvScroll(0);
          setOverlay({ rel: f.rel, abs, size: data.size, binary: data.binary, lines: data.lines });
        }
        return;
      }
      return;
    }
    // ⏎ / → drill deeper; from the node pane into its files (only when the node has any).
    if (key.return || key.rightArrow) {
      if (focus === 2) { if (files.length) { setFi(0); setFocus(3); } return; }
      setFocus((f) => Math.min(2, f + 1));
      return;
    }
    const d = key.upArrow ? -1 : key.downArrow ? 1 : 0;
    if (!d) return;
    if (focus === 0) { setNi((i) => clampWrap(i + d, nss.length)); setTi(0); setDi(0); setFi(0); setDagCol(0); }
    else if (focus === 1) { setTi((i) => clampWrap(i + d, threads.length)); setDi(0); setFi(0); setDagCol(0); }
    else { setDi((i) => clampWrap(i + d, order.length || 1)); setFi(0); }
  });

  if (overlay) return Overlay(overlay, ovScroll, H);

  const bodyH = H - 4;
  const threads = nss[ni]?.threads || [];
  // Prefer the freshest detail for the selected thread; otherwise fall back to its cached model so the
  // panel keeps its content during the async refresh instead of flashing "loading…" on every switch.
  const curThread = threads[ti];
  let shownDetail = detail;
  if (curThread && !(detail && detail.key === curThread.statusPath && (detail.model || detail.err))) {
    const cached = cache.current.get(curThread.statusPath);
    if (cached) shownDetail = { key: curThread.statusPath, model: cached, tail: null, tick };
  }
  return html`
    <${Box} flexDirection="column" width="100%" height=${H} overflow="hidden">
      ${Header(nss)}
      <${Box} key="body" flexGrow=${1} overflow="hidden">
        ${NamespaceCol(nss, ni, focus, bodyH, nsW)}
        ${ThreadCol(threads, ti, focus, bodyH, tick, thW)}
        ${DetailCol(curThread, shownDetail, di, focus, bodyH, fi, view, detW, labels, dagCol)}
      <//>
      ${Footer(config.every, focus, view, notice)}
    <//>`;
}
