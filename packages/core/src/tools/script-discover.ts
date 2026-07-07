// DISCOVER/RESOLVE + PREFLIGHT for the `script` tool source (docs/design script-tools) — the third and
// fourth stages of DECLARE (node.json) → DEFINE (tool.json manifest) → DISCOVER/RESOLVE (node start) →
// INJECT (compile.ts + tools/script-tool.ts) → PREFLIGHT (this file, loud).
//
// A `tool:<name>` address in a node's `tools.allow` resolves against a DEFINE-path `tool.json` manifest
// sitting in the tool's dir — EITHER the author's `tools.defs["tool:<name>"]` override (token-resolvable;
// `loadTemplate` fills the template-default when the author omits it) OR, for a hand-built spec with no
// template dir, an author MUST supply `defs` explicitly. These are the ONLY two locations ever searched —
// no convention scanning of product structure.
//
// `discoverScriptTools` is pure resolution (host-fs reads, never throws — it AGGREGATES every violation
// across every declared tool into `issues`, matching the `verifyToolBinding` BindReport shape).
// `preflightScriptTools` is the loud wrapper (the `preflightSkills` aggregate-then-throw pattern) wired at
// the node-lifecycle seam, run BEFORE the bind check (which needs each script tool ALREADY registered).

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ToolEntry, ToolSelection } from '../types.js';
import { resolveTokens, type ResolveCtx } from '../workflow/resolver.js';

/** The address prefix that marks a `tools.allow` entry as a SCRIPT tool (DEFINE-path, not a catalog address). */
export const TOOL_ADDRESS_PREFIX = 'tool:';

/** `exec.timeoutMs` default when the manifest omits it (v1 exec contract). */
export const DEFAULT_SCRIPT_TIMEOUT_MS = 10_000;

/** Is `addr` a `tool:<name>` (SCRIPT source) address? */
export function isScriptToolAddress(addr: string): boolean {
  return addr.startsWith(TOOL_ADDRESS_PREFIX);
}

/** The allow TAIL — the declared tool name after `tool:` — that `tool.json`'s `name` must equal. */
export function scriptToolName(addr: string): string {
  return addr.slice(TOOL_ADDRESS_PREFIX.length);
}

/** The v1 `tool.json` exec contract — `input:"flags"` is the ONLY mode implemented (do not build more). */
export interface ScriptToolExec {
  cmd: string;
  argv: string[];
  input?: 'flags';
  timeoutMs?: number;
}

/** The DEFINE-path manifest a script tool's dir carries (`tool.json`). */
export interface ScriptToolManifest {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  exec: ScriptToolExec;
}

/** The result of DISCOVER/RESOLVE over a node's declared `tool:*` addresses. Never throws. */
export interface ScriptDiscoveryResult {
  /** A `ToolEntry` (source:'script') per successfully-resolved+validated tool, ready to `registry.register()`. */
  entries: ToolEntry[];
  /** One line per violation, across EVERY declared tool (never just the first). Empty ⇒ all clean. */
  issues: string[];
  /**
   * One line per OPTIONAL tool skipped because its resolved dir is absent for this run
   * (`tool:<name> — optional, not present for this run`) — informational, never a violation. The tool is
   * NOT in `entries` (not offered: not on `--tools`, not in the extension).
   */
  notes: string[];
}

/** Structural validation of a `tool.json`'s already-`JSON.parse`d body. Returns issue strings (empty ⇒ valid). */
function validateManifestShape(raw: unknown): string[] {
  const issues: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ['tool.json is not a JSON object'];
  const m = raw as Record<string, unknown>;
  if (typeof m.name !== 'string' || !m.name.trim()) issues.push('tool.json.name must be a non-empty string');
  if (typeof m.description !== 'string' || !m.description.trim()) issues.push('tool.json.description must be a non-empty string');
  if (!m.parameters || typeof m.parameters !== 'object' || Array.isArray(m.parameters)) {
    issues.push('tool.json.parameters must be a JSON-Schema object');
  }
  const exec = m.exec;
  if (!exec || typeof exec !== 'object' || Array.isArray(exec)) {
    issues.push('tool.json.exec must be an object');
    return issues;
  }
  const e = exec as Record<string, unknown>;
  if (typeof e.cmd !== 'string' || !e.cmd.trim()) issues.push('tool.json.exec.cmd must be a non-empty string');
  if (!Array.isArray(e.argv) || e.argv.length === 0 || !e.argv.every((a) => typeof a === 'string')) {
    issues.push('tool.json.exec.argv must be a non-empty array of strings');
  }
  if (e.input !== undefined && e.input !== 'flags') {
    issues.push(`tool.json.exec.input "${String(e.input)}" is not supported (v1 implements ONLY "flags")`);
  }
  if (e.timeoutMs !== undefined && (typeof e.timeoutMs !== 'number' || !(e.timeoutMs > 0))) {
    issues.push('tool.json.exec.timeoutMs must be a positive number');
  }
  return issues;
}

/**
 * DISCOVER/RESOLVE every `tool:<name>` in `tools.allow`: resolve its dir (`tools.defs["tool:<name>"]` —
 * a plain string, or `{ path, optional }` — token-resolved via `resolveCtx`; `loadTemplate` fills the
 * template-default when the author omitted it), read + structurally validate `tool.json`, confirm
 * `manifest.name` equals the allow tail, confirm the `{{toolDir}}`-resolved exec script exists on disk.
 * NEVER throws — every violation across every declared tool is collected into `issues` (the
 * `verifyToolBinding` aggregation shape); a tool with no violation contributes a `ToolEntry`
 * (source:'script', `exec.argv` already `{{toolDir}}`-substituted to absolute paths) ready to
 * `registry.register()`. An OPTIONAL entry whose resolved dir is ABSENT is skipped with a `notes` line
 * instead of an issue — presence-based offering (a PRESENT optional tool gets the full contract; optional
 * forgives absence only). Non-`tool:*` allow entries are ignored entirely.
 */
export function discoverScriptTools(tools: ToolSelection, resolveCtx: ResolveCtx): ScriptDiscoveryResult {
  const entries: ToolEntry[] = [];
  const issues: string[] = [];
  const notes: string[] = [];
  const addrs = (tools.allow ?? []).filter(isScriptToolAddress);

  for (const addr of addrs) {
    const name = scriptToolName(addr);
    const def = tools.defs?.[addr];
    if (!def) {
      issues.push(
        `${addr} — no tools.defs["${addr}"] entry and no template default was resolved ` +
          `(a hand-built WorkflowSpec must declare tools.defs explicitly for a script tool)`,
      );
      continue;
    }

    // Normalize the two defs forms: a plain string = REQUIRED; `{ path, optional }` = presence-based.
    let defRaw: string;
    let optional = false;
    if (typeof def === 'string') {
      defRaw = def;
    } else if (def && typeof def === 'object' && typeof def.path === 'string' && def.path.length > 0) {
      defRaw = def.path;
      optional = def.optional === true;
    } else {
      issues.push(`${addr} — malformed tools.defs entry: expected a string path or { path, optional }`);
      continue;
    }

    // Token-resolve the declared dir; a token that CANNOT resolve (MissingArgError/MissingChannelError)
    // is a per-tool issue like any other resolution violation — this fn NEVER throws (the docstring
    // contract the dry-run preview also leans on). NOT forgiven for an optional entry: optional forgives
    // the dir's ABSENCE, never a defs path that cannot even be resolved (a real wiring error).
    let toolDir: string;
    try {
      toolDir = path.resolve(resolveTokens(defRaw, resolveCtx));
    } catch (e) {
      issues.push(`${addr} — defs path "${defRaw}" failed token resolution: ${(e as Error).message}`);
      continue;
    }
    let isDir = false;
    try {
      isDir = statSync(toolDir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      // OPTIONAL + absent ⇒ presence-based skip: a note, no entry, no issue. The tool is simply not
      // offered for this run's variant. Everything below (a PRESENT tool) is the full required contract.
      if (optional) {
        notes.push(`${addr} — optional, not present for this run`);
        continue;
      }
      issues.push(`${addr} — tool dir not found: ${toolDir}`);
      continue;
    }

    const manifestPath = path.join(toolDir, 'tool.json');
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (e) {
      issues.push(`${addr} — tool.json missing or invalid JSON at ${manifestPath}: ${(e as Error).message}`);
      continue;
    }

    const shapeIssues = validateManifestShape(raw);
    if (shapeIssues.length) {
      issues.push(...shapeIssues.map((i) => `${addr} — ${i}`));
      continue;
    }
    const manifest = raw as ScriptToolManifest;

    if (manifest.name !== name) {
      issues.push(`${addr} — tool.json.name "${manifest.name}" does not match the declared tool name "${name}"`);
      continue;
    }

    const argv = manifest.exec.argv.map((a) => a.split('{{toolDir}}').join(toolDir));
    const scriptPath = argv[0];
    if (!existsSync(scriptPath)) {
      issues.push(`${addr} — exec script not found: ${scriptPath}`);
      continue;
    }

    entries.push({
      address: addr,
      source: 'script',
      piName: manifest.name,
      description: manifest.description,
      parameters: manifest.parameters,
      origin: { kind: 'native' },
      exec: { cmd: manifest.exec.cmd, argv, timeoutMs: manifest.exec.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS },
    });
  }

  return { entries, issues, notes };
}

/**
 * **Preflight check** — fail LOUD before pi is ever spawned (the `preflightSkills` pattern). Runs
 * {@link discoverScriptTools} and, if ANY declared tool has a violation, throws ONE aggregate error
 * listing every violation across every declared tool (never just the first). On success, returns the
 * discovered `ToolEntry[]` ready for the caller to `registry.register()` before the bind check. An
 * OPTIONAL tool absent for this run contributes NO entry and NO violation — its skip is surfaced
 * visibly via `console.warn` (`[script-tool] tool:<name> — optional, not present for this run`; the
 * skill-missing/driver-fit advisory precedent), never an error.
 *
 * Never throws when the node declares no `tool:*` address (an empty `entries` returns silently).
 */
export function preflightScriptTools(tools: ToolSelection, resolveCtx: ResolveCtx): ToolEntry[] {
  const { entries, issues, notes } = discoverScriptTools(tools, resolveCtx);
  for (const n of notes) console.warn(`[script-tool] ${n}`);
  if (issues.length > 0) {
    throw new Error(
      `Script-tool preflight FAILED — the following declared script tool(s) cannot be bound:\n` +
        issues.map((i) => `  - ${i}`).join('\n'),
    );
  }
  return entries;
}
