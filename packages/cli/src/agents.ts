// `piflowctl agents list [--json]` — the init agent's DISCOVER surface over the agentType preset catalog
// (`~/.piflow/agents/`, the same home `defaultAgentsDir()` resolves — PIFLOW_HOME-aware). A THIN renderer
// over @piflow/core's `listAgentPresets`: the CLI never re-parses a preset, it lays out the listing.
//
// `--json` is the machine mode the init agent consumes: a STABLE `{ presets, errors }` envelope where each
// preset carries id · label · skills · tools (+ model/tier when set) — the prompt body is OMITTED (bulky;
// `loadAgentPreset` serves it when a single preset is actually merged). Human mode is a padded table.
// An EMPTY catalog: human mode exits 1 with the materialize hint (blueprint-list parity — the sibling
// catalog verb); --json stays parseable (empty presets, exit 0) so a probing agent never has to scrape.

import { listAgentPresets, defaultAgentsDir, type AgentPreset } from '@piflow/core';

/** Injectable sinks + catalog dir so the verb is testable in-process (no stdout capture / no subprocess). */
export interface AgentsDeps {
  out?: (s: string) => void;
  err?: (s: string) => void;
  dir?: string;
}

/** The stable `--json` row: the preset minus its (bulky) prompt body. */
interface AgentJsonRow {
  id: string;
  label?: string;
  display?: AgentPreset['display'];
  skills?: string[];
  tools?: AgentPreset['tools'];
  model?: string;
  tier?: string;
}

/** One preset's tools summary for the human table: `allow N · deny M`, or `(default)` when unset. */
function toolsSummary(p: AgentPreset): string {
  const allow = p.tools?.allow?.length ?? 0;
  const deny = p.tools?.deny?.length ?? 0;
  if (!allow && !deny) return '(default)';
  const parts: string[] = [];
  if (allow) parts.push(`allow ${allow}`);
  if (deny) parts.push(`deny ${deny}`);
  return parts.join(' · ');
}

/**
 * `piflowctl agents <list> [--json]`.
 *   • list (or bare) → one row per preset: id · display label · skills · tools summary.
 *   • --json         → `{ presets: [{ id, label, skills, tools, … }], errors }` (prompt omitted).
 * Returns the process exit code (0 = ok). The `deps` sinks default to real stdout/stderr + the real catalog.
 */
export async function runAgentsCli(argv: string[], deps: AgentsDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => void process.stdout.write(s));
  const err = deps.err ?? ((s: string) => void process.stderr.write(s));
  const sub = argv.find((a) => !a.startsWith('-')) ?? 'list';
  const json = argv.includes('--json');

  if (sub !== 'list') {
    err(`piflowctl agents: unknown subcommand '${sub}'.\n  usage: piflowctl agents list [--json]\n`);
    return 1;
  }

  const dir = deps.dir ?? defaultAgentsDir();
  const { presets, errors } = listAgentPresets(dir);

  if (json) {
    const rows: AgentJsonRow[] = presets.map((p) => {
      const row: AgentJsonRow = { id: p.id };
      if (p.display?.label) row.label = p.display.label;
      if (p.display) row.display = p.display;
      if (p.skills) row.skills = p.skills;
      if (p.tools) row.tools = p.tools;
      if (p.model) row.model = p.model;
      if (p.tier) row.tier = p.tier;
      return row;
    });
    out(JSON.stringify({ presets: rows, errors }, null, 2) + '\n');
    return 0;
  }

  if (presets.length === 0 && errors.length === 0) {
    err(
      `piflowctl agents: no agent presets found in ${dir}.\n` +
        `  The catalog isn't materialized yet (piflowctl init seeds it).\n`,
    );
    return 1;
  }

  // Padded table: ID · LABEL · SKILLS · TOOLS.
  const rows = presets.map((p) => [p.id, p.display?.label ?? '', (p.skills ?? []).join(', '), toolsSummary(p)]);
  const header = ['ID', 'LABEL', 'SKILLS', 'TOOLS'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd() + '\n';
  out(line(header));
  for (const r of rows) out(line(r));
  for (const e of errors) err(`piflowctl agents: skipped ${e}\n`); // a bad file is named, never swallowed
  return 0;
}
