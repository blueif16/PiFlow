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
// (skill-remote.ts's `searchRemote` — ClaudSkills by default) instead of the local rings, purely for
// DISCOVERY — every emitted row's `source` feeds this same `add <source>` verbatim. A network/HTTP failure
// there is caught HERE and turned into one clean stderr line (never a stack trace).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSkills, parseSkillManifest, type SkillListEntry } from '@piflow/core';
import { searchRemote, type RemoteSkillRow, type SearchRemoteOpts } from './skill-remote.js';

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
}

const USAGE =
  `usage: piflowctl skill list [--json]\n` +
  `       piflowctl skill search <q> [--remote] [--limit <n>] [--json]\n` +
  `       piflowctl skill add <source> [--skill <name>] [--force]\n`;

/** The global piflow home — the SAME resolution core's `skillSearchRoots`/`defaultAgentsDir` use. */
function piflowHomeDir(override?: string): string {
  return override ?? process.env.PIFLOW_HOME ?? path.join(os.homedir(), '.piflow');
}

/** Where a `skill add` source comes from. `none` = nothing resolvable (the caller reports it). */
export type SkillSource = { kind: 'git'; url: string } | { kind: 'local'; dir: string } | { kind: 'none' };

/**
 * Classify an `add` source, PURE apart from one existence stat: a git-shaped ref (`http(s)://`, `git://`,
 * `ssh://`, `file://`, `git@…`, or a `.git` suffix) is git verbatim; an EXISTING local dir is local (checked
 * before the shorthand so a real path always wins); a bare `owner/repo` expands to the GitHub clone URL.
 */
export function classifySkillSource(source: string): SkillSource {
  if (/^(https?|git|ssh|file):\/\//.test(source) || source.startsWith('git@') || source.endsWith('.git')) {
    return { kind: 'git', url: source };
  }
  const dir = path.resolve(source);
  try {
    if (statSync(dir).isDirectory()) return { kind: 'local', dir };
  } catch {
    /* not a local dir — fall through to the shorthand */
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) {
    return { kind: 'git', url: `https://github.com/${source}.git` };
  }
  return { kind: 'none' };
}

/** The repo name a git URL clones as — the root-bundle's dir-name stand-in (the tmp clone dir is random). */
function repoNameFromUrl(url: string): string {
  const tail = url.replace(/\/+$/, '').split(/[/:]/).pop() ?? 'skill';
  return tail.replace(/\.git$/, '');
}

/** One installable skill dir found inside a materialized source. `id` = the dir name (the resolvable token). */
interface Candidate {
  id: string;
  dir: string;
}

/** Locate the skill dir(s): a root SKILL.md wins (id = the source-derived root name); else scan every
 *  direct child dir plus the conventional `skills/` subdir's children for a SKILL.md. Sorted by id. */
async function findCandidates(root: string, rootName: string): Promise<Candidate[]> {
  const hasSkillMd = async (dir: string) =>
    fs.stat(path.join(dir, 'SKILL.md')).then((s) => s.isFile(), () => false);
  if (await hasSkillMd(root)) return [{ id: rootName, dir: root }];

  const out: Candidate[] = [];
  const scan = async (parent: string) => {
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await fs.readdir(parent, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (!d.isDirectory() || d.name === '.git') continue;
      const dir = path.join(parent, d.name);
      if (await hasSkillMd(dir)) out.push({ id: d.name, dir });
    }
  };
  await scan(root);
  await scan(path.join(root, 'skills'));
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

// The SAME frontmatter regex core parses SKILL.md with (skill-manifest.ts / skill-locate.ts).
const FRONTMATTER = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/;

/** The frontmatter `name:` scalar (one wrapping-quote layer stripped); undefined = unparseable manifest. */
function manifestName(raw: string): string | undefined {
  const fm = FRONTMATTER.exec(raw);
  const nm = fm && /^name:[ \t]*(.+)$/m.exec(fm[1]);
  if (!nm) return undefined;
  let n = nm[1].trim();
  if (n.length >= 2 && ((n[0] === '"' && n.endsWith('"')) || (n[0] === "'" && n.endsWith("'")))) n = n.slice(1, -1);
  return n || undefined;
}

/**
 * The DETERMINISTIC bundle hash: sha256 over every file's `relpath NUL bytes NUL`, walked in sorted
 * relative-path order. `.git/**` and the provenance file itself (`.install.json` — its installedAt varies
 * per install) are excluded, so the hash is a pure function of the skill's content.
 */
async function bundleSha256(root: string): Promise<string> {
  const files: string[] = [];
  const walk = async (dir: string) => {
    for (const d of await fs.readdir(dir, { withFileTypes: true })) {
      if (d.name === '.git') continue;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) await walk(p);
      else if (d.isFile() && path.relative(root, p) !== '.install.json') files.push(path.relative(root, p));
    }
  };
  await walk(root);
  files.sort();
  const hash = createHash('sha256');
  for (const rel of files) {
    hash.update(rel);
    hash.update('\0');
    hash.update(await fs.readFile(path.join(root, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

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

/** The `add` subcommand — materialize → locate → validate → copy → provenance. Returns the exit code. */
async function runAdd(rest: string[], deps: SkillDeps, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const source = rest.find((a) => !a.startsWith('-'));
  if (!source) {
    err(`piflowctl skill add <source> — a source is required (local dir | git URL | owner/repo).\n${USAGE}`);
    return 1;
  }
  const pick = flag(rest, 'skill');
  const force = rest.includes('--force');

  const classified = classifySkillSource(source);
  if (classified.kind === 'none') {
    err(`piflowctl skill add: source '${source}' not found (not a local dir, a git URL, or owner/repo).\n`);
    return 1;
  }

  // Materialize: a local dir is used as-is; a git source shallow-clones into a throwaway tmp dir.
  let root: string;
  let rootName: string;
  let tmp: string | undefined;
  if (classified.kind === 'git') {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'piflow-skill-add-'));
    const clone = spawnSync('git', ['clone', '--depth', '1', classified.url, tmp], { encoding: 'utf8' });
    if (clone.status !== 0) {
      rmSync(tmp, { recursive: true, force: true });
      err(`piflowctl skill add: git clone of ${classified.url} failed:\n${clone.stderr || clone.error?.message || ''}\n`);
      return 1;
    }
    root = tmp;
    rootName = repoNameFromUrl(classified.url);
  } else {
    root = classified.dir;
    rootName = path.basename(classified.dir);
  }

  try {
    const candidates = await findCandidates(root, rootName);
    if (candidates.length === 0) {
      err(`piflowctl skill add: no SKILL.md found in '${source}' (looked at the root, */, and skills/*/).\n`);
      return 1;
    }
    let chosen: Candidate | undefined;
    if (pick) {
      chosen = candidates.find((c) => c.id === pick);
      if (!chosen) {
        err(`piflowctl skill add: no candidate skill '${pick}'. candidates: ${candidates.map((c) => c.id).join(', ')}\n`);
        return 1;
      }
    } else if (candidates.length === 1) {
      chosen = candidates[0];
    } else {
      err(
        `piflowctl skill add: '${source}' holds ${candidates.length} candidate skills — pick ONE with --skill <name>:\n` +
          candidates.map((c) => `  ${c.id}\n`).join(''),
      );
      return 1;
    }

    // The agentskills.io rule: the SKILL.md frontmatter `name` must equal the bundle dir name (the
    // resolvable token a node's bare `skill:` ref uses) — a mismatch would install an unresolvable id.
    const raw = await fs.readFile(path.join(chosen.dir, 'SKILL.md'), 'utf8');
    const name = manifestName(raw);
    if (!name) {
      err(`piflowctl skill add: ${chosen.id}/SKILL.md has no parseable frontmatter 'name:'.\n`);
      return 1;
    }
    if (name !== chosen.id) {
      err(
        `piflowctl skill add: frontmatter name '${name}' does not match the dir name '${chosen.id}' ` +
          `(the agentskills.io rule) — rename one so they agree.\n`,
      );
      return 1;
    }

    // Full manifest validation via core's parser — it throws when `requires ⊄ allowed`, and a bundle
    // that can't satisfy its own floor must be refused HERE, not discovered broken at run time.
    try {
      parseSkillManifest(raw, chosen.id);
    } catch (e) {
      err(`piflowctl skill add: ${chosen.id}/SKILL.md manifest is invalid — ${e instanceof Error ? e.message : e}\n`);
      return 1;
    }

    const dest = path.join(piflowHomeDir(deps.piflowHome), 'skills', chosen.id);
    if (existsSync(dest)) {
      if (!force) {
        err(`piflowctl skill add: '${chosen.id}' is already installed at ${dest} — pass --force to replace it.\n`);
        return 1;
      }
      rmSync(dest, { recursive: true, force: true });
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    cpSync(chosen.dir, dest, { recursive: true, filter: (src) => path.basename(src) !== '.git' });

    const sha256 = await bundleSha256(dest);
    const installedAt = deps.now ? deps.now() : new Date().toISOString();
    await fs.writeFile(
      path.join(dest, '.install.json'),
      JSON.stringify({ source, sha256, installedAt }, null, 2) + '\n',
    );
    out(`installed ${chosen.id} → ${dest}\n  source ${source}\n  sha256 ${sha256}\n`);
    return 0;
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
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

    default:
      err(`piflowctl skill: unknown subcommand '${sub ?? ''}'.\n${USAGE}`);
      return 1;
  }
}
