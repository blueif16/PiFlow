// `piflowctl context` — a kubectl/docker-style switch between named control-plane endpoints (a `local` and any
// number of cloud `serve` targets), persisted in `~/.piflow/contexts.json`. This is how a user points the
// GUI/CLI at a local or a cloud `serve` without re-typing a URL.
//
//   piflowctl context [current]          print the ACTIVE context (after the flag > env > current > local
//                                        ladder) + its baseUrl. Bare `context` behaves like `current`.
//   piflowctl context ls                 list every context (name · baseUrl), the active one marked `*`.
//   piflowctl context use <name>         set the persisted `current` pointer (errors on an unknown name).
//   piflowctl context add <name> --url <baseUrl> [--token <t>]   upsert an endpoint.
//   piflowctl context rm  <name>         remove an endpoint (clears `current` if it was the active one).
//
// The persistence + the resolution ladder live in the PURE `context-store.ts` (unit-tested against a tmp
// `PIFLOW_HOME`); this file is the thin arg-parse + print + exit-code wrapper. Errors → stderr + non-zero exit.

import {
  readContexts,
  writeContexts,
  resolveActive,
  addContext,
  removeContext,
  useContext,
  type ContextsFile,
} from './context-store.js';

/** Print an error to stderr and set a non-zero exit code (CI signal). Returns so callers can `return fail(...)`. */
function fail(msg: string): void {
  process.stderr.write(`piflowctl context: ${msg}\n`);
  process.exitCode = 1;
}

/** Render the `ls` table: each name + baseUrl, the resolved-active one marked `*`. */
function renderList(file: ContextsFile, active: string): string {
  const names = Object.keys(file.contexts).sort((a, b) => a.localeCompare(b));
  const width = Math.max(4, ...names.map((n) => n.length));
  const rows = names.map((n) => {
    const mark = n === active ? '*' : ' ';
    return `${mark} ${n.padEnd(width)}  ${file.contexts[n].baseUrl}`;
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
  process.stdout.write(`${active}  ${entry.baseUrl}\n`);
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
      try {
        await writeContexts(useContext(readContexts(), name));
      } catch (e) {
        return fail(String((e as Error).message ?? e));
      }
      process.stdout.write(`switched to context "${name}"\n`);
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
      return fail(`unknown verb "${verb}". Use: use | ls | add | rm | current | migrate`);
  }
}
