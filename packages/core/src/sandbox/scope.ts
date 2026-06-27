// ─────────────────────────────────────────────────────────────────────────────
// SHARED SCOPE POLICY — the single source of truth for "what roots does a node's
// jail grant?", consumed by BOTH OS backends:
//   - seatbelt.ts  renders these roots as SBPL `(subpath …)` allow rules (macOS),
//   - bwrap.ts     renders these roots as `--ro-bind`/`--bind` args        (Linux).
// Same roots, two renderers. This file owns the POLICY (which dirs are readable,
// which are writable, and the toolchain auto-grants a node+pi need to even boot);
// each backend owns only the SYNTAX for its kernel. Extracting it here means a
// scope fix (a new version-manager root, a new home-scratch dir) lands ONCE and
// both OSes agree by construction — no drift between the macOS jail and the Linux
// jail, which would otherwise be two hand-maintained lists.
//
// Why these specific roots: a profile that passes a static demo can still EPERM
// on the FIRST real toolchain call — `pi` is a node CLI that reads its own
// interpreter, resolves node_modules, and scratches in $TMPDIR/~/.npm. The auto-
// grants below are exactly run.mjs buildSandboxProfile's reduction of "what a
// node+toolchain needs" down to {workdir, its node_modules, the host cwd's
// node_modules, the node binary dir + install prefix, the version-manager roots}.
// The SYSTEM roots (/usr,/bin,/lib,…) and the toolchain write-SCRATCH roots
// (/tmp,$TMPDIR,~/.npm,…) are rendered by each backend (the seatbelt template's
// fixed rules; bwrap's systemReadRoots + writeScratchRoots below) since their
// exact path set is OS-specific (/System vs /lib64).
// ─────────────────────────────────────────────────────────────────────────────

import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Expand a path to {itself, its realpath} — the kernel matches the RESOLVED realpath, not the lexical
 * path (true for BOTH Seatbelt's path matching AND bwrap's bind resolution). Granting both means a
 * symlinked root (node_modules, $TMPDIR, a worktree dir) is reachable, AND a model cannot escape via a
 * self-made symlink (the target realpath is what is bound/checked). A non-existent path falls back to
 * just its resolved-absolute form. */
export function expandRealpath(p: string): string[] {
  const a = path.resolve(p);
  try {
    const r = fsSync.realpathSync(a);
    return a === r ? [a] : [a, r];
  } catch {
    return [a];
  }
}

/** The computed scope: the read-roots and write-roots a node's jail grants, BEYOND the OS-fixed system
 * read roots and toolchain write-scratch roots (which each backend renders itself). Both are absolute,
 * realpath-expanded, and de-duped. `readRoots` ⊇ `writeRoots` is NOT guaranteed — a write root must also
 * be readable, so each backend unions writeRoots into its read set when rendering (bwrap binds rw, which
 * is inherently readable; seatbelt's read+write allow blocks are independent and the workdir is in both). */
export interface ScopeRoots {
  /** Dirs the node may READ beyond the system roots: workdir + node_modules + node toolchain + readScope. */
  readRoots: string[];
  /** Dirs the node may WRITE beyond the scratch roots: workdir + the declared writeScope (== owns). */
  writeRoots: string[];
}

/**
 * Compute the read-roots and write-roots for a node's jail from its declared scope + the toolchain auto-
 * grants. This is the SHARED policy `buildSeatbeltProfile` used to inline; both seatbelt (SBPL) and bwrap
 * (bind args) now consume it so the two OS jails grant the EXACT same set.
 *
 * READ auto-grants (added to the declared readScope): the workdir; the workdir's node_modules and the
 * host process cwd's node_modules (the test toolchain / tsc); the node binary's dir and its install
 * prefix (a globally-installed `pi` lives in <prefix>/lib/node_modules); and any version-manager roots
 * present in the environment (fnm/mise/volta/pnpm) since those install node OUTSIDE ~/.nvm.
 *
 * WRITE roots: the workdir (the node's deliverable tree, where it stages out/_pi) UNION the declared
 * writeScope (== owns). The toolchain write-SCRATCH (/tmp, $TMPDIR, ~/.npm, …) is NOT here — it is each
 * backend's fixed scratch set, so a node only gets its OWN write lane here; a write outside {this lane,
 * the backend scratch} EPERMs.
 */
export function computeScopeRoots(opts: {
  workdir: string;
  readScope: string[];
  writeScope?: string[];
}): ScopeRoots {
  const workdir = path.resolve(opts.workdir);
  // The actual node binary + its install prefix. `process.execPath` is whatever node launched the runner;
  // granting its dir is what lets `pi` (a node CLI) boot under the jail regardless of how node was
  // installed. fnm/mise/volta/pnpm install OUTSIDE ~/.nvm, so resolve those manager roots from the env too.
  const nodeBin = path.dirname(process.execPath);
  const nodePrefix = path.dirname(nodeBin);
  const vmRoots = ['NVM_DIR', 'FNM_DIR', 'MISE_DATA_DIR', 'VOLTA_HOME', 'PNPM_HOME']
    .map((k) => process.env[k])
    .filter((v): v is string => !!v);
  const autoRead = [
    workdir, // the node's own working tree (workspace + its out/_pi dirs live under here)
    path.join(workdir, 'node_modules'), // modules must resolve
    path.join(process.cwd(), 'node_modules'), // the host process cwd's modules (test toolchain, tsc)
    nodeBin, // the node binary's dir — pi is a node CLI; it must read its own interpreter
    nodePrefix, // the install prefix (lib/node_modules — a globally-installed `pi` lives here)
    ...vmRoots, // version-manager roots (fnm/mise/volta/pnpm) when node is managed outside ~/.nvm
  ];
  const readRoots = [...new Set([...autoRead, ...opts.readScope].flatMap(expandRealpath))];
  // WRITE: the workdir (recursive — the node's deliverable tree) + the declared writeScope (== owns).
  const writeRoots = [...new Set([workdir, ...(opts.writeScope ?? [])].flatMap(expandRealpath))];
  return { readRoots, writeRoots };
}

/** The user's home dir — used by both backends to derive the home-scratch grants (~/.pi, ~/.npm, …). */
export function homeDir(): string {
  return os.homedir();
}

/** The OS temp dir, trailing-slash-stripped — the canonical toolchain scratch root both backends grant. */
export function tmpDir(): string {
  return os.tmpdir().replace(/\/+$/, '');
}
