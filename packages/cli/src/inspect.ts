// `piflowctl inspect <templateDir> [nodeId] [--full]` — the per-node RESOLVED view.
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
  seededRegistry,
  SUBMIT_RESULT_TOOL,
  derivesFromOp,
  runOpsFromOp,
  gatesFromOp,
  type WorkflowSpec,
  type NodeSpec,
  type OpSpec,
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

/** One-line summary of an op[] entry — its lane + whichever body it carries (run/gate/transform/action). */
function fmtOp(o: OpSpec): string {
  const parts: string[] = [o.when ?? 'post'];
  if (o.reads?.length) parts.push(`reads ${o.reads.join(',')}`);
  if (o.writes?.length) parts.push(`writes ${o.writes.join(',')}`);
  if (o.run)
    parts.push(
      'cmd' in o.run ? `run ${o.run.cmd}${o.run.args?.length ? ` ${o.run.args.join(' ')}` : ''}` : `run fn:${o.run.fn}`,
    );
  if (o.gate) parts.push(`gate ${o.gate.kind}${o.gate.path ? ` ${o.gate.path}` : ''}`);
  if (o.transform) parts.push(`transform ${o.transform.kind}`);
  if (o.action) parts.push(`action ${(o.action as { kind?: string }).kind ?? '?'}`);
  if (o.onFailure) parts.push(`[${o.onFailure}]`);
  return parts.join(' · ');
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

  // ── 3. OPS — the declarative seed/project/merge/promote plumbing, read from the canonical `op[]` (the
  // SOLE derive rep; the legacy `node.ops` was retired in U6). `derivesFromOp` reconstructs the per-family
  // executor inputs the run loop consumes — the same view the old `node.ops` field carried. ──
  // ALL THREE op families so a migrated `op:[{run}]` or a gate op is VISIBLE, not a false `ops: (none)`:
  // derive transforms (seed/project/merge/promote), run-family ops, and gate ops (pre/post).
  const d = derivesFromOp(node.op);
  const mergeOpCount = d.merges.reduce((n, m) => n + (m.ops?.length ?? 0), 0);
  const runOps = runOpsFromOp(node.op).runnable;
  const gates = gatesFromOp(node.op);
  const fmtGate = (c: { kind: string; path?: string }): string => `${c.kind}${c.path ? ` ${c.path}` : ''}`;
  if (d.seeds.length || d.projects.length || mergeOpCount || d.promotes.length || runOps.length || gates.pre.length || gates.post.length) {
    lines.push('  ops:');
    if (d.seeds.length) lines.push(`    seed:    ${d.seeds.map((s) => `${s.from} → ${s.to}`).join('; ')}`);
    if (d.projects.length)
      lines.push(
        `    project: ${d.projects.map((p) => `${Array.isArray(p.from) ? p.from.join('+') : p.from} → ${p.to}`).join('; ')}`,
      );
    if (mergeOpCount) lines.push(`    merge:   ${mergeOpCount} op(s)`);
    if (d.promotes.length)
      lines.push(`    promote: ${d.promotes.map((p) => `${p.from} → ${p.to} (${p.merge ?? 'set'})`).join('; ')}`);
    if (runOps.length)
      lines.push(
        `    run:     ${runOps.map((r) => `${r.body.cmd}${r.body.args?.length ? ` ${r.body.args.join(' ')}` : ''} [${r.onFailure ?? 'block'}]`).join('; ')}`,
      );
    if (gates.pre.length) lines.push(`    gate.pre:  ${gates.pre.map(fmtGate).join('; ')}`);
    if (gates.post.length) lines.push(`    gate.post: ${gates.post.map(fmtGate).join('; ')}`);
  } else {
    lines.push('  ops:   (none)');
  }

  // ── 4. IO.artifacts — the required outputs that gate success. ──
  const arts = node.io?.artifacts ?? [];
  lines.push(`  io.artifacts: ${arts.map((a) => a.path).join(', ') || '(none)'}`);

  // ── 5. PROMPT — the realized prompt (full or a head slice). A PROGRAMMATIC node spawns no pi, so it has
  // NO prompt (and thus no DRIVER-* marker tail); printing an empty `prompt:` block reads as "0 markers →
  // not wired". Instead print its resolved `op[]` directly — that IS its declared work. ──
  if (node.programmatic || !node.prompt) {
    const ops = node.op ?? [];
    lines.push(`  op[] (programmatic — no prompt, ${ops.length} op(s)):`);
    if (!ops.length) lines.push('    (no op[] declared)');
    for (const o of ops) lines.push(indent(fmtOp(o), '    '));
  } else {
    const prompt = node.prompt;
    const shown = full || prompt.length <= PROMPT_SLICE ? prompt : `${prompt.slice(0, PROMPT_SLICE)}\n  … (${prompt.length - PROMPT_SLICE} more chars; --full for all)`;
    lines.push('  prompt:');
    lines.push(indent(shown, '    '));
  }

  return lines.join('\n');
}

/**
 * Inspect a template: load + compile it, then render the selected node (or all). An unknown `nodeId`
 * THROWS with the valid ids enumerated. `loadTemplate` is injectable; returns the rendered text.
 */
export async function inspectTemplate(parsed: ParsedInspectArgs, deps: InspectDeps = {}): Promise<string> {
  const loadTemplate = deps.loadTemplate ?? coreLoadTemplate;
  const { templateDir } = parsed;
  if (!templateDir) throw new Error('piflowctl inspect: a template directory is required (piflowctl inspect <templateDir> [nodeId]).');

  const spec = await loadTemplate(templateDir);
  const wf = compile(spec);
  // (G11) Use the SEEDED registry (builtins + the oc.calc:add seed + the community catalog) so the free
  // preview RESOLVES `oc.*`/`mcp.*` selections instead of falsely reporting them UNRESOLVED — it must
  // mirror the registry the canonical run path now assembles (`assembleRunTools`). `seededRegistry()` alone
  // DROPS the first-party `submit_result` (catalog.ts:58), so re-add it (the SAME superset assembleRunTools
  // builds) — else a node declaring `submit_result` falsely reads UNRESOLVED here.
  const registry = seededRegistry([SUBMIT_RESULT_TOOL]);
  const validIds = Object.keys(wf.nodes);

  let ids: string[];
  if (parsed.nodeId) {
    if (!wf.nodes[parsed.nodeId]) {
      throw new Error(
        `piflowctl inspect: no node "${parsed.nodeId}" in this template. Valid ids: ${validIds.join(', ')}`,
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

/** `piflowctl inspect <templateDir> [nodeId] [--full]` — the bin body. */
export async function runInspectCli(argv: string[]): Promise<void> {
  const parsed = parseInspectArgs(argv);
  if (!parsed.templateDir) {
    process.stderr.write('piflowctl inspect: a template directory is required (piflowctl inspect <templateDir> [nodeId])\n');
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
