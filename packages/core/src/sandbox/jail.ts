// ─────────────────────────────────────────────────────────────────────────────
// jail.ts — the OS DISPATCHER for `--sandbox local`'s kernel filesystem jail.
// `--sandbox local` means "OS-isolated, backend chosen by the OS": this picks the
// seatbelt plan on darwin, the bwrap plan on linux, else null (warn once → bare
// exec, UNSANDBOXED). LocalSandbox.exec calls THIS, not a backend directly, so the
// in-place provider is portable: one call site, the right kernel jail per host.
//
// Both backends return the SAME plan shape — `{file, argv, profilePath?}` — so the
// caller spawns `plan.file` with `plan.argv` and unlinks `plan.profilePath` (only
// seatbelt sets it) uniformly, regardless of which OS backend answered.
//
// The throwaway-temp `SeatbeltSandbox` (the SDK provider) keeps calling
// `seatbeltExecPlan` directly — it is a macOS-only provider and is left unchanged.
// This dispatcher is specifically the in-place `local` kind's portability seam.
// ─────────────────────────────────────────────────────────────────────────────

import { seatbeltExecPlan } from './seatbelt.js';
import { bwrapExecPlan } from './bwrap.js';

/** The unified jail plan both OS backends produce: spawn `file` with `argv`; unlink `profilePath` after
 * the child closes IF set (seatbelt writes a per-exec `.sb`; bwrap writes nothing → undefined). */
export interface JailPlan {
  file: 'sandbox-exec' | 'bwrap';
  argv: string[];
  /** A per-exec temp profile to unlink after the child closes (seatbelt only; absent for bwrap). */
  profilePath?: string;
}

let warnedNoBackend = false;
function warnNoBackendOnce(): void {
  if (warnedNoBackend) return;
  warnedNoBackend = true;
  // eslint-disable-next-line no-console
  console.warn(
    `[jail] --sandbox local has no kernel filesystem jail backend on ${process.platform} ` +
      `(darwin→seatbelt, linux→bwrap) — running UNSANDBOXED. The read/write scope boundary is NOT enforced.`,
  );
}

/**
 * Pick the kernel filesystem jail for this OS and build its exec plan for ONE command.
 *   - darwin → `seatbeltExecPlan` (sandbox-exec + a per-exec SBPL profile),
 *   - linux  → `bwrapExecPlan` (bubblewrap bind-mount argv; itself returns null+warn if bwrap is missing),
 *   - else   → null, warning ONCE (bare exec, UNSANDBOXED).
 * Same `{workdir, readScope, writeScope, profileDir}` opts go to whichever backend answers, so the two
 * jails grant the identical scope (they share `computeScopeRoots`). Returns null ⇒ the caller runs the
 * bare command. NOTE: a null from the linux branch means bwrap is unavailable (bwrapExecPlan already
 * warned its own, more specific message); a null from THIS function's else-branch means an unsupported OS.
 */
export function localJailPlan(
  cmd: string,
  opts: { workdir: string; readScope: string[]; writeScope?: string[]; profileDir: string },
): JailPlan | null {
  switch (process.platform) {
    case 'darwin':
      return seatbeltExecPlan(cmd, opts);
    case 'linux':
      return bwrapExecPlan(cmd, opts);
    default:
      warnNoBackendOnce();
      return null;
  }
}

/** TEST SEAM: reset the no-backend warn-once latch so a dispatch test can assert the warning fires. */
export function __resetJailWarningForTest(): void {
  warnedNoBackend = false;
}
