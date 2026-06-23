// ── pi-runner/tui/dag.mjs ─────────────────────────────────────────────────────
// The STRUCTURAL view: render a run as a left→right layered DAG instead of the flat
// node list. Everything it needs already exists in buildModel()'s output — we add no
// new data:
//   • LAYERS (x)      = model.stages          (already topologically ordered)
//   • LANE (y)        = node.lane / stageIndex (already assigned)
//   • EDGES           = node.io.inputs[].fromNode / io.outputs[].toNodes (file data-flow)
//
// Edges are drawn into a character grid with box-drawing glyphs composited by STROKE
// BITMASK (the drawille "bit-OR the dots" trick, applied to ┌┐└┘├┤┬┴┼): each cell holds
// a 4-bit up/right/down/left mask, edges OR their strokes in, and junctions resolve to
// the correct tee/cross automatically. Node boxes are drawn on top and edges never
// overwrite them (so a skip-edge threading past a column shows clean gaps, not garbage).
//
// Pure presentation. Kept in its own file so components.mjs stays the wiring layer and
// this renderer is unit-testable headlessly (same reason viz-model is split out).
import React from 'react';
import { Box, Text } from 'ink';
import htm from 'htm';

const html = htm.bind(React.createElement);

// Local visual vocab (small copy — keeping it here avoids a components.mjs⇄dag.mjs import cycle).
const GLYPH = { ok: '✔', running: '◐', error: '✘', blocked: '⊘', gap: '◐', reused: '↺', pending: '·', dry: '∅', done: '✔', failed: '✘' };
const COLOR = { ok: 'green', running: 'cyan', error: 'red', blocked: 'yellow', gap: 'yellow', reused: 'gray', pending: 'gray', dry: 'magenta', done: 'green', failed: 'red' };
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
// SELECTION is a SEPARATE visual channel from status, reserved so the navigation cursor can never be
// confused with a node's state. It must NOT be any value in COLOR (cyan=running, green=ok, …) — bold
// whiteBright is outside the status palette, so "where the cursor is" and "what state a node is in" stay
// independently readable. The selected node's frame + edges + pointer all share SEL so they read as one unit.
const SEL = 'whiteBright';

// stroke bits: U=1 R=2 D=4 L=8 → box-drawing glyph (drawille-style OR-compositing)
const CH = { 0: ' ', 1: '╵', 2: '╶', 3: '└', 4: '╷', 5: '│', 6: '┌', 7: '├', 8: '╴', 9: '┘', 10: '─', 11: '┴', 12: '┐', 13: '┤', 14: '┬', 15: '┼' };
const pad = (s, n) => String(s ?? '').padEnd(n).slice(0, n);

// Marquee a string through a fixed-width window: when `text` overflows `width`, return a `tick`-driven
// slice that scrolls left and loops (with a small gap between repeats) so the whole thing can be read; when
// it fits, return it unchanged. Used for the SELECTED node's name so a long label rolls instead of clipping.
function marquee(text, width, tick) {
  if (width <= 0) return '';
  if (text.length <= width) return text;                 // fits — nothing to scroll
  const loop = text + '   ';                              // 3-space breather between repeats
  const off = Math.floor(tick / 2) % loop.length;        // ~2 ticks/char ≈ readable pace
  return (loop + loop).slice(off, off + width);
}

// How many stage columns fit, and the layout constants the caller needs to mirror (so App can manage the
// horizontal scroll offset with the SAME geometry the renderer uses). Single source of truth for `S`.
export function dagViewport(width, total, labels = false) {
  const gutterW = labels ? 16 : 4;                        // label mode: a wider gutter so basenames fit centred on the edge
  const padL = 0;                                          // the selection pointer now sits under the node, not in a left gutter
  const fit = Math.max(1, Math.floor((width + gutterW) / (16 + gutterW))); // min card ~16 to decide count
  const S = Math.min(total, Math.max(1, fit));
  return { S, gutterW, padL };
}

// EDGE-TRIGGERED horizontal scroll. Start from the caller's offset `col`, clamp it into range, then nudge
// it the MINIMUM needed to keep `sel` on screen: the cursor moves freely within the visible columns and the
// deck scrolls only when the cursor reaches an edge — vs a centered window that re-scrolls on every step.
export function scrollStart(col, sel, size, total) {
  const maxStart = Math.max(0, total - size);
  let start = Math.max(0, Math.min(col, maxStart));
  if (sel < start) start = sel;                            // cursor fell off the LEFT edge → reveal it
  else if (sel >= start + size) start = sel - size + 1;    // cursor fell off the RIGHT edge → reveal it
  return Math.max(0, Math.min(start, maxStart));
}

// The DAG view. Returns a single column: a position hint + the rendered grid rows.
//   model · di (flat selection index, shared with the list view) · focus · height · width · tick
export function StageDag({ model: m, di = 0, focus = 0, height = 12, width = 60, tick = 0, labels = false, dagCol = 0 }) {
  const order = m.stages.flatMap((st) => st.nodeIds);
  if (!order.length) return html`<${Box} key="dag"><${Text} dimColor>no nodes to graph yet<//><//>`;
  const selId = order[Math.min(di, Math.max(0, order.length - 1))];
  const selStage = (m.nodes[selId]?.stageIndex || 1) - 1;

  // ── horizontal layout: how many stage columns fit, edge-triggered around the caller's scroll offset ──
  // label mode widens the gutter so each edge's file basename has room to ride the edge.
  const total = m.stages.length;
  const { S, gutterW, padL } = dagViewport(width, total, labels);
  const cardW = Math.max(12, Math.min(26, Math.floor((width - padL - (S - 1) * gutterW) / S)));
  const step = cardW + gutterW;
  const sFrom = scrollStart(dagCol, selStage, S, total); // honor the caller's offset; only edge-scroll if needed
  const sTo = sFrom + S;
  const stages = m.stages.slice(sFrom, sTo);
  const colOf = (stageIndex) => stageIndex - 1 - sFrom; // -1 if outside the window

  // ── vertical layout: size to the CONTENT but PADDED so the deck breathes (≈2 blank rows above & below)
  //    instead of either floating in a huge centred gap OR being squeezed so tight the pointer/connectors
  //    have no row to live in. The "world" is that padded content height; we render as much as fits and
  //    scroll it vertically to follow the selection, so future parallel stacks that overflow are reachable
  //    with ↑↓ rather than clipped to nothing. ──
  const band = 4;                                          // 3 box rows + 1 gap (matches the placement loop)
  const padV = 2;                                          // blank rows of breathing room above & below the deck
  const tallest = Math.max(3, ...stages.map((st) => st.nodeIds.length * band - 1));
  const worldH = tallest + padV * 2;                       // full padded deck height
  const avail = Math.max(3, height - 1);                   // grid rows available (-1 for the hint line)
  const rows = Math.min(avail, worldH);                    // never taller than the padded content
  const W = padL + (stages.length - 1) * step + cardW;
  // where each stage's stack begins in WORLD space (shorter stacks centre against the tallest, under the pad)
  const worldTopOf = (st) => padV + Math.floor((tallest - (st.nodeIds.length * band - 1)) / 2);
  // vertical scroll offset: keep the selected node centred when the padded deck is taller than what fits.
  const selStObj = m.stages[selStage];
  const selWorldMid = (selStObj ? worldTopOf(selStObj) : padV) + (m.nodes[selId]?.lane || 0) * band + 1;
  const vy = worldH > rows ? Math.max(0, Math.min(selWorldMid - Math.floor(rows / 2), worldH - rows)) : 0;

  // grids: node cells (char+color override) and the edge stroke mask (+ "touches selection?")
  const nodeCh = Array.from({ length: rows }, () => new Array(W).fill(null));
  const mask = new Array(rows * W).fill(0);
  const eSel = new Array(rows * W).fill(false);
  const lbl = new Array(rows * W).fill(null); // edge-label chars (label mode): over strokes, under nodes
  const at = (x, y) => y * W + x;
  const inB = (x, y) => x >= 0 && x < W && y >= 0 && y < rows;

  // ── place node boxes (padded + vertically scrolled into view), record geometry ──
  const geo = {}; // id -> { x0, x1, midY, on }
  stages.forEach((st, ci) => {
    const x0 = padL + ci * step;
    const ids = st.nodeIds;
    const stackTop = worldTopOf(st) - vy;            // visible-space top of this stack (after the vertical scroll)
    ids.forEach((id, lane) => {
      const n = m.nodes[id];
      const top = stackTop + lane * band;            // visible top row of this card (off-screen rows clip via inB)
      const midY = top + 1;
      const on = id === selId;
      // Keep the node painted in its STATUS colour even when selected — selection is signalled OUT-OF-BAND
      // (a pointer under/over the card, below) and never by recolouring, so status stays readable AND you can
      // see which node the cursor is on at the same time. Selected card is bolded for a touch of extra weight.
      const color = COLOR[n.status] || 'gray';
      const g = n.status === 'running' ? SPIN[tick % SPIN.length] : GLYPH[n.status] || '·';
      // The SELECTED node's name rolls (marquee) when it's too long to fit, so you can read the whole label;
      // every other node keeps the static (truncated) name. Glyph + leading space stay fixed at the left.
      const name = on ? marquee(n.label, cardW - 4, tick) : n.label;
      const label = pad(`${g} ${name}`, cardW - 2);
      const put = (x, y, ch, col, bold = on) => { if (inB(x, y)) nodeCh[y][x] = { ch, color: col, bold }; };
      // ┌─┐ / │ … │ / └─┘
      for (let r = 0; r < 3; r++) {
        const y = top + r;
        for (let c = 0; c < cardW; c++) {
          const edge = c === 0 || c === cardW - 1;
          let ch;
          if (r === 0) ch = c === 0 ? '┌' : c === cardW - 1 ? '┐' : '─';
          else if (r === 2) ch = c === 0 ? '└' : c === cardW - 1 ? '┘' : '─';
          else ch = edge ? '│' : label[c - 1];
          put(x0 + c, y, ch, color);
        }
      }
      // SELECTION pointer: a bright caret directly UNDER the selected card (or above it, if there's no row
      // below) — positional, so it never hides the node's status colour and is never mistaken for an edge arrow.
      if (on) {
        const cx = x0 + Math.floor(cardW / 2);
        if (top + 3 < rows) put(cx, top + 3, '▲', SEL, true);
        else if (top - 1 >= 0) put(cx, top - 1, '▼', SEL, true);
      }
      geo[id] = { x0, x1: x0 + cardW - 1, midY, on };
    });
  });

  // ── route edges from io data-flow, compositing strokes; never overwrite node cells ──
  const setDir = (x, y, bit, sel) => {
    if (!inB(x, y) || nodeCh[y][x]) return; // node boxes win; gaps where edges cross a column
    mask[at(x, y)] |= bit;
    if (sel) eSel[at(x, y)] = true;
  };
  const hRun = (xa, xb, y) => { const s = Math.sign(xb - xa) || 1; const out = []; for (let x = xa; ; x += s) { out.push([x, y]); if (x === xb) break; } return out; };
  const vRun = (ya, yb, x) => { const s = Math.sign(yb - ya) || 1; const out = []; for (let y = ya; ; y += s) { out.push([x, y]); if (y === yb) break; } return out; };

  // Write a basename CENTRED on a horizontal run of the connector (label mode), drawn between the line stubs
  // so it reads as "this file rides this edge" and is never jammed against / cut off by a node. Truncates
  // with a trailing … (honest — never a misleading fragment), needs ≥4 cells to be unambiguous, and bails if
  // the run already carries another label (first edge wins rather than two names overprinting).
  const writeLabel = (xa, xb, y, text, color) => {
    const lo = Math.min(xa, xb), hi = Math.max(xa, xb);
    const span = hi - lo + 1;
    if (span < 4 || !text) return false;
    const t = text.length <= span ? text : text.slice(0, span - 1) + '…';
    const start = lo + Math.floor((span - t.length) / 2);   // centre the name within the run
    for (let i = 0; i < t.length; i++) { const x = start + i; if (!inB(x, y) || nodeCh[y][x] || lbl[at(x, y)]) return false; }
    for (let i = 0; i < t.length; i++) lbl[at(start + i, y)] = { ch: t[i], color };
    return true;
  };

  // ── build the edge set from io data-flow, then REDUCE it to the lucid dependency skeleton ────────────
  // Inference: an output artifact of node A that node B reads back is a data-flow edge A→B (already computed
  // in io.outputs[].toNodes). Two cleanups turn the hairball into a clear graph:
  //   • FORWARD-ONLY — a producer is always an EARLIER stage, so drop any backward link (two nodes writing
  //     the same filename would otherwise draw a confusing right→left line, e.g. a reconcile step).
  //   • TRANSITIVE REDUCTION — drop A→C whenever a path A→…→C already exists through other edges: that long
  //     skip line is redundant (the dependency is implied by the chain) and removing it declutters massively,
  //     leaving only the edges that actually carry NEW structure. The graph reads as the pipeline it is.
  const stageOf = (id) => m.nodes[id]?.stageIndex || 0;
  const edges = new Map();
  const adj = new Map(order.map((id) => [id, new Set()]));
  for (const id of order) {
    for (const o of (m.nodes[id]?.io?.outputs || [])) {
      const file = o.rel ? String(o.rel).split('/').pop() : '';
      for (const tgt of (o.toNodes || [])) {
        if (stageOf(tgt) <= stageOf(id)) continue;          // forward-only: skip backward / same-stage links
        const key = `${id}>${tgt}`;
        const e = edges.get(key) || { src: id, tgt, files: [] };
        if (file && !e.files.includes(file)) e.files.push(file);
        edges.set(key, e);
        adj.get(id).add(tgt);
      }
    }
  }
  // descendants[id] = every node reachable from id (forward ⇒ acyclic, so the memo can't loop)
  const descend = new Map();
  const descOf = (id) => {
    if (descend.has(id)) return descend.get(id);
    const s = new Set(); descend.set(id, s);
    for (const n of adj.get(id)) { s.add(n); for (const d of descOf(n)) s.add(d); }
    return s;
  };
  order.forEach(descOf);
  // an edge A→C is redundant iff some OTHER child W of A can already reach C — then the A→C line is implied.
  for (const [key, e] of [...edges]) {
    for (const w of adj.get(e.src)) {
      if (w !== e.tgt && descOf(w).has(e.tgt)) { edges.delete(key); break; }
    }
  }

  for (const e of edges.values()) {
    const a = geo[e.src], b = geo[e.tgt];
    if (!a || !b) continue;                           // endpoint outside the window — clip
    const sel = e.src === selId || e.tgt === selId;
    const fwd = b.x0 >= a.x1;
    const srcX = fwd ? a.x1 + 1 : a.x0 - 1;
    const dstX = fwd ? b.x0 - 1 : b.x1 + 1;
    const midX = Math.round((srcX + dstX) / 2);
    const path = [...hRun(srcX, midX, a.midY), ...vRun(a.midY, b.midY, midX).slice(1), ...hRun(midX, dstX, b.midY).slice(1)];
    for (let i = 0; i < path.length - 1; i++) {
      const [x, y] = path[i]; const [nx, ny] = path[i + 1];
      const d1 = nx > x ? 2 : nx < x ? 8 : ny > y ? 4 : 1;     // a→next
      const d2 = nx > x ? 8 : nx < x ? 2 : ny > y ? 1 : 4;     // next→a
      setDir(x, y, d1, sel); setDir(nx, ny, d2, sel);
    }
    // edge label: the flowing file's basename, centred on the connector. A STRAIGHT edge (same row, the common
    // case) gets the WHOLE gutter run so the name has maximum room; a JOGGING edge (lane change) falls back to
    // its longer horizontal arm, inset past the corner at midX so it never hides the junction. Selected edges
    // win (SEL — same as the node), others dim.
    if (labels && e.files.length) {
      const text = e.files[0] + (e.files.length > 1 ? ` +${e.files.length - 1}` : '');
      const color = sel ? SEL : 'gray';
      if (a.midY === b.midY) {
        writeLabel(srcX, dstX, a.midY, text, color);
      } else {
        const src = [srcX, midX - 1, a.midY], dst = [midX + 1, dstX, b.midY];
        const [first, second] = Math.abs(dstX - midX) >= Math.abs(midX - srcX) ? [dst, src] : [src, dst];
        writeLabel(first[0], first[1], first[2], text, color) || writeLabel(second[0], second[1], second[2], text, color);
      }
    }
  }

  // ── emit grid rows, grouping consecutive same-style cells into <Text> spans ──
  const outRows = [];
  for (let y = 0; y < rows; y++) {
    const spans = []; let buf = ''; let cur = null;
    const flush = () => { if (buf) { const s = cur; spans.push(html`<${Text} key=${'s' + y + '-' + spans.length} color=${s.color} bold=${s.bold} dimColor=${s.dim}>${buf}<//>`); buf = ''; } };
    for (let x = 0; x < W; x++) {
      const nc = nodeCh[y][x];
      const lc = lbl[at(x, y)];
      let style, ch;
      if (nc) { style = { color: nc.color, bold: nc.bold, dim: false }; ch = nc.ch; }
      else if (lc) { style = { color: lc.color, bold: lc.color === SEL, dim: lc.color !== SEL }; ch = lc.ch; }
      else { const mk = mask[at(x, y)]; if (mk) { const sel = eSel[at(x, y)]; style = { color: sel ? SEL : 'gray', bold: sel, dim: !sel }; ch = CH[mk]; } else { style = { color: undefined, bold: false, dim: false }; ch = ' '; } }
      if (!cur || cur.color !== style.color || cur.bold !== style.bold || cur.dim !== style.dim) { flush(); cur = style; }
      buf += ch;
    }
    flush();
    outRows.push(html`<${Text} key=${'r' + y} wrap="truncate">${spans.length ? spans : ' '}<//>`);
  }

  const more = `${total > S ? `stages ${sFrom + 1}–${sTo}/${total}  ` : ''}`;
  const nav = `${sFrom > 0 ? '◂ ' : ''}${more}${sTo < total ? '▸' : ''}${more || sFrom > 0 || sTo < total ? ' · ' : ''}`;
  const hint = html`<${Text} key="h" dimColor wrap="truncate">${nav}v list · l ${labels ? 'hide' : 'show'} files · e export · ⏎ inspect<//>`;
  // flexShrink=0: in a short terminal the (tall) inspector below must NOT squash the graph — the graph
  // renders in full and the inspector is the thing that clips at the panel's bottom edge, not the diagram.
  return html`<${Box} key="dag" flexDirection="column" flexShrink=${0}>${[hint, ...outRows]}<//>`;
}

// ── Mermaid export ────────────────────────────────────────────────────────────────────────────
// A run → a portable .mmd flowchart: stage subgraphs (the layered look), per-status node classes,
// and each edge labelled with the file that flows along it. Pure text from buildModel()'s output —
// no new dependency. Render it however you like (mmdc, mermaid.live, mermaid2term, an MD preview).
export function runToMermaid(model) {
  const m = model;
  const order = m.stages.flatMap((st) => st.nodeIds);
  const id = (s) => 'n_' + String(s).replace(/[^a-zA-Z0-9_]/g, '_');
  const esc = (s) => String(s ?? '').replace(/["\n]/g, ' ').trim();
  const CLASS = { ok: 'ok', done: 'ok', running: 'run', error: 'err', failed: 'err', blocked: 'warn', gap: 'warn', reused: 'reuse', pending: 'pend', dry: 'dry' };
  const out = [
    `%% pi-runner ${esc(m.run?.id || 'run')} — ${m.run?.provider || ''}/${m.run?.model || ''}`,
    'flowchart LR',
    '  classDef ok fill:#0f2a17,stroke:#3fb950,color:#aff5c2;',
    '  classDef run fill:#0d2233,stroke:#58a6ff,color:#cde7ff;',
    '  classDef err fill:#2d1316,stroke:#f85149,color:#ffd0cf;',
    '  classDef warn fill:#2b2410,stroke:#d29922,color:#ffe9b0;',
    '  classDef reuse fill:#1b1b22,stroke:#8b949e,color:#d0d7de;',
    '  classDef pend fill:#1b1b22,stroke:#6e7681,color:#9aa3ad;',
    '  classDef dry fill:#1f1426,stroke:#bc8cff,color:#e7d4ff;',
  ];
  m.stages.forEach((st) => {
    out.push(`  subgraph s${st.index}["stage ${st.index}${st.phase ? ' · ' + esc(st.phase) : ''}"]`);
    out.push('    direction TB');
    for (const nid of st.nodeIds) {
      const n = m.nodes[nid]; if (!n) continue;
      const g = GLYPH[n.status] || '·';
      out.push(`    ${id(nid)}["${g} ${esc(n.label)}"]:::${CLASS[n.status] || 'pend'}`);
    }
    out.push('  end');
  });
  const seen = new Set();
  for (const nid of order) {
    for (const o of (m.nodes[nid]?.io?.outputs || [])) {
      const file = o.rel ? esc(String(o.rel).split('/').pop()) : '';
      for (const tgt of (o.toNodes || [])) {
        const key = `${nid}>${tgt}`; if (seen.has(key)) continue; seen.add(key);
        out.push(`  ${id(nid)} -->${file ? `|${file}|` : ''} ${id(tgt)}`);
      }
    }
  }
  return out.join('\n') + '\n';
}
