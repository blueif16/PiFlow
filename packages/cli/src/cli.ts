#!/usr/bin/env node
// The `piflowctl` CLI — the docker-style front door to a pi-flow run, over the engine-owned `.pi/` run
// layout. ONE front door: `status` + `watch` are this package; `logs` is re-exported from @piflow/core
// (runLogsCli) so a consumer has a single `piflowctl` bin rather than two.
//
//   piflowctl status <rundir> [--every <s>]   per-node table (id · label · status · verified/total · dur)
//                                          + stage/rollup, read from .pi/run.json (+ .pi/nodes/<id>/io.json)
//   piflowctl watch  <rundir> [--notify]      a silent sentinel — one line when the run finishes / a node
//                                          errors|blocks / a node dead-stalls
//   piflowctl logs   [dir|run] [...]          stream/replay/diagnose a run's per-node event archives (core)
//
// `status`/`watch` are THIN renderers over the shared observability source (@piflow/core/observe):
// `status` lays out a `readRunModel` snapshot, `watch` consumes the `watchRun` live stream. They build
// NO run model of their own — the shared reader VERIFIES artifacts on disk (verified, not trusted).

import { runLogsCli, ensurePiflowHome } from '@piflow/core';
import { runInitCli } from './init/index.js';
import { runNewCli, runAddNodeCli, runMemoryCli } from './scaffold.js';
import { runModelCli } from './model.js';
import { runClaudeCodeCli } from './claude-code.js';
import { runStatusCli } from './status.js';
import { runWatchCli } from './watch.js';
import { runExtractCli } from './extract.js';
import { runSchemaCli, renderAddNodeHelp } from './schema.js';
import { runRunCli } from './run.js';
import { runNodeCli } from './node.js';
import { runInspectCli } from './inspect.js';
import { runTelemetryCli } from './telemetry.js';
import { runOptimizeCli } from './optimize.js';
import { runOptimizeFixCli } from './optimize-fix.js';
import { runOptimizeAdoptCli } from './optimize-adopt.js';
import { runOptimizeLoopCli } from './optimize-loop.js';
import { runGuiCli } from './gui.js';
import { runTuiCli } from './tui.js';
import { runSkillsCli } from './skills.js';
import { runUnderstandCli } from './understand.js';
import { createRequire } from 'node:module';

// CLI version, read from this package's own package.json (always shipped in the tarball; resolved
// relative to the compiled dist/cli.js → ../package.json = the package root).
const VERSION: string = createRequire(import.meta.url)('../package.json').version;

const HELP = `piflowctl — drive + observe a pi-flow run over the .pi/ run layout

USAGE
  piflowctl init                            interactive setup wizard for ~/.piflow (model tiers + optional executors)
  piflowctl new     <templateDir> [flags]   scaffold meta.json + the nodes/ dir (then add-node + Write prose)
  piflowctl add-node <templateDir> --id <id> [flags]  emit one schema-valid node.json (prose is yours)
  piflowctl memory  <scaffold|find|check> <templateDir>  the Leg-A memory verb: scaffold the layer · find
                                            a node's standing lessons + recurrence · check lesson freshness
  piflowctl run     <templateDir> [--run <id>] [flags]  drive a template run (real or --dry-run)
  piflowctl node    <run> <nodeId> --resume [-m "<msg>"]  warm-resume a node's stored pi session (--stop too)
  piflowctl inspect <templateDir> [nodeId] [--full]  per-node RESOLVED view (sandbox · tools · ops · prompt)
  piflowctl extract <templateDir>           free DAG preview (node count + parallel lanes; no model)
  piflowctl schema  [<topic>]               the add-node authoring reference (bare = topic index; --json = JSON Schema)
  piflowctl status  <rundir> [--every <s>]  per-node table + stage/rollup (verified on disk)
  piflowctl watch   <rundir> [--notify]     silent sentinel — one line on done / fail / dead-stall
  piflowctl telemetry <rundir> [nodeId] [--watch] [--verbose] [--json]  agent-facing digest:
                                            verdicts · cost spine · loop signals · anomaly worklist ·
                                            failure-onset root cause. --watch = live stream then record.
  piflowctl optimize <rundir> [--json] [--archetype <n>]  out-of-band Score + Triage of a FINISHED run:
                                            folds Tier-0 (telemetry) × Tier-1 (verify outcome) → the
                                            four-way (LAPSE/SKILL/FUNCTIONALITY/ARCH) worklist. Read-only.
  piflowctl optimize --fix <rundir> --binding <module> [--node <substr>] [--auto-adopt] [--staging-dir <d>]
                                            [--edit-budget n] [--watch] [--watch-json]  drive FIX→GATE with a
                                            PRODUCT binding (oracle/copyScope/fixer); strict-improvement gate on
                                            a candidate copy → STAGES a manifest. --node scopes the worklist to
                                            one node; --watch streams live progress (--watch-json = JSON lines).
  piflowctl optimize --adopt <manifest> [--dry-run] [--backup-dir <d>]  physically LAND a staged manifest's
                                            accepted edits onto the live file(s) — backup-first, the EXPLICIT
                                            out-of-loop adopt (never a side effect of --fix/--rounds; skips
                                            symlinks + degrades a stale record). --dry-run reports without writing.
  piflowctl logs    [dir|run] [options]     stream / replay / diagnose per-node event archives
  piflowctl model   [list | set <tier> <modelId> [--claude] | activate | deactivate]  the model-tier config
  piflowctl claude-code [connect [--token <t>] | status]  OPTIONAL credential for the claude-code executor
  piflowctl gui     [--port <n>] [--no-open]  launch the browser run viewer, scoped to the project at cwd
  piflowctl tui     [<rundir>] [--every <s>]  launch the terminal run viewer, scoped to the project at cwd
  piflowctl skills  install [targetDir] [--force] [--with <id>|--all|--wizard]  install the authoring skills (+ add-ons) into a repo
  piflowctl understand [subsystem] [--check|--rebuild]  how a subsystem works / where to change it (code slices)
  piflowctl --version                       print the piflowctl version

RUN
  <templateDir> an authored template/ dir (meta.json + nodes/*/). Required.
  --dry-run     build + print the realized per-node pi command(s); invoke NO model (free).
  --run <id>    the instance id (keys out/<id>); aliases --id. Required for a live run.
  --arg k=v     a workflow arg → {{arg.k}} (repeatable).
  --workspace <p>  the read-only {{WORKSPACE}} root (skills/templates/registry); default cwd.
  --sandbox <inmemory|local|danger-full-access|daytona>  exec backend. inmemory (default) = no model;
                   local = real in-place pi, read-scope-jailed per node (seatbelt on macOS);
                   danger-full-access = local with the jail OFF (agent reads the whole filesystem);
                   daytona = real pi in a remote CLOUD VM (full isolation). Boots the promoted
                   piflow-node-runtime snapshot by default (env: DAYTONA_API_KEY; override the image with
                   DAYTONA_SNAPSHOT/DAYTONA_IMAGE). A custom gateway's ~/.pi/agent/models.json entry is
                   staged into the VM + its $VAR key forwarded (allowlisted).
  --provider <gw>  the pi --provider gateway (e.g. mmgw).
  --cloud-secret <NAME>  (daytona) extra provider-cred env var to forward into the VM (else derived from
                   --provider / its models.json entry).
  --thinking <v>   reasoning-depth cap → pi --thinking.
  --model <m>      model pin → pi --model.
  --out <dir>      host run dir (= {{RUN}}) — FALLBACK ONLY. A template under .piflow/<wf>/template/
                   ALWAYS uses its canonical .piflow/<wf>/runs/<run>/ home and IGNORES --out (a
                   canonical run is never relocated). Default: canonical home, else out/<run>.
  --from / --until <substr>  resume / truncate the stage window.

NODE
  <run>         a run id (resolved under .piflow/<wf>/runs/<id>) OR a direct path to a run dir.
  <nodeId>      the node to operate on (= its persisted pi session id).
  --resume      CONVERSATIONAL warm-resume of the node's stored pi session (the run persisted it under
                <runDir>/.pi-sessions, keyed by node id). Re-opens the SAME conversation via pi's native
                --session-dir/--session. NOT a runner re-execution (no sandbox/tools/gates re-staging).
  -m / --message "<msg>"  send one headless message into the resumed session; omit for a LIVE session.
                A node with no recorded session (cold inmemory/cloud, or never ran --sandbox local) errors,
                naming the resumable nodes.
  --stop        STOP the run by signalling its controlling process GROUP (SIGTERM→SIGKILL grace). This is a
                per-RUN stop, not just one node: the runner records the run controller's pid in .pi/run.json
                and spawns each node detached in that group. A run with no recorded pid (older run) errors.

INIT
  (no args)     an interactive wizard over ~/.piflow. Core step: your pi provider's model tiers
                (fast/balanced/deep). Optional, gated, skippable step: the Claude Code executor —
                authorize your local Claude coding plan (a 'claude setup-token', or your existing login)
                then map the Claude-side tier models. Writes the SAME config as 'model set' / 'claude-code
                connect'; non-interactive callers (agents/CI) use those granular commands instead.

NEW
  <templateDir> the template dir to create (e.g. .piflow/<wf>/template). Writes meta.json + nodes/.
  --id / --name / --description  meta fields (default id/name = the dir's workflow basename).
  --phase <p>   a decorative phase in the display order (repeatable).
  Emits ONLY config — author each node's prose by Writing nodes/<id>/prompt.md yourself.

ADD-NODE
  <templateDir> the template dir (must hold meta.json). --id <id> is required.
  The authoring flags below render from the SAME CLI_TOPICS source as 'piflowctl schema <topic>'
  (schema.ts), so this help and the topic reference can never diverge. Pull one topic at a time with
  'piflowctl schema <topic>'.

${renderAddNodeHelp()}

  Emits/overwrites node.json from the flags; NEVER touches nodes/<id>/prompt.md (yours to Write).

MEMORY  (the Leg-A per-node memory layer — OPTIMIZER-FACING reference, NEVER prompt-injected into a worker)
  scaffold <templateDir>  seed the memory layer — the template's memory.md (system reconcile summary) +
                each node's memory.md (Leg A: standing behavior + failure lessons) and code-map.md (Leg B:
                Tier-0 OKF slice of the product code it touches). CREATE-IF-ABSENT — never clobbers curated
                files. new/add-node seed these automatically; use this to backfill an older template.
                These files are OPTIMIZER-FACING (the Hermes fixer reads+updates them) — NEVER prompt-injected.
  find <templateDir> [--node <id>] [symptom…]  READ-ONLY: surface a node's standing lessons + cross-run
                RECURRENCE count (root/prevention/[[okf-slice]]) — the LAPSE-vs-SKILL signal the triage/fixer
                reads. --node scopes to one node; a bare <symptom> filters signatures (case-insensitive).
  check <templateDir> [node…] [--strict]  ADVISORY: ride the OKF --check gate through each lesson's
                [[okf-slice]] link and flag the code-shifted / dangling ones. Advisory by default (exit 0);
                --strict makes a code-shifted/dangling lesson a non-zero exit (for a pre-commit hook).

INSPECT
  <templateDir> an authored template/ dir. Compiles it and prints each node's RESOLVED view —
                sandbox (provider/workspace/read/write/output) · tools (allow/deny + resolved
                piTools/excluded) · ops (seed/project/merge/promote) · io.artifacts · the prompt.
  [nodeId]      restrict to one node; omit for all. An unknown id errors with the valid ids.
  --full        print the FULL realized prompt (default: a head slice).

EXTRACT
  <templateDir> an authored template/ dir. Prints stages + parallel lanes. FREE (no model).

SCHEMA  (the self-describing add-node authoring reference — pull one topic at a time)
  (no arg)      a concise INDEX: one '<topic> — <summary>' line per topic, then 'piflowctl schema <topic>'.
  <topic>       that topic's concise flag grammar ONLY (node · tools · agent · routing · derive · checks ·
                control · judge · hitl · topology · contract · commands). Unknown topic ⇒ non-zero exit,
                listing the valid topics. Same CLI_TOPICS source as the ADD-NODE help (can't diverge).
  --json [node|meta|workflow]  the escape hatch: the formal @piflow/core JSON Schema (draft 2020-12,
                default 'node') — re-exported from the SDK, never copied, so it can't drift.

STATUS
  <rundir>      a run dir holding .pi/run.json. Default '.'.
  --every <s>   refresh in place every <s>s (live dashboard); omit for one-shot.

WATCH
  <rundir>      a run dir holding .pi/run.json. Default '.'.
  --notify      best-effort desktop ping on the terminal event.
  --poll <s>    file-source poll interval (default 20).
  --dead-stall <s>  declare a DEAD stall after the run-status stops advancing this long (default 600).

TELEMETRY
  <rundir>      a run dir holding .pi/run.json. Default '.'.
  [nodeId]      scope to one node's full digest; omit for the run rollup + per-node table.
  --watch / -w  live stream (run-start · node-open · anomaly · node-close · run-end), then the record.
  --verbose / -v  also stream per chat/tool call lines (full span tree); default = anomalies + verdicts.
  --json        emit the raw RunDigest (or one node's NodeDigest) for an agent to consume.

MODEL
  list (or bare)            print the tier map (~/.piflow/model-tiers.json) + active + the canonical keys.
  set <tier> <modelId>      map a tier alias → a model id AND set active:true (written atomically). Canonical
                            tiers: fast | balanced | deep; a free product name is allowed (warns, never fails).
  set <tier> <modelId> --claude  map the tier in the PARALLEL claude-code map (Claude ids/aliases:
                            opus|sonnet|haiku|claude-*) — what an --executor claude-code node resolves.
  activate / deactivate     flip whether tier references resolve (precedence: node.model > tier > --model).

CLAUDE-CODE  (OPTIONAL — a node runs on a headless local Claude session via 'node --executor claude-code')
  connect [--token <t>]     persist the subscription OAuth token → ~/.piflow/claude-code.json (chmod 600).
                            Token: --token, else $CLAUDE_CODE_OAUTH_TOKEN. Mint one with: claude setup-token.
  status                    show whether the explicit credential is configured + if the claude CLI is found.
  SKIPPABLE: on macOS an existing 'claude' login is used automatically; the file is the portable layer for
  Linux/cloud. The runner resolves env → ~/.piflow/claude-code.json → local login (runner/claude-executor.ts).

SKILLS
  install [targetDir] [--force]  copy piflow's workflow-authoring skills (piflow-init/start/enhance) into
                            <targetDir>/.claude/skills/ so a fresh Claude Code agent there can compose
                            workflows against the SDK. Default targetDir = cwd. An existing skill dir is
                            kept unless --force. (The skills are bundled in the npm tarball; a source checkout
                            falls back to this repo's canonical .claude/skills.)
      ADD-ONS: the trio always installs; opt in extra skill packs ('understand' = the code slices (Leg B),
      'memory' = per-node memory lessons + recurrence (Leg A)):
      --with <id>           add one add-on (repeatable), e.g. --with understand --with memory.
      --all                 add every add-on.
      --wizard              interactively choose which add-ons to install.
      A chosen set is remembered in <targetDir>/.piflow/skills.json ({ "addons": [...] }); a later bare
      install replays it. No flag + no manifest = the trio ONLY.

UNDERSTAND  (the code-understanding slices — how each subsystem works + where to change it)
  (no arg)      list the covered subsystems (the index).
  <subsystem>   the owning slice: the mental model (Why/how) + the exact path:line anchors to edit + known drift.
                Matches a subsystem name, a file path, or a symbol; ownership beats a bare prose mention.
  --check [key] the drift GATE — blocks only when an anchor's file/symbol moved (HEALTH); an out-of-date
                machine-derived region is advisory. Runs over every slice, or scope to one [key].
  --rebuild [key]  regenerate the slices' machine-derived regions from git + memory + the code index.
  Needs a repo with .agents/okf/ seeded; errors clearly if absent (seeding it is a separate step).

LOGS (from @piflow/core)
  -f --follow · --node <id> · --summary · --raw · --poll <ms>   (see 'piflowctl logs --help' semantics)

TIP
  the command is 'piflowctl' (the bare 'piflow' is taken by the unrelated @arche-sh/piflow). if
  'piflow' is free on your system, alias it:  alias piflow=piflowctl
`;

async function main(): Promise<void> {
  // Lazy first-run bootstrap of ~/.piflow (idempotent + cheap + best-effort): seeds model-tiers.json with the
  // canonical tiers so `model list` always has something to show and tier resolution gives clear errors until
  // configured. A no-op once the home/file exists; never clobbers user values; never fails the command.
  ensurePiflowHome();
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
    case 'init':
      await runInitCli(rest);
      break;
    case 'new':
      await runNewCli(rest);
      break;
    case 'add-node':
      await runAddNodeCli(rest);
      break;
    case 'memory':
      await runMemoryCli(rest);
      break;
    case 'run':
      await runRunCli(rest);
      break;
    case 'node':
      process.exitCode = await runNodeCli(rest);
      break;
    case 'inspect':
      await runInspectCli(rest);
      break;
    case 'extract':
      await runExtractCli(rest);
      break;
    case 'schema':
      runSchemaCli(rest);
      break;
    case 'status':
      await runStatusCli(rest);
      break;
    case 'watch':
      await runWatchCli(rest);
      break;
    case 'telemetry':
      await runTelemetryCli(rest);
      break;
    case 'optimize':
      // `--rounds N` routes to the MULTI-ROUND overlord (autonomous-propose: run→score→fix→memorize per round;
      // the `run` stage is product-side, so N>1 needs a binding that exports `run`). `--fix` routes to the
      // single-shot FIX→GATE→LAND driver (writes a staging manifest). `--adopt` routes to the EXPLICIT,
      // OUT-OF-LOOP physical land (replays a staged manifest onto live files — the ONLY writer of live files;
      // never a side effect of --fix/--rounds). Bare `optimize` is read-only.
      if (rest.includes('--rounds')) await runOptimizeLoopCli(rest);
      else if (rest.includes('--adopt')) await runOptimizeAdoptCli(rest);
      else if (rest.includes('--fix')) await runOptimizeFixCli(rest);
      else await runOptimizeCli(rest);
      break;
    case 'logs':
      await runLogsCli(rest);
      break;
    case 'model':
      await runModelCli(rest);
      break;
    case 'claude-code':
      await runClaudeCodeCli(rest);
      break;
    case 'gui':
      await runGuiCli(rest);
      break;
    case 'tui':
      await runTuiCli(rest);
      break;
    case 'skills':
      await runSkillsCli(rest);
      break;
    case 'understand':
      await runUnderstandCli(rest);
      break;
    case '--version':
    case '-v':
    case '-V':
      process.stdout.write(`${VERSION}\n`);
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      process.stdout.write(HELP);
      break;
    default:
      process.stderr.write(`piflowctl: unknown command '${sub}'\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e) + '\n');
  process.exitCode = 1;
});
