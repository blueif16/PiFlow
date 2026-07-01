// `piflowctl optimize --adopt <manifest> [--dry-run] [--backup-dir <d>]` — the physical LAND step (piflow-memory
// -v1.5 §6). The EXPLICIT, opt-in, OUT-OF-LOOP adopt: it reads a staging manifest and drives core's
// adoptFromManifest to overwrite the live file(s) from the candidate copy, backing up first. It loads NO binding,
// calls NO oracle/fixer/model, does no scoring — a pure deterministic REPLAY of a recorded decision (the
// `landed:'adopted'` records the driver already staged). This is the ONLY writer of live files; --fix/--rounds
// stage a manifest and land nothing. "The model proposes/scores; deterministic code decides/bounds/LANDS."
//
// A thin CLI renderer over the core primitive (mirroring optimize-fix.ts): parse → read the manifest JSON → call
// adoptFromManifest → print a one-line summary + a per-file detail block → set process.exitCode (§ exit codes).

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { adoptFromManifest } from '@piflow/core';
import type { AdoptManifest, AdoptReport } from '@piflow/core';

export interface ParsedOptimizeAdoptArgs {
  /** the staging manifest.json to replay (positional). */
  manifest: string;
  /** report what WOULD land without touching any live file or backup. */
  dryRun: boolean;
  /** where the pre-overwrite backups go; default = <dirname(manifest)>/backups (beside the staging record). */
  backupDir?: string;
}

export interface OptimizeAdoptDeps {
  print?: (s: string) => void;
  printErr?: (s: string) => void;
}

export function parseOptimizeAdoptArgs(argv: string[]): ParsedOptimizeAdoptArgs {
  const out: ParsedOptimizeAdoptArgs = { manifest: '', dryRun: false };
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--adopt') continue; // the subcommand marker (the dispatcher already routed on it)
    else if (k === '--dry-run') out.dryRun = true;
    else if (k === '--backup-dir') out.backupDir = argv[++i];
    else if (k.startsWith('--')) { /* ignore unknown flags */ }
    else positionals.push(k);
  }
  out.manifest = positionals[0] ?? '';
  return out;
}

/** A one-line summary + a compact per-file detail block; NOTE the basename-keyed backup collision limitation. */
function renderReport(report: AdoptReport, dryRun: boolean, print: (s: string) => void): void {
  const verb = dryRun ? 'would adopt' : 'adopted';
  print(`optimize --adopt: ${verb} ${report.adopted.length} file(s); ${report.skipped.length} record(s) skipped; ${report.errors.length} error(s).`);
  for (const a of report.adopted) print(`  ${dryRun ? '~' : '+'} ${a.node}/${a.file}${a.backupPath ? ` (backup: ${a.backupPath})` : ''}`);
  for (const s of report.skipped) print(`  · skipped ${s.node}: ${s.reason}`);
  for (const e of report.errors) print(`  ! ${e.node}/${e.file}: ${e.message}`);
  if (report.adopted.length && !dryRun)
    print('  note: backups are basename-keyed (<file>.bak); files with the same basename across dirs collide.');
}

export async function runOptimizeAdoptCli(argv: string[], deps: OptimizeAdoptDeps = {}): Promise<void> {
  const args = parseOptimizeAdoptArgs(argv);
  const print = deps.print ?? ((s: string) => process.stdout.write(s + '\n'));
  const printErr = deps.printErr ?? ((s: string) => process.stderr.write(s + '\n'));

  if (!args.manifest) {
    printErr('piflowctl optimize --adopt: a <manifest> path is required (the staging manifest.json to land).');
    process.exitCode = 2;
    return;
  }

  // Read + parse the manifest. A missing/malformed manifest is a caller error (exit 2), not a crash — landing
  // nothing. The manifest is the round's DURABLE record; --adopt only replays it (no re-scoring, no binding).
  let manifest: AdoptManifest;
  try {
    manifest = JSON.parse(await fs.readFile(args.manifest, 'utf8')) as AdoptManifest;
  } catch (e) {
    printErr(`piflowctl optimize --adopt: could not read manifest '${args.manifest}': ${(e as Error).message}`);
    process.exitCode = 2;
    return;
  }
  if (!Array.isArray(manifest?.records)) {
    printErr(`piflowctl optimize --adopt: '${args.manifest}' is not a staging manifest (no records[]).`);
    process.exitCode = 2;
    return;
  }

  // Default the backups beside the staging record so they travel with it; --backup-dir overrides.
  const backupDir = args.backupDir ?? path.join(path.dirname(path.resolve(args.manifest)), 'backups');
  const report = await adoptFromManifest(manifest, { backupDir, dryRun: args.dryRun });
  renderReport(report, args.dryRun, print);

  // Exit code: 1 if any per-file adopt threw (partial-land is reported, not swallowed); else 0. A skipped record
  // (empty liveRoot / stale dir) is a benign degrade, NOT a failure — a stale manifest must not fail the verb.
  if (report.errors.length) process.exitCode = 1;
}
