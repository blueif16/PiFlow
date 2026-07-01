// `piflowctl blueprint list|show` — the init agent's DISCOVER→UNDERSTAND surface over the graph-level
// blueprint catalog. Blueprints are the graph-level sibling of the agentType presets: parametric DAG
// TOPOLOGIES the init agent stamps into a template. Like a preset (and a skill), each blueprint self-describes
// via YAML frontmatter so the agent can pick one BEFORE composing.
//
// Home resolution is in EXACT PARITY with the presets: blueprints materialize into `~/.piflow/blueprints/`
// exactly as presets do into `~/.piflow/agents/`, so this reuses `@piflow/core`'s `globalDir()` (the same
// `PIFLOW_HOME`-aware helper `defaultAgentsDir` sits on) — one home resolution, hermetic under `PIFLOW_HOME`.
// The global CLI cannot locate the skill dir, so it NEVER reads `references/blueprints/` directly; the seed
// `.md`s are materialized into the home at init.
//
// `list`/`show` are a PURE fs read (no `@piflow/core` change, no scaffold): `list` parses every blueprint's
// frontmatter `id`+`description` and prints one line each (sorted, README/AUTHORING-GUIDE excluded); `show`
// dumps the full recipe `.md` so the agent reads the topology + wiring rule before composing; an unknown id
// exits non-zero surfacing the ACTUAL catalog (never invent a shape). `stamp` composes a blueprint's topology
// into a fresh template — a thin logic gate over the scaffolder's `buildNode` driven by a CODE-SIDE wiring
// rule (blueprint-stamp.ts + blueprint-wiring.ts); `insert` is still a LATER task (a clear placeholder).

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { globalDir } from '@piflow/core';
import { runBlueprintStamp } from './blueprint-stamp.js';
import { runBlueprintInsert } from './blueprint-insert.js';

/** The default home of the materialized blueprint catalog — `<PIFLOW_HOME|~/.piflow>/blueprints/`. Parity
 *  with `defaultAgentsDir()` (`~/.piflow/agents/`); honors `PIFLOW_HOME` via the shared `globalDir()`. */
export function defaultBlueprintsDir(): string {
  return path.join(globalDir(), 'blueprints');
}

/** Non-shape files that live in the blueprints dir but are docs, not stampable topologies — never listed. */
const NON_BLUEPRINT = new Set(['README.md', 'AUTHORING-GUIDE.md']);

/** Strip ONE layer of matching wrapping quotes from a scalar (a quote INSIDE the string survives). Mirrors
 *  `agent-preset.ts`'s `unquote` so a description like `shape for "trigger"` keeps its inner quotes. */
function unquote(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/** A blueprint's machine-readable frontmatter head (the discovery surface). */
export interface BlueprintMeta {
  id: string;
  description: string;
}

/**
 * Parse a blueprint `.md`'s frontmatter head → `{ id, description }`. PURE (string in). Returns null when
 * there is no `---` frontmatter block or no resolvable id (a malformed/non-frontmatter file is skipped from
 * the catalog rather than throwing). Mirrors the preset frontmatter shape: top-level `key: value` scalars.
 */
export function parseBlueprintMeta(raw: string, fallbackId?: string): BlueprintMeta | null {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(raw);
  if (!m) return null;
  let id: string | undefined;
  let description = '';
  for (const rawLine of m[1].split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line.length !== line.trimStart().length) continue; // skip nested (indented) lines — id/description are top-level
    const ci = line.indexOf(':');
    if (ci < 0) continue;
    const key = line.slice(0, ci).trim();
    const val = unquote(line.slice(ci + 1).trim()); // strip ONLY a matched wrapping quote pair
    if (key === 'id') id = val;
    else if (key === 'description') description = val;
  }
  const resolved = id || fallbackId;
  if (!resolved) return null;
  return { id: resolved, description };
}

/** Read + parse every blueprint in `dir` (skipping the non-shape docs), sorted by id. `[]` if the dir is
 *  absent (an un-materialized home — the caller reports it, never throws). */
export function loadBlueprints(dir: string = defaultBlueprintsDir()): BlueprintMeta[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const out: BlueprintMeta[] = [];
  for (const f of files) {
    if (!f.endsWith('.md') || NON_BLUEPRINT.has(f)) continue;
    const meta = parseBlueprintMeta(readFileSync(path.join(dir, f), 'utf8'), f.replace(/\.md$/, ''));
    if (meta) out.push(meta);
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/** Injectable sinks so the verb is testable in-process (no stdout capture / no subprocess). */
export interface BlueprintDeps {
  out?: (s: string) => void;
  err?: (s: string) => void;
  dir?: string;
}

/**
 * `piflowctl blueprint <list|show <id>|stamp|insert>`.
 *   • list        → every blueprint's `id — description` over `~/.piflow/blueprints/` (sorted). Discovery.
 *   • show <id>   → dump the full recipe `.md` (frontmatter + prose). Understanding. Unknown id ⇒ non-zero
 *                   + the available ids (never invent a shape).
 *   • stamp/insert → NOT built in this task — a clear placeholder that exits non-zero (keeps the switch
 *                    extensible for the later stamp/insert task).
 * Returns the process exit code (0 = ok). The `deps` sinks default to real stdout/stderr + the real home.
 */
export async function runBlueprintCli(argv: string[], deps: BlueprintDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => void process.stdout.write(s));
  const err = deps.err ?? ((s: string) => void process.stderr.write(s));
  const dir = deps.dir ?? defaultBlueprintsDir();
  const [subRaw, ...rest] = argv;
  const sub = subRaw ?? 'list';

  switch (sub) {
    case 'list': {
      const blueprints = loadBlueprints(dir);
      if (blueprints.length === 0) {
        err(
          `piflowctl blueprint: no blueprints found in ${dir}.\n` +
            `  The catalog isn't materialized yet (piflowctl init seeds it from the piflow-init skill).\n`,
        );
        return 1;
      }
      for (const b of blueprints) out(`${b.id} — ${b.description}\n`);
      return 0;
    }

    case 'show': {
      const id = rest.find((a) => !a.startsWith('-'));
      const available = loadBlueprints(dir);
      if (!id) {
        err(`piflowctl blueprint show <id> — an id is required.\n`);
        err(`  available: ${available.map((b) => b.id).join(', ') || '(none — run piflowctl init)'}\n`);
        return 1;
      }
      try {
        const body = readFileSync(path.join(dir, `${id}.md`), 'utf8');
        out(body.endsWith('\n') ? body : `${body}\n`);
        return 0;
      } catch {
        err(`piflowctl blueprint show: no blueprint "${id}" (never invent a shape — pick a real one).\n`);
        err(`  available: ${available.map((b) => b.id).join(', ') || '(none — run piflowctl init)'}\n`);
        return 1;
      }
    }

    case 'stamp': {
      // `stamp <id> --plan <plan.json> --into <new-dir>` — compose the whole blueprint into a fresh template.
      const id = rest.find((a) => !a.startsWith('-'));
      const flag = (name: string): string | undefined => {
        const i = rest.indexOf(`--${name}`);
        return i >= 0 ? rest[i + 1] : undefined;
      };
      return runBlueprintStamp(id, flag('plan'), flag('into'), { out, err });
    }

    case 'insert': {
      // `insert <id> --plan <plan.json> --into <existing-dir> --ns <prefix>` — splice a fragment into an
      // existing template (stamp ⊆ insert). --ns may be '' (present with an empty value); flag() returns the
      // value or undefined when the flag is absent, which runBlueprintInsert treats as the empty namespace.
      const id = rest.find((a) => !a.startsWith('-'));
      const flag = (name: string): string | undefined => {
        const i = rest.indexOf(`--${name}`);
        return i >= 0 ? rest[i + 1] : undefined;
      };
      return runBlueprintInsert(id, flag('plan'), flag('into'), flag('ns'), { out, err });
    }

    default:
      err(
        `piflowctl blueprint: unknown subcommand '${sub}'.\n` +
          `  usage: piflowctl blueprint <list | show <id>>\n`,
      );
      return 1;
  }
}
