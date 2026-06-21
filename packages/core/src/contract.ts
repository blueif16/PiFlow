// The DRIVER-* contract-marker codec. A node's prompt carries machine-readable markers the runner
// reads to learn the node's artifacts / owned paths / read-scope / tools / seeds. Ported from the
// `run.mjs` marker grammar; round-trippable (emit → parse → emit).

import type { NodeSpec, ResolveResult } from './types.js';

/** The structured marker set carried in (or extracted from) a node prompt. */
export interface ContractMarkers {
  artifacts?: string[];
  owns?: string[];
  readScope?: string[];
  tools?: string[];
  excludeTools?: string[];
  seed?: { to: string; from: string }[];
  schema?: { path: string; schema: string }[];
}

const spaceList = (s: string): string[] => s.split(/\s+/).filter(Boolean);
const commaList = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);

function firstValue(prompt: string, key: string): string | null {
  const m = prompt.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
  return m ? m[1].trim() : null;
}
function allValues(prompt: string, key: string): string[] {
  const re = new RegExp(`^${key}:\\s*(.*)$`, 'gm');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt))) out.push(m[1].trim());
  return out;
}
function parseArrow(s: string): { to: string; from: string } | null {
  const m = s.match(/^(.*?)\s*<=\s*(.*)$/);
  return m ? { to: m[1].trim(), from: m[2].trim() } : null;
}

/** Render markers to text (the block appended to a node prompt). */
export function emitMarkers(m: ContractMarkers): string {
  const lines: string[] = [];
  if (m.artifacts?.length) lines.push(`DRIVER-ARTIFACTS: ${m.artifacts.join(' ')}`);
  if (m.owns?.length) lines.push(`DRIVER-OWNS: ${m.owns.join(' ')}`);
  if (m.readScope?.length) lines.push(`DRIVER-READ-SCOPE: ${m.readScope.join(' ')}`);
  if (m.tools?.length) lines.push(`DRIVER-TOOLS: ${m.tools.join(',')}`);
  if (m.excludeTools?.length) lines.push(`DRIVER-EXCLUDE-TOOLS: ${m.excludeTools.join(',')}`);
  for (const s of m.seed ?? []) lines.push(`DRIVER-SEED: ${s.to} <= ${s.from}`);
  for (const s of m.schema ?? []) lines.push(`DRIVER-SCHEMA: ${s.path} <= ${s.schema}`);
  return lines.join('\n');
}

/** Extract markers from a prompt. Inverse of `emitMarkers` for the same set. */
export function parseMarkers(prompt: string): ContractMarkers {
  const out: ContractMarkers = {};
  const arts = firstValue(prompt, 'DRIVER-ARTIFACTS');
  if (arts !== null) out.artifacts = spaceList(arts);
  const owns = firstValue(prompt, 'DRIVER-OWNS');
  if (owns !== null) out.owns = spaceList(owns);
  const rs = firstValue(prompt, 'DRIVER-READ-SCOPE');
  if (rs !== null) out.readScope = spaceList(rs);
  const tools = firstValue(prompt, 'DRIVER-TOOLS');
  if (tools !== null) out.tools = commaList(tools);
  const ex = firstValue(prompt, 'DRIVER-EXCLUDE-TOOLS');
  if (ex !== null) out.excludeTools = commaList(ex);
  const seeds = allValues(prompt, 'DRIVER-SEED')
    .map(parseArrow)
    .filter((x): x is { to: string; from: string } => x !== null);
  if (seeds.length) out.seed = seeds;
  const schemas = allValues(prompt, 'DRIVER-SCHEMA')
    .map(parseArrow)
    .map((a) => (a ? { path: a.to, schema: a.from } : null))
    .filter((x): x is { path: string; schema: string } => x !== null);
  if (schemas.length) out.schema = schemas;
  return out;
}

/** Derive the common markers from a compiled node + its resolved toolset (used by the runner). */
export function markersFromNode(node: NodeSpec, resolved?: ResolveResult): ContractMarkers {
  const m: ContractMarkers = {};
  const arts = node.io.artifacts.map((a) => a.path);
  if (arts.length) m.artifacts = arts;
  const schemas = node.io.artifacts
    .filter((a) => a.schema)
    .map((a) => ({ path: a.path, schema: a.schema as string }));
  if (schemas.length) m.schema = schemas;
  if (node.sandbox.write.length) m.owns = node.sandbox.write;
  if (node.sandbox.read.length) m.readScope = node.sandbox.read;
  if (resolved?.piTools.length) m.tools = resolved.piTools;
  return m;
}
