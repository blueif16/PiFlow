// optimize/render.ts — render the triage worklist (Defect[]) into the PROVEN HERMES-ROUTING.md shape
// (v1.5 §7: "the output FORMAT is already proven — reproduce its shape, don't design a new one"). Pure:
// Defect[] + run meta → deterministic markdown string. Writes nothing; no fs, no network, no deps.
//
// The proven shape (see the golden fixture gs01.hermes-routing.golden.md): a `## Routing summary` table
// (one row per defect) followed by a `## Finding N — …` section per defect. We emit the MVP COLUMN SET
// the Defect actually carries (# · Node · Bucket · Symptom · Confidence) — the human doc's richer columns
// (root-phrase, owner, local-vs-promote) are FIXER prose, not projector data, so we never invent them.
// The post-hoc `## Update — fixes applied` trailer is NEVER emitted by the projector (it is hand-appended
// after fixes land) — emitting it would falsely claim work the projector didn't do.
//
// Cells stay single-line: any stray `|` / newline inside a free-text field is neutralized so the table
// (and each in-table symptom cell) parses. Defects render in array order — same input → byte-identical out.

import type { Defect } from './types.js';

export interface RoutingMeta {
  runId: string;
  archetype?: string;
}

/** Collapse a free-text field to a single, table-safe line: strip newlines, escape the column delimiter. */
function cell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}

/** The Symptom cell text — the symptom, plus an inline `(needs signal: …)` hint when the projector defaulted. */
function symptomLine(d: Defect): string {
  return d.needsSignal ? `${d.symptom} (needs signal: ${d.needsSignal})` : d.symptom;
}

/** Render the worklist into the proven HERMES-ROUTING.md markdown (routing table + per-finding sections). */
export function renderRouting(defects: Defect[], meta: RoutingMeta): string {
  const out: string[] = [];

  // 1. Title + run-meta line(s).
  out.push(`# ${meta.runId} — Hermes routing of verify findings`);
  out.push('');
  out.push(
    meta.archetype
      ? `Run \`${meta.runId}\` · archetype \`${meta.archetype}\`.`
      : `Run \`${meta.runId}\`.`,
  );
  out.push('');

  // 2. Routing summary — one table row per defect, MVP columns only (1-based #).
  out.push('## Routing summary');
  out.push('');
  out.push('| # | Node | Bucket | Symptom | Confidence |');
  out.push('|---|------|--------|---------|------------|');
  defects.forEach((d, i) => {
    out.push(`| ${i + 1} | ${cell(d.node)} | ${d.bucket} | ${cell(symptomLine(d))} | ${d.confidence} |`);
  });
  out.push('');

  // 3. One `## Finding N — <symptom>` section per defect, carrying node · bucket · symptom · evidence · confidence.
  defects.forEach((d, i) => {
    out.push(`## Finding ${i + 1} — ${cell(d.symptom)}`);
    out.push('');
    out.push(`- **Node** — \`${d.node}\``);
    out.push(`- **Bucket** — ${d.bucket}`);
    out.push(`- **Symptom** — ${symptomLine(d)}`);
    out.push(`- **Confidence** — ${d.confidence}`);
    out.push('- **Evidence**');
    for (const e of d.evidence) out.push(`  - ${e}`);
    out.push('');
  });

  // 4. NO `## Update` trailer — that post-hoc record is hand-appended after fixes land, never by the projector.
  return out.join('\n');
}
