// `piflowctl context` — a kubectl/docker-style switch between named control-plane endpoints (a `local` and any
// number of cloud `serve` targets), persisted in `~/.piflow/contexts.json`. This is how a user points the
// GUI/CLI at a local or a cloud `serve` without re-typing a URL. A context has TWO axes: WHERE the control
// plane runs (`host`) and WHERE its workers run (`worker`) — you mostly switch the whole bundle with `use`.
//
//   piflowctl context [current]          print the ACTIVE context (flag > env > current > local ladder) + host/worker.
//   piflowctl context ls                 list every context (name · baseUrl · [host · worker]), active marked `*`.
//   piflowctl context use <name>         switch the whole bundle; prints the cascaded worker + setup hints.
//   piflowctl context host use <kind>    escape hatch: set just the control plane (local|fly|railway|selfhost|docker).
//   piflowctl context worker use <kind>  escape hatch: set just where nodes run (local|e2b|daytona).
//   piflowctl context add <name> --url <baseUrl> [--token <t>]   upsert an endpoint.
//   piflowctl context rm  <name>         remove an endpoint (clears `current` if it was the active one).
//
// THE CASCADE (context-store.ts): a CLOUD control plane physically can't reach your laptop's local sandbox, so
// the worker cascades off the host — `use local` ⇒ workers local; `use <cloud>` ⇒ workers auto-promote to the
// top set-up cloud sandbox (e2b > daytona). SETUP-ON-MISS: switching to a not-yet-provisioned host or an
// unconfigured worker prints the exact command to set it up rather than a bare error — notably `selfhost` is
// the FREE `piflowctl serve` + Cloudflare quick-tunnel path (`*.trycloudflare.com`, copy into `--public-url`).
//
// The persistence + the resolution ladder + the pure cascade live in `context-store.ts` (unit-tested against a
// tmp `PIFLOW_HOME`); this file is the thin arg-parse + print + exit-code wrapper. Errors → stderr + non-zero exit.

import {
  readContexts,
  writeContexts,
  resolveActive,
  addContext,
  removeContext,
  useContext,
  resolveWorker,
  isCloudEntry,
  isWorkerCompatible,
  configuredWorkers,
  HOST_KINDS,
  WORKER_KINDS,
  CLOUD_WORKERS,
  LOCAL_CONTEXT,
  type ContextsFile,
  type ContextEntry,
  type HostKind,
  type WorkerKind,
} from './context-store.js';

/** Print an error to stderr and set a non-zero exit code (CI signal). Returns so callers can `return fail(...)`. */
function fail(msg: string): void {
  process.stderr.write(`piflowctl context: ${msg}\n`);
  process.exitCode = 1;
}

/** The effective host kind for a context: the explicit `host`, else a cloud/local label inferred from baseUrl. */
function effectiveHost(entry: ContextEntry): HostKind {
  return entry.host ?? (isCloudEntry(entry) ? 'selfhost' : LOCAL_CONTEXT);
}

/** How to PROVISION a control plane of this kind — the setup-on-miss guidance the CLI prints (never a bare error). */
function hostSetupHint(kind: HostKind): string {
  switch (kind) {
    case 'local':
      return 'the laptop plane — just `piflowctl serve` (no provisioning).';
    case 'selfhost':
      // The FREE path the user asked to prompt for: serve + a Cloudflare quick-tunnel for a stable HTTPS URL.
      return 'FREE self-host — `piflowctl cloud up --host selfhost` brings up `piflowctl serve` + a Cloudflare quick-tunnel; copy the printed *.trycloudflare.com URL into `--public-url` and re-run with --execute (no cloud account).';
    case 'railway':
      return 'managed (~$5/mo, first month free) — `railway login`, then `piflowctl cloud up --host railway --execute`.';
    case 'fly':
      return 'managed — `fly auth login`, then `piflowctl cloud up --host fly --execute`.';
    case 'docker':
      return 'generic docker — `piflowctl cloud up --host docker --public-url <your-origin> --execute`.';
  }
}

/** How to set up a cloud worker sandbox — the setup-on-miss guidance for `worker use` / the cascade. */
function workerSetupHint(kind: WorkerKind): string {
  switch (kind) {
    case 'local':
      return 'the local sandbox (seatbelt/bwrap) — no setup.';
    case 'e2b':
      return 'E2B cloud sandbox — set E2B_API_KEY (and `npm i @piflow/e2b`).';
    case 'daytona':
      return 'Daytona cloud sandbox — set DAYTONA_API_KEY (and `npm i @piflow/daytona`).';
  }
}

/** The `[host · worker]` tag for a context row (worker RESOLVED through the cascade against the current env). */
function hostWorkerTag(entry: ContextEntry): string {
  const { worker } = resolveWorker(entry, configuredWorkers(process.env));
  return `[${effectiveHost(entry)} · ${worker}]`;
}

/** Render the `ls` table: each name + baseUrl, the resolved-active one marked `*`. */
function renderList(file: ContextsFile, active: string): string {
  const names = Object.keys(file.contexts).sort((a, b) => a.localeCompare(b));
  const width = Math.max(4, ...names.map((n) => n.length));
  const rows = names.map((n) => {
    const mark = n === active ? '*' : ' ';
    const e = file.contexts[n];
    return `${mark} ${n.padEnd(width)}  ${e.baseUrl}  ${hostWorkerTag(e)}`;
  });
  return rows.join('\n');
}

/** Print the active context (name + baseUrl) after the full ladder; the `current` / bare verb. */
function printCurrent(flagContext?: string): void {
  const file = readContexts();
  const active = resolveActive({ flagContext });
  const entry = file.contexts[active];
  if (!entry) {
    // A flag/env/current names a context that isn't defined — surface it rather than printing a bare name.
    fail(`active context "${active}" is not defined (add it: piflowctl context add ${active} --url <baseUrl>)`);
    return;
  }
  process.stdout.write(`${active}  ${entry.baseUrl}  ${hostWorkerTag(entry)}\n`);
}

export async function runContextCli(argv: string[]): Promise<void> {
  // A leading `--context <name>` (the same flag the run/gui path uses) applies to the read verbs (current/ls).
  let flagContext: string | undefined;
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--context') flagContext = argv[++i];
    else args.push(argv[i]);
  }
  const [verb, ...rest] = args;

  switch (verb) {
    case undefined:
    case 'current':
      printCurrent(flagContext);
      return;

    case 'ls':
    case 'list': {
      const file = readContexts();
      const active = resolveActive({ flagContext });
      process.stdout.write(renderList(file, active) + '\n');
      return;
    }

    case 'use': {
      const [name] = rest;
      if (!name) return fail('usage: piflowctl context use <name>');
      const file = readContexts();
      if (!file.contexts[name]) {
        // SETUP-ON-MISS: a known host KIND you haven't provisioned yet → guide setup instead of a bare error.
        if (HOST_KINDS.includes(name as HostKind) && name !== LOCAL_CONTEXT) {
          process.stdout.write(`no "${name}" context yet — set it up: ${hostSetupHint(name as HostKind)}\n`);
          return;
        }
        return fail(`unknown context "${name}" (known: ${Object.keys(file.contexts).sort().join(', ')})`);
      }
      await writeContexts(useContext(file, name));
      // Print the CASCADED worker + any promotion + setup-on-miss for an unconfigured cloud worker.
      const configured = configuredWorkers(process.env);
      const { worker, promoted } = resolveWorker(file.contexts[name], configured);
      let msg = `switched to context "${name}" — workers → ${worker}`;
      if (promoted) msg += " (promoted: a cloud plane can't drive a local worker)";
      if (worker !== LOCAL_CONTEXT && !configured.has(worker)) msg += `\n  set it up: ${workerSetupHint(worker)}`;
      process.stdout.write(msg + '\n');
      return;
    }

    case 'host': {
      // `context host use <kind>` — escape hatch: set JUST the control plane on the active context.
      const [sub, kind] = rest;
      if (sub !== 'use' || !kind) return fail(`usage: piflowctl context host use <${HOST_KINDS.join('|')}>`);
      if (!HOST_KINDS.includes(kind as HostKind)) return fail(`unknown host "${kind}" (known: ${HOST_KINDS.join(', ')})`);
      const file = readContexts();
      const active = resolveActive({ flagContext });
      const entry = file.contexts[active];
      if (!entry) return fail(`active context "${active}" is not defined (add it: piflowctl context add ${active} --url <baseUrl>)`);
      entry.host = kind as HostKind;
      // If the stored worker is now incompatible (a local worker under a cloud plane), drop it → cascade re-derives.
      if (entry.worker && !isWorkerCompatible(kind as HostKind, entry.worker)) delete entry.worker;
      await writeContexts(file);
      const { worker, promoted } = resolveWorker(entry, configuredWorkers(process.env));
      let msg = `context "${active}" host → ${kind}; workers → ${worker}${promoted ? " (promoted from local)" : ''}`;
      // SETUP-ON-MISS: a cloud host whose endpoint isn't provisioned yet (baseUrl still local/placeholder).
      if (kind !== LOCAL_CONTEXT && !isCloudEntry({ baseUrl: entry.baseUrl })) msg += `\n  set it up: ${hostSetupHint(kind as HostKind)}`;
      process.stdout.write(msg + '\n');
      return;
    }

    case 'worker': {
      // `context worker use <kind>` — escape hatch: set JUST where nodes run on the active context.
      const [sub, kind] = rest;
      if (sub !== 'use' || !kind) return fail(`usage: piflowctl context worker use <${WORKER_KINDS.join('|')}>`);
      if (!WORKER_KINDS.includes(kind as WorkerKind)) return fail(`unknown worker "${kind}" (known: ${WORKER_KINDS.join(', ')})`);
      const file = readContexts();
      const active = resolveActive({ flagContext });
      const entry = file.contexts[active];
      if (!entry) return fail(`active context "${active}" is not defined (add it: piflowctl context add ${active} --url <baseUrl>)`);
      // COMPAT: reject an explicit local worker under a cloud plane (the cascade auto-promotes; an explicit ask errors).
      if (!isWorkerCompatible(effectiveHost(entry), kind as WorkerKind)) {
        return fail(`context "${active}" runs a cloud control plane, which can't reach a "${kind}" worker — pick a cloud worker (${CLOUD_WORKERS.join(' or ')}).`);
      }
      entry.worker = kind as WorkerKind;
      await writeContexts(file);
      let msg = `context "${active}" workers → ${kind}`;
      const configured = configuredWorkers(process.env);
      if (kind !== LOCAL_CONTEXT && !configured.has(kind as WorkerKind)) msg += `\n  set it up: ${workerSetupHint(kind as WorkerKind)}`;
      process.stdout.write(msg + '\n');
      return;
    }

    case 'add': {
      const [name] = rest.filter((a) => !a.startsWith('--'));
      let baseUrl: string | undefined;
      let token: string | undefined;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--url') baseUrl = rest[++i];
        else if (rest[i] === '--token') token = rest[++i];
      }
      if (!name) return fail('usage: piflowctl context add <name> --url <baseUrl> [--token <t>]');
      if (!baseUrl) return fail('usage: piflowctl context add <name> --url <baseUrl> [--token <t>] (--url required)');
      await writeContexts(addContext(readContexts(), name, { baseUrl, token }));
      process.stdout.write(`added context "${name}" -> ${baseUrl}\n`);
      return;
    }

    case 'rm':
    case 'remove': {
      const [name] = rest;
      if (!name) return fail('usage: piflowctl context rm <name>');
      const before = readContexts();
      if (!before.contexts[name]) return fail(`unknown context "${name}"`);
      await writeContexts(removeContext(before, name));
      process.stdout.write(`removed context "${name}"\n`);
      return;
    }

    case 'migrate': {
      // (P6) one-click UPLOAD/DOWNLOAD: move a RUN between contexts (freeze → bundle → adopt → use).
      const { runMigrateCli } = await import('./migrate.js');
      await runMigrateCli(rest);
      return;
    }

    default:
      return fail(`unknown verb "${verb}". Use: use | host use | worker use | ls | add | rm | current | migrate`);
  }
}
