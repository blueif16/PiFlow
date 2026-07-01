// `piflowctl schema` — the SELF-DESCRIBING, topic-segmented CLI-syntax reference for authoring a node.
// An authoring agent (Claude Code in any repo) pulls only the slice it needs: `piflowctl schema <topic>`
// → the concise flag grammar for that topic, instead of a front-loaded dump. The bare `piflowctl schema`
// is a one-line-per-topic INDEX. `--json [node|meta|workflow]` is the escape hatch: the formal
// @piflow/core JSON Schema (draft 2020-12) for tooling that wants the machine-readable contract.
//
// THE ANTI-DRIFT LAW (the entire point):
//  1. `CLI_TOPICS` is the SINGLE SOURCE rendered into BOTH `piflowctl schema` AND the add-node `--help`
//     (cli.ts interpolates `renderAddNodeHelp()`), so the help and the reference can NEVER diverge —
//     they are one structure with two projections.
//  2. `--json` re-exports the SDK's OWN frozen schema objects from @piflow/core — never a copy. Change
//     the schema in core and the output changes with it, by construction.

import { nodeSchema, metaSchema, workflowSchema } from '@piflow/core';

/** One topic of the add-node authoring reference: a one-line summary + the concise flag grammar lines. */
export interface CliTopic {
  summary: string;
  lines: string[];
}

// The ordered topic map — the SINGLE SOURCE for the add-node flag reference. Every add-node authoring
// flag belongs to EXACTLY ONE topic (the coverage test bites if one is dropped or duplicated). TIGHT:
// concise grammar + a one-line note + any load-bearing gotcha; this is a quick reference, not prose.
export const CLI_TOPICS = {
  node: {
    summary: 'the node spine — id, phase, edges, write/read contract, return mode',
    lines: [
      '--id <id>                 (required) the node id = its phase label key.',
      '--phase <p>               a decorative phase in the display order.',
      '--dep <id>                an upstream dependency edge (repeatable).',
      '--artifact <p>            an output artifact the node must produce (repeatable).',
      '--owns <glob>             the node\'s exclusive write scope (repeatable; default out/**).',
      '--read <p>                an extra read path beyond {{RUN}} (repeatable; default {{RUN}}).',
      '--return-mode optional|required   whether the node MUST emit a structured return.',
      '--prompt-file <f>         the prompt file under nodes/<id>/ (default prompt.md; never scaffolded).',
      '--programmatic            a no-pi node: omits prompt/tools — its declarative ops ARE the node.',
    ],
  },
  tools: {
    summary: 'the tool surface — allow/deny piTools, injected files, MCP servers',
    lines: [
      '--tool <t>                allow a tool (repeatable; UNION with any preset tools).',
      '--deny <t>                deny a tool (repeatable; deny WINS over allow).',
      '--inject <p>              inject a read-only file into the node context (repeatable).',
      '--mcp <name=url>          wire an MCP server by name=url (repeatable).',
    ],
  },
  agent: {
    summary: 'the base agent — agentType preset, skill, executor backend',
    lines: [
      '--agent-type <id>         adopt a ~/.piflow/agents/<id>.md preset: folds its tools + skill + LABEL.',
      '                          Unknown id ⇒ non-zero exit. Prepend its role-prompt to prompt.md yourself.',
      '--skill <p>               bind a skill (WINS over the agentType\'s skill).',
      '--executor pi|claude-code the node runtime (default pi; claude-code = a headless local Claude).',
    ],
  },
  routing: {
    summary: 'model routing — model/provider/tier pin, timeout, retries',
    lines: [
      '--model <m>               pin a model id (precedence: node.model > tier > --model).',
      '--provider <g>            the pi --provider gateway (e.g. mmgw).',
      '--tier <t>                a model tier alias (fast|balanced|deep) resolved via ~/.piflow.',
      '--timeout <ms>            per-node wall-clock cap.',
      '--retries <n>             plain retry count on a transient failure.',
    ],
  },
  derive: {
    summary: 'declarative data ops — seed (PRE) and project/merge/promote (POST)',
    lines: [
      '--seed <to=from>          (PRE) copy upstream data INTO the node before it runs (repeatable).',
      '--project <to=from[,from2]>   (POST) project named upstream outputs into the node io (repeatable).',
      '--merge-run <cmd[:args][@cwd]>   (POST) a shell DERIVE — runs a command, NO verdict (see checks for the gate).',
      '--promote <from=to[:reducer]>    (POST) promote a node output upward with an optional reducer.',
      '--registry-project <source=,mapRef=,key=>   (POST) project a registry map slice into the node io.',
      'order: seed runs PRE; project → merge → promote run POST.',
    ],
  },
  checks: {
    summary: 'verdict gates — declarative check assertions and the shell gate-run',
    lines: [
      '--check <kind[:path[:severity[:param]]]>      (POST) a declarative assertion (repeatable).',
      '--check-pre <kind[:path[:severity[:param]]]>  (PRE) the same, gating BEFORE the node runs.',
      '  kind=non-empty|json-parses|field-present|count-floor|regex-present|… ; severity=fail|warn;',
      '  param=dotted field | a regex | a JSON object ({min,path}) — JSON-parsed when it parses.',
      '--on-fail block|warn|stop     verdict on a failed check.',
      '--on-warn block|warn|stop     verdict on a warned check.',
      '--gate-run <cmd[:args][@cwd]> (POST) a shell gate — a NON-ZERO exit BLOCKS the node.',
      '  (distinct from the merge-run derive, which runs a command but carries NO verdict.)',
    ],
  },
  ops: {
    summary: 'the canonical op[] envelope — how inject/hooks/checks lower into it, and its strict shape',
    lines: [
      'op[] is the ONE canonical action envelope. inject / hooks / checks / policy are soft-DEPRECATED',
      'node.json aliases the LOADER lowers into op[] at load; add-node still emits them as sugar.',
      'ALL-OR-NOTHING: authoring a node.json op[] DIRECTLY makes the loader keep it verbatim and lower',
      'NOTHING else — a coexisting inject/hooks would be SILENTLY dropped, so loadTemplate now REJECTS that',
      'combo. Hand-lower each alias into the SAME op[] (the hooks→op[] mapping table lives in the piflow-init',
      'enrich-contract skill reference).',
      'SURVIVORS: checks / policy / return keep their OWN channels (io.checks / io.policy / io.returnSchema),',
      'so they DO coexist with an authored op[] — only inject/hooks must be hand-lowered.',
      'STRICT SHAPE: every node.json object is additionalProperties:false (an unknown key is rejected).',
      'Author rationale goes in the optional `note` field — on the node top-level AND on each op[] entry',
      '(ignored at load; the one comment slot). Nothing else freeform.',
    ],
  },
  control: {
    summary: 'failure control flow — escalate to a stronger model, or reroute upstream',
    lines: [
      '--escalate <tier|model>   on failure, retry on a STRONGER model (→ io.escalate).',
      '--reroute <node[:max]>    on failure, loop back to an upstream node.',
      '  the reroute target MUST be a STRICT ANCESTOR of this node.',
    ],
  },
  judge: {
    summary: 'a different-model judge node — a verdict on this node\'s output',
    lines: [
      '--judge <judgeTier[:threshold]>   materialize a DIFFERENT-model verdict as a real <id>__judge node.',
      '  GOTCHA: write nodes/<id>/judge.md (the rubric prose) FIRST — the CLI inlines it.',
      '  GOTCHA: judgeTier MUST DIFFER from the node tier (a same-model judge is rejected).',
      '--judge-on-fail block|warn|stop|retry|escalate   verdict on a failed judge.',
      '--judge-retry-max <n>             cap the judge-driven retries.',
      '--judge-retry-scope feedback|fix  what a judge retry re-runs.',
    ],
  },
  hitl: {
    summary: 'a human-in-the-loop checkpoint gate (G5)',
    lines: [
      '--checkpoint <confirm|input|select:prompt>   a human gate before the node proceeds.',
      '--checkpoint-choice <v>           an option for a select checkpoint (repeatable).',
      '--checkpoint-default <v>          the default answer.',
      '--checkpoint-headless default|abort   behavior with no human present.',
      '--checkpoint-timeout <ms>         how long to wait for a human.',
    ],
  },
  topology: {
    summary: 'graph expansion — fusion (moa / best-of-n) and inline subworkflows',
    lines: [
      '--fusion <moa|best-of-n>  expand into a fusion panel + judge sub-DAG.',
      '--fusion-n <n>            best-of-n: the number of candidates.',
      '--fusion-panel <model|tier>   a panel member (repeatable).',
      '--fusion-judge <model|tier>   the fusion judge model.',
      '--fusion-obligations      carry the node obligations into each panel member.',
      '--fusion-no-verify        skip the per-candidate verify.',
      '--subworkflow <ref>       inline a sub-template as a sub-DAG.',
    ],
  },
  contract: {
    summary: 'contract refinements — jail-off, fill sentinel, output schema',
    lines: [
      '--full-access             per-node jail OFF (LOCAL sandbox only; agent reads the whole filesystem).',
      '--fill-sentinel <s>       the sentinel the node writes when it has nothing to emit.',
      '--artifact-schema <p>     per-ARTIFACT output validation → contract.schema (emits DRIVER-SCHEMA; checks',
      '                          a declared artifact FILE against a JSON Schema on disk). This is NOT the',
      '                          structured-RETURN handshake — that is the separate node.json top-level `return`',
      '                          field (+ contract.returnMode), which is first-class and NOT deprecated.',
    ],
  },
  commands: {
    summary: 'the top-level command map (not add-node flags)',
    lines: [
      'new <templateDir>         scaffold meta.json + the nodes/ dir.',
      'add-node <templateDir>    emit one schema-valid node.json (these topics\' flags).',
      'extract <templateDir>     free DAG preview (node count + parallel lanes; no model).',
      'run <templateDir>         drive a template run (--dry-run for free).',
      'inspect <templateDir>     per-node RESOLVED view (sandbox · tools · ops · prompt).',
      'init                      interactive setup wizard for ~/.piflow (model tiers + executors).',
      'skills install [dir]      copy the workflow-authoring skills into a repo\'s .claude/skills/.',
    ],
  },
} as const satisfies Record<string, CliTopic>;

export type TopicKey = keyof typeof CLI_TOPICS;

/** The formal JSON Schemas (the `--json` escape hatch) — re-exported from the SDK, never copied. */
const SCHEMAS = {
  node: nodeSchema,
  meta: metaSchema,
  workflow: workflowSchema,
} as const;
type SchemaKey = keyof typeof SCHEMAS;

/** Render the bare INDEX — one `<topic> — <summary>` line per topic, then the next-call hint. NO flags. */
function renderIndex(): string {
  const rows = Object.entries(CLI_TOPICS).map(([key, t]) => `  ${key.padEnd(10)} ${t.summary}`);
  return [
    'piflowctl schema — the add-node authoring reference (pull one topic at a time)',
    '',
    ...rows,
    '',
    'run: piflowctl schema <topic>   ·   add the json flag for the formal JSON Schema escape hatch',
  ].join('\n');
}

/** Render ONE topic page — its summary then its concise flag lines. */
function renderTopic(key: TopicKey): string {
  const t = CLI_TOPICS[key];
  return [`${key} — ${t.summary}`, '', ...t.lines.map((l) => `  ${l}`)].join('\n');
}

/**
 * Render the add-node `--help` BODY from `CLI_TOPICS` — the SINGLE SOURCE shared with `piflowctl schema`.
 * cli.ts interpolates this into the ADD-NODE help section, so the help and the reference cannot diverge.
 */
export function renderAddNodeHelp(): string {
  return Object.keys(CLI_TOPICS)
    .map((key) => renderTopic(key as TopicKey))
    .join('\n\n');
}

/**
 * `piflowctl schema [<topic> | --json [node|meta|workflow]]` — the topic-segmented CLI reference.
 * Sync; writes to process.stdout. Bare = the INDEX. `<topic>` = that topic's page. `--json` = the formal
 * @piflow/core schema (default node). An unknown topic/selector → a clear stderr error + non-zero exit.
 */
export function runSchemaCli(argv: string[]): void {
  // The `--json` escape hatch: print the SDK's OWN schema object (re-export, never a copy).
  if (argv.includes('--json')) {
    const selector = argv.find((a) => !a.startsWith('-')) ?? 'node';
    if (!(selector in SCHEMAS)) {
      process.stderr.write(
        `piflowctl schema --json: unknown schema '${selector}' (valid: ${Object.keys(SCHEMAS).join(' | ')})\n`,
      );
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${JSON.stringify(SCHEMAS[selector as SchemaKey], null, 2)}\n`);
    return;
  }

  const topic = argv.find((a) => !a.startsWith('-'));
  // Bare `piflowctl schema` → the INDEX (no flags front-loaded).
  if (!topic) {
    process.stdout.write(`${renderIndex()}\n`);
    return;
  }
  if (!(topic in CLI_TOPICS)) {
    process.stderr.write(
      `piflowctl schema: unknown topic '${topic}' (valid: ${Object.keys(CLI_TOPICS).join(' | ')})\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${renderTopic(topic as TopicKey)}\n`);
}
