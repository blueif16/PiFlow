// P6 — `piflowctl context migrate <target> <run>`: the one-click UPLOAD (laptop→cloud) / DOWNLOAD
// (cloud→laptop) that switches a RUN between contexts. The SkyPilot managed-jobs model — freeze at a node
// boundary → bundle the durable run-dir → reload on the target → resume via the journal — NOT a live teleport.
//
// It is SYMMETRIC: whichever side is a remote `serve` is driven over the migrate HTTP endpoints
// (freeze/bundle/adopt, @piflow/server); whichever side is local uses the @piflow/core primitives directly.
// So upload and download are ONE orchestration with the local/remote roles swapped:
//
//   1. FREEZE the source at its next node boundary (local requestFreeze / POST …/migrate/<run>/freeze),
//      then WAIT until its run model reports `frozen` (or it already finished — then there's nothing to move).
//   2. BUNDLE the frozen run-dir (local packRunDir / GET …/migrate/<run>/bundle).
//   3. ADOPT on the target (local unpack + spawn a detached resume / POST …/migrate/<run>/adopt), which
//      resumes via the journal — done nodes reused, the tail runs.
//   4. `context use <target>` so the console (CLI + GUI) follows the run to its new home.
//
// The single-writer run.lock lease (core) guarantees the two runners are never live at once: the source
// releases on freeze, the target acquires fresh on resume.

import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  requestFreeze as coreRequestFreeze,
  packRunDir as corePackRunDir,
  unpackRunDir as coreUnpackRunDir,
  readRunModel as coreReadRunModel,
  buildSnapshot,
  loadScopedRegistry,
  type RunModel,
} from '@piflow/core';
import {
  readContexts,
  resolveActive,
  writeContexts,
  useContext,
  LOCAL_BASE_URL,
  type ContextEntry,
} from './context-store.js';

// ── the direction (pure) ─────────────────────────────────────────────────────────────────────────

export type MigrateDirection = 'upload' | 'download' | 'local-to-local' | 'remote-to-remote';

/** Classify a migration by where its endpoints live. UPLOAD = local→remote, DOWNLOAD = remote→local. PURE. */
export function planMigration(sourceLocal: boolean, targetLocal: boolean): MigrateDirection {
  if (sourceLocal && !targetLocal) return 'upload';
  if (!sourceLocal && targetLocal) return 'download';
  return sourceLocal ? 'local-to-local' : 'remote-to-remote';
}

/** A context entry points at the local serve (or is the implicit `local`) ⇒ operate on the filesystem, not HTTP. */
export function isLocalEntry(entry: ContextEntry | undefined): boolean {
  return !entry || entry.baseUrl === LOCAL_BASE_URL;
}

// ── local fleet lookups (resolve a run id / a template on THIS host) ────────────────────────────────

/** A local run's dir + the product/workflow identity used to resume it on a target. */
export interface LocalRunRef {
  runDir: string;
  product: string;
  workflow: string;
  templateDir: string;
  productRoot: string | null;
}

/** Resolve a run id → its dir + product/workflow/template from the LIVE local fleet index (~/.piflow). */
async function resolveLocalRunDefault(run: string): Promise<LocalRunRef | null> {
  const ix = await buildSnapshot(loadScopedRegistry());
  for (const p of ix.products ?? [])
    for (const ns of p.namespaces ?? [])
      for (const t of ns.threads ?? []) {
        if (t.run === run && t.runDir) {
          const templateDir = ns.templatePath ? path.dirname(ns.templatePath) : '';
          return { runDir: t.runDir, product: p.id, workflow: ns.id, templateDir, productRoot: p.root ?? null };
        }
      }
  return null;
}

/** Resolve a product/workflow → its template dir on THIS host (for a local ADOPT target). */
async function resolveLocalTemplateDefault(product: string, workflow?: string): Promise<{ templateDir: string; productRoot: string | null } | null> {
  const ix = await buildSnapshot(loadScopedRegistry());
  const prod = (ix.products ?? []).find((p) => p.id === product);
  if (!prod) return null;
  const nss = prod.namespaces ?? [];
  const ns = workflow ? nss.find((n) => n.id === workflow) : nss[0];
  if (!ns?.templatePath) return null;
  return { templateDir: path.dirname(ns.templatePath), productRoot: prod.root ?? null };
}

// ── injectable seams (real by default; a test swaps them for fakes — no network / spawn) ───────────

export interface MigrateDeps {
  fetchImpl?: typeof fetch;
  requestFreeze?: (runDir: string) => Promise<void>;
  packRunDir?: (runDir: string) => Promise<Buffer>;
  unpackRunDir?: (bundle: Buffer, dest: string) => Promise<string[]>;
  readRunModel?: (runDir: string) => Promise<RunModel>;
  resolveLocalRun?: (run: string) => Promise<LocalRunRef | null>;
  resolveLocalTemplate?: (product: string, workflow?: string) => Promise<{ templateDir: string; productRoot: string | null } | null>;
  /** Fetch a remote source run's model (the SSE snapshot). Default: remote.js `remoteRunModel`. */
  remoteRunModelFn?: (entry: ContextEntry, run: string, opts: { fetchImpl?: typeof fetch }) => Promise<RunModel>;
  /** Spawn the detached local resume runner. Default: `piflowctl run <tpl> --run <id> --sandbox <s>`. */
  spawnResume?: (templateDir: string, run: string, sandbox: string, cwd: string) => void;
  useContextFn?: (target: string) => Promise<void>;
  print?: (s: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

const authHeaders = (token?: string): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});
const base = (entry: ContextEntry): string => entry.baseUrl.replace(/\/$/, '');

/** The default detached local resume — mirrors the server's adopt spawn (crash-durable via the journal). */
function spawnResumeDefault(templateDir: string, run: string, sandbox: string, cwd: string): void {
  const argv = ['run', templateDir, '--run', run, '--sandbox', sandbox];
  // In the built monorepo, `piflowctl` is packages/cli/dist/cli.js; fall back to the bin on PATH.
  const child = spawn('piflowctl', argv, { cwd, detached: true, stdio: 'ignore' });
  child.on('error', () => {
    const alt = spawn(process.execPath, [path.resolve(cwd, 'node_modules/.bin/piflowctl'), ...argv], { cwd, detached: true, stdio: 'ignore' });
    alt.on('error', () => {});
    alt.unref();
  });
  child.unref();
}

// ── the orchestration ──────────────────────────────────────────────────────────────────────────

export interface MigrateOpts {
  target: string;
  run: string;
  /** Override the target template identity (else derived from the source run's product/workflow). */
  product?: string;
  workflow?: string;
  /** The sandbox the resumed run uses on the target. Default `local` (run in the target host). */
  sandbox?: string;
  /** Freeze-wait cap (ms). Default 120s. */
  freezeTimeoutMs?: number;
}

/**
 * Run the migration. Returns the direction taken (for the caller / tests). Throws on any hard failure
 * (unknown context, run not resolvable, the freeze never lands, an HTTP error) — never leaves the run
 * half-moved silently.
 */
export async function migrateRun(opts: MigrateOpts, deps: MigrateDeps = {}): Promise<MigrateDirection> {
  const print = deps.print ?? ((s: string) => process.stdout.write(s + '\n'));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const fetchImpl = deps.fetchImpl ?? fetch;
  const requestFreeze = deps.requestFreeze ?? coreRequestFreeze;
  const packRunDir = deps.packRunDir ?? corePackRunDir;
  const unpackRunDir = deps.unpackRunDir ?? coreUnpackRunDir;
  const readRunModel = deps.readRunModel ?? coreReadRunModel;
  const resolveLocalRun = deps.resolveLocalRun ?? resolveLocalRunDefault;
  const resolveLocalTemplate = deps.resolveLocalTemplate ?? resolveLocalTemplateDefault;
  const spawnResume = deps.spawnResume ?? spawnResumeDefault;
  const remoteRunModelFn = deps.remoteRunModelFn ?? (async (entry: ContextEntry, run: string, o: { fetchImpl?: typeof fetch }) => (await import('./remote.js')).remoteRunModel(entry, run, o));
  const useContextFn = deps.useContextFn ?? (async (t: string) => { await writeContexts(useContext(readContexts(), t)); });

  const file = readContexts();
  const sourceName = resolveActive({});
  if (sourceName === opts.target) throw new Error(`source and target context are both "${opts.target}" — nothing to migrate`);
  const sourceEntry = file.contexts[sourceName];
  const targetEntry = file.contexts[opts.target];
  if (!targetEntry) throw new Error(`unknown target context "${opts.target}" (add it: piflowctl context add ${opts.target} --url <baseUrl>)`);

  const sourceLocal = isLocalEntry(sourceEntry);
  const targetLocal = isLocalEntry(targetEntry);
  const direction = planMigration(sourceLocal, targetLocal);
  const sandbox = opts.sandbox ?? 'local';
  print(`migrate "${opts.run}": ${sourceName} → ${opts.target}  (${direction})`);

  // ── 1. freeze the source + wait until it parks (or has already finished) ───────────────────────
  let localRef: LocalRunRef | null = null;
  if (sourceLocal) {
    localRef = await resolveLocalRun(opts.run);
    if (!localRef) throw new Error(`no local run "${opts.run}" in scope (is it registered in ~/.piflow?)`);
    await requestFreeze(localRef.runDir);
  } else {
    const r = await fetchImpl(`${base(sourceEntry!)}/__piflow/migrate/${encodeURIComponent(opts.run)}/freeze`, {
      method: 'POST', headers: authHeaders(sourceEntry!.token),
    });
    if (!(r as Response).ok) throw new Error(`freeze failed (${(r as Response).status}) on ${sourceName}`);
  }

  const deadline = Date.now() + (opts.freezeTimeoutMs ?? 120_000);
  const modelOf = async (): Promise<RunModel> =>
    sourceLocal ? readRunModel(localRef!.runDir) : remoteRunModelFn(sourceEntry!, opts.run, { fetchImpl });
  print('  waiting for the source to park at a node boundary…');
  for (;;) {
    const m = await modelOf();
    if (m.frozen) break;
    if (m.done) {
      print(`  the run already finished on ${sourceName} (ok=${m.ok}) — nothing to migrate.`);
      return direction;
    }
    if (Date.now() > deadline) throw new Error(`the source run did not freeze within ${(opts.freezeTimeoutMs ?? 120_000) / 1000}s`);
    await sleep(500);
  }
  print('  source parked. bundling the run-dir…');

  // ── 2. bundle the frozen run-dir ───────────────────────────────────────────────────────────────
  let bundle: Buffer;
  if (sourceLocal) {
    bundle = await packRunDir(localRef!.runDir);
  } else {
    const r = await fetchImpl(`${base(sourceEntry!)}/__piflow/migrate/${encodeURIComponent(opts.run)}/bundle`, { headers: authHeaders(sourceEntry!.token) });
    if (!(r as Response).ok) throw new Error(`bundle download failed (${(r as Response).status}) on ${sourceName}`);
    bundle = Buffer.from(await (r as Response).arrayBuffer());
  }
  print(`  bundle ready (${bundle.length} bytes). adopting on ${opts.target}…`);

  // ── the target's template identity (for the resume) ────────────────────────────────────────────
  const product = opts.product ?? localRef?.product ?? opts.workflow ?? opts.run;
  const workflow = opts.workflow ?? localRef?.workflow;

  // ── 3. adopt on the target + resume via the journal ────────────────────────────────────────────
  if (targetLocal) {
    const tpl = await resolveLocalTemplate(product, workflow);
    if (!tpl) throw new Error(`no local template for product "${product}"${workflow ? ` workflow "${workflow}"` : ''} — cannot resume the downloaded run here`);
    // `.piflow/<wf>/template` ⇒ runs live at the sibling `.piflow/<wf>/runs/<id>` (the D9 layout the runner resolves).
    const destRunDir = path.join(path.dirname(tpl.templateDir), 'runs', opts.run);
    await unpackRunDir(bundle, destRunDir);
    spawnResume(tpl.templateDir, opts.run, sandbox, tpl.productRoot ?? process.cwd());
  } else {
    const qs = new URLSearchParams({ sandbox });
    if (opts.product ?? localRef?.product) qs.set('product', product);
    if (workflow) qs.set('workflow', workflow);
    const r = await fetchImpl(`${base(targetEntry)}/__piflow/migrate/${encodeURIComponent(opts.run)}/adopt?${qs.toString()}`, {
      method: 'POST', headers: { 'Content-Type': 'application/gzip', ...authHeaders(targetEntry.token) }, body: bundle,
    });
    if (!(r as Response).ok) {
      const t = await (r as Response).text().catch(() => '');
      throw new Error(`adopt failed (${(r as Response).status}) on ${opts.target}: ${t}`);
    }
  }

  // ── 4. follow the run to its new home ─────────────────────────────────────────────────────────
  await useContextFn(opts.target);
  print(`  ✓ migrated. switched to context "${opts.target}".`);
  print(`  → observe: piflowctl watch ${opts.run} --context ${opts.target}`);
  return direction;
}

/** `piflowctl context migrate <target> <run> [--product p] [--workflow w] [--sandbox s]` — the CLI wrapper. */
export async function runMigrateCli(argv: string[]): Promise<void> {
  const pos: string[] = [];
  const opts: Partial<MigrateOpts> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--product') opts.product = argv[++i];
    else if (a === '--workflow') opts.workflow = argv[++i];
    else if (a === '--sandbox') opts.sandbox = argv[++i];
    else if (a === '--timeout') opts.freezeTimeoutMs = Number(argv[++i]) * 1000;
    else if (!a.startsWith('-')) pos.push(a);
  }
  const [target, run] = pos;
  if (!target || !run) {
    process.stderr.write('usage: piflowctl context migrate <targetContext> <run> [--product p] [--workflow w] [--sandbox s]\n');
    process.exitCode = 1;
    return;
  }
  try {
    await migrateRun({ target, run, ...opts });
  } catch (e) {
    process.stderr.write(`piflowctl context migrate: ${(e as Error).message ?? e}\n`);
    process.exitCode = 1;
  }
}
