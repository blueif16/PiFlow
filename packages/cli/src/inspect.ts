// `piflow inspect <templateDir> [nodeId] [--full]` — the per-node RESOLVED view.
//
// Compiles the authored template (`loadTemplate` → `compile`, the same path the runner takes) and prints,
// for one node (or every node if the id is omitted), exactly what that node WILL run with: its compiled
// `sandbox` (provider · workspace · read · write · output — densified by `compile`), its `tools` (the
// authored allow/deny PLUS the registry-RESOLVED `piTools`/excluded via `DefaultToolRegistry().resolve`),
// its declarative `ops` (seed/project/merge/promote), its `io.artifacts`, and the realized prompt (a head
// slice unless `--full`). This REPLACES the hand-rolled inspect script the orchestrator kept re-writing.
//
// PURE rendering over the compiled `Workflow`: it resolves tools through the SAME `DefaultToolRegistry`
// the runner uses, but spawns nothing. A node whose tools miss the catalog still renders — the unresolved
// set is NOTED rather than crashing the view (mirrors `dryRunPlan`). `loadTemplate` is injectable (the
// `run.ts` RunDeps convention) so a test drives it with a spy spec.

import {
  loadTemplate as coreLoadTemplate,
  compile,
  DefaultToolRegistry,
  type WorkflowSpec,
  type NodeSpec,
} from '@piflow/core';

/** Default head-slice length for the realized prompt (overridden by `--full`). */
const PROMPT_SLICE = 600;

/** The injectable seam — default is the real core call; a test passes a spy spec. */
export interface InspectDeps {
  loadTemplate?: (dir: string) => Promise<WorkflowSpec>;
  print?: (line: string) => void;
}

/** The parsed `inspect` argv. First positional = template dir; second (optional) = a node id. */
export interface ParsedInspectArgs {
  templateDir: string;
  /** Restrict to one node; omit ⇒ every node. */
  nodeId?: string;
  /** Print the FULL realized prompt (default: a head slice). */
  full: boolean;
}

/** Parse the flat `inspect` argv → `ParsedInspectArgs`. Positionals: <templateDir> [nodeId]. */
export function parseInspectArgs(argv: string[]): ParsedInspectArgs {
  const out: ParsedInspectArgs = { templateDir: '', full: false };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--full') out.full = true;
    else if (!k.startsWith('-')) positionals.push(k);
  }
  out.templateDir = positionals[0] ?? '';
  out.nodeId = positionals[1];
  return out;
}

/** Indent every line of a (possibly multi-line) value by one block level. */
function indent(s: string, pad = '    '): string {
  return s
    .split('\n')
    .map((l) => pad + l)
    .join('\n');
}

/**
 * Render ONE compiled node's resolved view. PURE: resolves tools via the shared registry but spawns
 * nothing; a catalog miss is NOTED, never thrown. `full` shows the whole prompt, else a head slice.
 */
export function renderNodeInspect(node: NodeSpec, registry: DefaultToolRegistry, full: boolean): string {
  const lines: string[] = [`▸ ${node.id}${node.label && node.label !== node.id ? `  (${node.label})` : ''}`];

  // ── 1. SANDBOX — where it runs (compile-densified). ──
  const sb = node.sandbox;
  lines.push('  sandbox:');
  lines.push(`    provider:  ${sb.provider}`);
  lines.push(`    workspace: ${sb.workspace}`);
  lines.push(`    output:    ${sb.output}`);
  lines.push(`    read:      ${(sb.read ?? []).join(', ') || '(none)'}`);
  lines.push(`    write:     ${(sb.write ?? []).join(', ') || '(none)'}`);

  // ── 2. TOOLS — authored allow/deny + the registry-resolved piTools / excluded. ──
  const sel = node.tools ?? {};
  lines.push('  tools:');
  lines.push(`    allow: ${(sel.allow ?? []).join(', ') || '(default builtin set)'}`);
  lines.push(`    deny:  ${(sel.deny ?? []).join(', ') || '(none)'}`);
  try {
    const r = registry.resolve(sel);
    lines.push(`    resolved piTools: ${r.piTools.join(', ') || '(none)'}`);
    if (r.excludeTools?.length) lines.push(`    excluded:         ${r.excludeTools.join(', ')}`);
    if (r.extension) lines.push(`    extension:        generated (sdk/mcp tools bound via -e)`);
  } catch (e) {
    lines.push(`    resolved: UNRESOLVED (${(e as Error).message})`);
  }

  // ── 3. OPS — the declarative seed/project/merge/promote plumbing. ──
  const ops = node.ops;
  if (ops && (ops.seed?.length || ops.project?.length || ops.merge?.ops?.length || ops.promote?.length)) {
    lines.push('  ops:');
    if (ops.seed?.length) lines.push(`    seed:    ${ops.seed.map((s) => `${s.from} → ${s.to}`).join('; ')}`);
    if (ops.project?.length)
      lines.push(
        `    project: ${ops.project.map((p) => `${Array.isArray(p.from) ? p.from.join('+') : p.from} → ${p.to}`).join('; ')}`,
      );
    if (ops.merge?.ops?.length) lines.push(`    merge:   ${ops.merge.ops.length} op(s)`);
    if (ops.promote?.length)
      lines.push(`    promote: ${ops.promote.map((p) => `${p.from} → ${p.to} (${p.merge ?? 'set'})`).join('; ')}`);
  } else {
    lines.push('  ops:   (none)');
  }

  // ── 4. IO.artifacts — the required outputs that gate success. ──
  const arts = node.io?.artifacts ?? [];
  lines.push(`  io.artifacts: ${arts.map((a) => a.path).join(', ') || '(none)'}`);

  // ── 5. PROMPT — the realized prompt (full or a head slice). ──
  const prompt = node.prompt ?? '';
  const shown = full || prompt.length <= PROMPT_SLICE ? prompt : `${prompt.slice(0, PROMPT_SLICE)}\n  … (${prompt.length - PROMPT_SLICE} more chars; --full for all)`;
  lines.push('  prompt:');
  lines.push(indent(shown, '    '));

  return lines.join('\n');
}

/**
 * Inspect a template: load + compile it, then render the selected node (or all). An unknown `nodeId`
 * THROWS with the valid ids enumerated. `loadTemplate` is injectable; returns the rendered text.
 */
export async function inspectTemplate(parsed: ParsedInspectArgs, deps: InspectDeps = {}): Promise<string> {
  const loadTemplate = deps.loadTemplate ?? coreLoadTemplate;
  const { templateDir } = parsed;
  if (!templateDir) throw new Error('piflow inspect: a template directory is required (piflow inspect <templateDir> [nodeId]).');

  const spec = await loadTemplate(templateDir);
  const wf = compile(spec);
  const registry = new DefaultToolRegistry();
  const validIds = Object.keys(wf.nodes);

  let ids: string[];
  if (parsed.nodeId) {
    if (!wf.nodes[parsed.nodeId]) {
      throw new Error(
        `piflow inspect: no node "${parsed.nodeId}" in this template. Valid ids: ${validIds.join(', ')}`,
      );
    }
    ids = [parsed.nodeId];
  } else {
    ids = validIds;
  }

  const blocks = [
    `inspect "${wf.meta.name}" — ${validIds.length} node(s)${parsed.nodeId ? `, showing ${parsed.nodeId}` : ''}`,
    ...ids.map((id) => renderNodeInspect(wf.nodes[id], registry, parsed.full)),
  ];
  return blocks.join('\n\n');
}

/** `piflow inspect <templateDir> [nodeId] [--full]` — the bin body. */
export async function runInspectCli(argv: string[]): Promise<void> {
  const parsed = parseInspectArgs(argv);
  if (!parsed.templateDir) {
    process.stderr.write('piflow inspect: a template directory is required (piflow inspect <templateDir> [nodeId])\n');
    process.exitCode = 1;
    return;
  }
  try {
    const out = await inspectTemplate(parsed);
    process.stdout.write(out + '\n');
  } catch (e) {
    process.stderr.write(String((e as Error).message ?? e) + '\n');
    process.exitCode = 1;
  }
}
