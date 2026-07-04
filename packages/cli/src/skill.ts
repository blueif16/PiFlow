// `piflowctl skill list|search|add` — the LOCAL skill marketplace surface over the SAME two rings the
// runner stages by (@piflow/core's `skillSearchRoots` ordering: workspace `.agents/skills` → `<piflowHome>/
// skills`). `list`/`search` are THIN renderers over core's `listSkills` (the resolvable catalog, ring-tagged,
// shadow-flagged); `add` is the INSTALLER into the home ring: materialize a source (local dir as-is; git —
// incl. the `owner/repo` GitHub shorthand — via a shallow clone to tmp), locate the skill dir(s) (root
// SKILL.md, else `*/SKILL.md` + `skills/*/SKILL.md`), enforce the agentskills.io rule (frontmatter `name`
// = dir name), copy to `<piflowHome>/skills/<id>/` (never overwriting without `--force`), and record
// provenance in `<dest>/.install.json` { source, sha256, installedAt } — the sha256 is a DETERMINISTIC
// content hash over the bundle's files (sorted relative paths + bytes; `.git`/`.install.json` excluded),
// so the same source always yields the same hash (an integrity anchor, not a timestamp).
//
// `search <q> --remote` is a SECOND, ONLINE lane bolted onto the same verb: it hits remote skill indexes
// (core's `searchRemote` — quality-first defaults, `--source a,b` to pick) instead of the local rings, purely for
// DISCOVERY — every emitted row's `source` feeds this same `add <source>` verbatim. A network/HTTP failure
// there is caught HERE and turned into one clean stderr line (never a stack trace).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  buildSkillIndex,
  classifySkillSource,
  installSkill,
  listSkills,
  type BuildSkillIndexOpts,
  type SkillIndexArtifact,
  type SkillListEntry,
  type SkillSource,
} from '@piflow/core';
import { searchRemote, type RemoteSkillRow, type SearchRemoteOpts } from './skill-remote.js';

// The source classifier + its type moved to @piflow/core (the install-pipeline hoist). Re-export them so
// existing importers (`import { classifySkillSource } from '.../skill.js'`) and tests keep working.
export { classifySkillSource };
export type { SkillSource };

/** Injectable sinks + ring roots so the verb is testable against temp dirs (no real ~/.piflow, no cwd). */
export interface SkillDeps {
  out?: (s: string) => void;
  err?: (s: string) => void;
  /** Ring-0 root (default cwd) — the project whose `.agents/skills` counts as the workspace ring. */
  workspace?: string;
  /** The global home (default `PIFLOW_HOME ?? ~/.piflow`) — ring 1 + the `add` install target. */
  piflowHome?: string;
  /** The `.install.json` `installedAt` stamp (default `new Date().toISOString()`). */
  now?: () => string;
  /** The `search --remote` network seam (default the real `searchRemote`) — inject a fake for zero-net tests. */
  searchRemote?: (q: string, opts?: SearchRemoteOpts) => Promise<RemoteSkillRow[]>;
  /** The `index build` harvest seam (default core's real `buildSkillIndex`) — inject a fake for zero-net tests. */
  buildIndex?: (opts?: BuildSkillIndexOpts) => Promise<SkillIndexArtifact>;
}

const USAGE =
  `usage: piflowctl skill list [--json]\n` +
  `       piflowctl skill search <q> [--remote] [--source <a,b>] [--limit <n>] [--json]\n` +
  `       piflowctl skill add <source> [--skill <name>] [--force]\n` +
  `       piflowctl skill index build [--out <file>]\n`;

/** Render entries as the human table (ID · RING · DESCRIPTION, with shadow/error markers). */
function renderEntries(entries: SkillListEntry[], out: (s: string) => void): void {
  const rows = entries.map((e) => [
    e.id,
    e.ring,
    e.description + (e.shadowed ? ' [shadowed]' : '') + (e.error ? ` [error: ${e.error}]` : ''),
  ]);
  const header = ['ID', 'RING', 'DESCRIPTION'];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd() + '\n';
  out(line(header));
  for (const r of rows) out(line(r));
}

/** Cell truncation for the human table — a remote description/source can run to hundreds of chars
 *  (unlike a local SKILL.md's), so a cell over `max` is clipped with an ellipsis. `--json` stays verbatim. */
function truncateCell(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** Render remote rows as the human table (SLUG · NAME · DESCRIPTION · SOURCE, cells truncated sanely). */
function renderRemoteRows(rows: RemoteSkillRow[], out: (s: string) => void): void {
  const cells = rows.map((r) => [r.slug, r.name, truncateCell(r.description, 60), truncateCell(r.source, 50)]);
  const header = ['SLUG', 'NAME', 'DESCRIPTION', 'SOURCE'];
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  const line = (c: string[]) => c.map((v, i) => v.padEnd(widths[i])).join('  ').trimEnd() + '\n';
  out(line(header));
  for (const c of cells) out(line(c));
}

/** `--name <value>` lookup (the blueprint.ts flag convention). */
function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** The `add` subcommand — a THIN renderer over core's `installSkill` (the shared install pipeline). Parses
 *  the argv flags, delegates materialize→locate→validate→copy→provenance to core, and formats the result
 *  (or the typed error) as the CLI's stdout/stderr + exit code. */
async function runAdd(rest: string[], deps: SkillDeps, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const source = rest.find((a) => !a.startsWith('-'));
  if (!source) {
    err(`piflowctl skill add <source> — a source is required (local dir | git URL | owner/repo).\n${USAGE}`);
    return 1;
  }
  try {
    const r = await installSkill(source, {
      piflowHome: deps.piflowHome,
      pick: flag(rest, 'skill'),
      force: rest.includes('--force'),
      now: deps.now,
    });
    out(`installed ${r.id} → ${r.dest}\n  source ${r.source}\n  sha256 ${r.sha256}\n`);
    return 0;
  } catch (e) {
    err(`piflowctl skill add: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

/**
 * `piflowctl skill <list | search <q> [--remote] | add <source>> [--json] [--limit <n>] [--skill <name>]
 * [--force]`.
 *   • list                → every resolvable bundle across BOTH rings, ring-tagged (+ shadow/error flags).
 *   • search <q>          → the same rows, filtered case-insensitively over id + description (LOCAL rings).
 *   • search <q> --remote → the ONLINE lane: rows from `searchRemote` (skill-remote.ts) instead of the
 *                           local rings — discovery only; each row's `source` feeds `add` verbatim.
 *   • add <src>           → install a bundle into the home ring (see `runAdd`).
 * Returns the process exit code (0 = ok). The `deps` sinks default to real stdout/stderr + cwd + ~/.piflow.
 */
export async function runSkillCli(argv: string[], deps: SkillDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => void process.stdout.write(s));
  const err = deps.err ?? ((s: string) => void process.stderr.write(s));
  const [sub, ...rest] = argv;
  const json = argv.includes('--json');
  const rings = { workspace: deps.workspace ?? process.cwd(), piflowHome: deps.piflowHome };

  switch (sub) {
    case 'list': {
      const entries = await listSkills(rings);
      if (json) out(JSON.stringify(entries, null, 2) + '\n');
      else if (entries.length === 0) {
        err(`piflowctl skill: no skills found (searched ${rings.workspace}/.agents/skills and the home ring).\n`);
      } else renderEntries(entries, out);
      return 0;
    }

    case 'search': {
      const q = rest.find((a) => !a.startsWith('-'));
      if (!q) {
        err(`piflowctl skill search <q> — a query is required.\n${USAGE}`);
        return 1;
      }

      if (rest.includes('--remote')) {
        const opts: SearchRemoteOpts = {};
        const limitRaw = flag(rest, 'limit');
        if (limitRaw !== undefined) {
          const n = Number(limitRaw);
          if (!Number.isInteger(n) || n <= 0) {
            err(`piflowctl skill search --remote: --limit must be a positive integer (got '${limitRaw}').\n`);
            return 1;
          }
          opts.limit = n;
        }
        // `--source a,b` — pick which remote indexes to query (default: core's quality-first order).
        if (rest.includes('--source')) {
          const raw = flag(rest, 'source');
          const sources = raw
            ?.split(',')
            .map((s) => s.trim())
            .filter(Boolean);
          if (!sources?.length || raw?.startsWith('-')) {
            err(`piflowctl skill search --remote: --source requires a comma-separated list of index ids.\n`);
            return 1;
          }
          opts.sources = sources;
        }
        const search = deps.searchRemote ?? searchRemote;
        let rows: RemoteSkillRow[];
        try {
          rows = await search(q, opts);
        } catch (e) {
          err(`piflowctl skill search --remote: ${e instanceof Error ? e.message : String(e)}\n`);
          return 1;
        }
        if (json) out(JSON.stringify(rows, null, 2) + '\n');
        else if (rows.length === 0) out(`no remote skills match '${q}'\n`);
        else renderRemoteRows(rows, out);
        return 0;
      }

      const needle = q.toLowerCase();
      const entries = (await listSkills(rings)).filter(
        (e) => e.id.toLowerCase().includes(needle) || e.description.toLowerCase().includes(needle),
      );
      if (json) out(JSON.stringify(entries, null, 2) + '\n');
      else if (entries.length === 0) out(`no skills match '${q}'\n`);
      else renderEntries(entries, out);
      return 0;
    }

    case 'add':
      return runAdd(rest, deps, out, err);

    // `index build [--out <file>]` — build the BUNDLED marketplace artifact (the compact ranked snapshot
    // the Vercel site publishes at /skills-index.json). Harvest lives in core; this verb writes the file
    // and prints the per-source counts (honest coverage — a degraded lane shows as 0).
    case 'index': {
      if (rest[0] !== 'build') {
        err(`piflowctl skill index build [--out <file>] — 'build' is the only index subcommand.\n${USAGE}`);
        return 1;
      }
      const outFile = path.resolve(flag(rest, 'out') ?? 'skills-index.json');
      const build = deps.buildIndex ?? buildSkillIndex;
      let artifact: SkillIndexArtifact;
      try {
        artifact = await build();
      } catch (e) {
        err(`piflowctl skill index build: ${e instanceof Error ? e.message : String(e)}\n`);
        return 1;
      }
      await fs.mkdir(path.dirname(outFile), { recursive: true });
      await fs.writeFile(outFile, `${JSON.stringify(artifact)}\n`, 'utf8');
      const counts = Object.entries(artifact.sources)
        .map(([id, n]) => `${id} ${n}`)
        .join(' · ');
      out(`built skills-index: ${artifact.docs.length} doc(s) (${counts}) → ${outFile}\n`);
      return 0;
    }

    default:
      err(`piflowctl skill: unknown subcommand '${sub ?? ''}'.\n${USAGE}`);
      return 1;
  }
}
