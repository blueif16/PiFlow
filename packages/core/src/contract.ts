// The DRIVER-* contract-marker codec. A node's prompt carries machine-readable markers the runner
// reads to learn the node's artifacts / owned paths / read-scope / tools / seeds. Ported from the
// `run.mjs` marker grammar; round-trippable (emit → parse → emit).

import type { NodeSpec, ResolveResult, Check, Policy, ReturnMode } from './types.js';

/** The structured marker set carried in (or extracted from) a node prompt. */
export interface ContractMarkers {
  artifacts?: string[];
  owns?: string[];
  readScope?: string[];
  tools?: string[];
  excludeTools?: string[];
  seed?: { to: string; from: string }[];
  schema?: { path: string; schema: string }[];
  /** Declarative integrity checks (detection). Carried base64-on-one-line to hold arbitrary regex/params. */
  checks?: Check[];
  /** Verdict→action policy (consequence). Carried base64-on-one-line. */
  policy?: Policy;
  /** Return-handshake mode override. */
  returnMode?: ReturnMode;
  /** Incompleteness sentinel string (drives the auto completeness check). */
  fillSentinel?: string;
}

const spaceList = (s: string): string[] => s.split(/\s+/).filter(Boolean);
const commaList = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);
// Tools are authored either comma- OR space-separated (emitMarkers writes commas; hand-authored
// workflows + run.mjs's markerPaths use whitespace, like every other DRIVER-* marker). Tokenize on
// BOTH so a space-separated `DRIVER-TOOLS: read write bash` doesn't collapse to one token (which makes
// pi bind only the first tool and treat the rest as positional args — the gate-3 W0 never-write).
const tokenList = (s: string): string[] => s.split(/[\s,]+/).filter(Boolean);

/** Encode a JSON value as base64-on-one-line (collision-free: holds regex/params/spaces). */
const encodeB64 = (v: unknown): string => Buffer.from(JSON.stringify(v), 'utf8').toString('base64');
/** Decode a base64-on-one-line marker; tolerate an inline-JSON value (a hand-authored marker). */
function decodeB64(raw: string): unknown {
  try {
    return JSON.parse(Buffer.from(raw.trim(), 'base64').toString('utf8'));
  } catch {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}

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
  if (m.checks?.length) lines.push(`DRIVER-CHECKS: ${encodeB64(m.checks)}`);
  if (m.policy && Object.keys(m.policy).length) lines.push(`DRIVER-POLICY: ${encodeB64(m.policy)}`);
  if (m.returnMode) lines.push(`DRIVER-RETURN: ${m.returnMode}`);
  if (m.fillSentinel) lines.push(`DRIVER-FILL-SENTINEL: ${m.fillSentinel}`);
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
  if (tools !== null) out.tools = tokenList(tools);
  const ex = firstValue(prompt, 'DRIVER-EXCLUDE-TOOLS');
  if (ex !== null) out.excludeTools = tokenList(ex);
  const seeds = allValues(prompt, 'DRIVER-SEED')
    .map(parseArrow)
    .filter((x): x is { to: string; from: string } => x !== null);
  if (seeds.length) out.seed = seeds;
  const schemas = allValues(prompt, 'DRIVER-SCHEMA')
    .map(parseArrow)
    .map((a) => (a ? { path: a.to, schema: a.from } : null))
    .filter((x): x is { path: string; schema: string } => x !== null);
  if (schemas.length) out.schema = schemas;
  const checksRaw = firstValue(prompt, 'DRIVER-CHECKS');
  if (checksRaw !== null) {
    const c = decodeB64(checksRaw);
    if (Array.isArray(c)) out.checks = c as Check[];
  }
  const policyRaw = firstValue(prompt, 'DRIVER-POLICY');
  if (policyRaw !== null) {
    const p = decodeB64(policyRaw);
    if (p && typeof p === 'object' && !Array.isArray(p)) out.policy = p as Policy;
  }
  const ret = firstValue(prompt, 'DRIVER-RETURN');
  if (ret === 'optional' || ret === 'required') out.returnMode = ret;
  const fill = firstValue(prompt, 'DRIVER-FILL-SENTINEL');
  if (fill !== null) out.fillSentinel = fill;
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
  if (node.io.checks?.length) m.checks = node.io.checks;
  if (node.io.policy && Object.keys(node.io.policy).length) m.policy = node.io.policy;
  if (node.io.returnMode) m.returnMode = node.io.returnMode;
  if (node.io.fillSentinel) m.fillSentinel = node.io.fillSentinel;
  return m;
}
