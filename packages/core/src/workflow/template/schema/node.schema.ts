// JSON Schema (draft 2020-12) for a template `node.json` — the AUTHORED, contract-as-DATA node
// definition (template-format.md §3/§11). This is the AUTHORING shape (the on-disk source of truth a
// future `loadTemplate` parses), NOT the runtime `NodeSpec`/`NodeIO` envelope (types.ts) that the
// compile step DERIVES from it — the field vocabulary here is §3's (`deps`/`contract`/`inject`/…), so
// keep it aligned with the spec doc, not with the runtime types.
//
// Token-bearing fields ({{RUN}}/{{WORKSPACE}}/{{state.*}}) are plain strings — the resolver runs after
// load, so the schema never inspects token syntax.
//
// `additionalProperties: false` at the OBJECT boundaries is deliberate: it is what makes the
// malformed-case test bite. A typo'd key (`own` for `owns`, `dep` for `deps`) must FAIL, not pass
// silently — a loose schema is the bug the validation test exists to catch.

/** The draft-2020-12 JSON Schema object for a template `node.json`. Frozen; import to validate. */
export const nodeSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://piflow.dev/schema/template/node.json',
  title: 'piflow template node.json',
  type: 'object',
  additionalProperties: false,
  // The core of a node: an id, its phase label, its edges, its prompt, and its write/read contract.
  required: ['id', 'phase', 'deps', 'prompt', 'contract'],
  properties: {
    id: { type: 'string', minLength: 1, description: 'Stable node id (slug). Unique within the template.' },
    phase: {
      type: 'string',
      minLength: 1,
      description: 'DECORATIVE display label (§5) — never drives ordering/parallelism (deps + owns do).',
    },
    deps: {
      type: 'array',
      description: 'THE edges — upstream node ids (§3/§5). Empty ⇒ a root. The single source of the DAG.',
      items: { type: 'string', minLength: 1 },
      uniqueItems: true,
    },
    prompt: {
      type: 'object',
      additionalProperties: false,
      required: ['file'],
      properties: {
        file: { type: 'string', minLength: 1, description: 'Prompt-body template file, node-folder-relative (e.g. "prompt.md").' },
        skill: { type: 'string', minLength: 1, description: 'Optional SKILL.md pointer inlined into the realized prompt.' },
      },
    },
    agentType: {
      // (G6) The agent-PRESET label this node adopted. `piflow-init` expands the preset INTO the node's
      // concrete tools/prompt at author time and keeps this as a branding LABEL the GUI keys the icon off
      // (via observe). The runner treats it as opaque. Omitted ⇒ none.
      type: 'string',
      minLength: 1,
      description: 'Agent-preset LABEL (branding) — expanded into tools/prompt at init; GUI icon key. Omitted ⇒ none.',
    },
    tools: {
      type: 'object',
      additionalProperties: false,
      description: 'Per-node tool selection → DRIVER-TOOLS / --exclude-tools. Omitted ⇒ the default builtin set.',
      properties: {
        allow: { type: 'array', items: { type: 'string', minLength: 1 } },
        deny: { type: 'array', items: { type: 'string', minLength: 1 } },
      },
    },
    mcp: {
      // SEPARATE field, same file (§11). Either an inline `servers` map or a `{ ref }` pointer; omitted ⇒ none.
      // Kept permissive (server config is gateway-specific) — additionalProperties allowed INSIDE servers.
      type: 'object',
      description: 'External MCP gateway config (§11). Inline `servers` or a `{ ref }`. Omitted ⇒ none.',
      properties: {
        servers: { type: 'object' },
        ref: { type: 'string', minLength: 1 },
      },
    },
    timeoutMs: {
      // PER-NODE hard wall-clock cap (ms) → `node.sandbox.timeoutMs` (runner.ts). Omitted ⇒ the run-level
      // default (30 min). A heavy producer (e.g. a full-blueprint harden) sets a larger cap; a light node
      // can set a tighter one. This is the per-node override of the otherwise-uniform watchdog.
      type: 'integer',
      minimum: 1000,
      description: 'Per-node hard wall-clock cap (ms). Omitted ⇒ the run-level default (30 min).',
    },
    retries: {
      // PER-NODE retry budget — extra attempts after the first on an error/blocked verdict (a transient
      // model/timeout failure). Each retry is a fresh run. 0/omitted ⇒ one attempt (today's behavior).
      type: 'integer',
      minimum: 0,
      description: 'Per-node retry budget — extra attempts after the first on error/blocked. 0/omitted ⇒ one attempt.',
    },
    model: {
      // PER-NODE model id → `pi --model` (G1 routing). Provider-scoped (the id pi's models.json exposes).
      // Omitted ⇒ tier, else the run-level model, else pi's provider default. Precedence: runner/model-routing.ts.
      type: 'string',
      minLength: 1,
      description: 'Per-node model id → pi --model. Omitted ⇒ tier, else run-level model, else pi default.',
    },
    provider: {
      // PER-NODE provider/gateway → `pi --provider`. Omitted ⇒ auto-resolved from the model (models.json),
      // else the run-level provider, else `cp`. Lets one node hit a different gateway than the rest.
      type: 'string',
      minLength: 1,
      description: 'Per-node provider/gateway → pi --provider. Omitted ⇒ auto from model, else run, else cp.',
    },
    tier: {
      // PER-NODE tier ALIAS → resolved to a model via ~/.piflow/model-tiers.json (when active). The names are
      // FREE DATA (small/medium/large AND/OR fast/balanced/deep — the product owns them); core never enumerates.
      type: 'string',
      minLength: 1,
      description: 'Per-node tier alias → ~/.piflow/model-tiers.json (free-data names). Omitted ⇒ none.',
    },
    inject: {
      // KIND 1 — FORCED reads (§6a): small · always-needed · stable files auto-injected into the prompt.
      type: 'array',
      description: 'KIND 1 forced reads — file paths auto-injected into the prompt (§6a). Must sit inside readScope.',
      items: { type: 'string', minLength: 1 },
      uniqueItems: true,
    },
    contract: {
      type: 'object',
      additionalProperties: false,
      // artifacts / owns / readScope are the CORE; the rest are optional/additive.
      required: ['artifacts', 'owns', 'readScope'],
      properties: {
        artifacts: {
          type: 'array',
          description: 'REQUIRED outputs, {{RUN}}-relative — the driver stat()s them (blocked if missing).',
          items: { type: 'string', minLength: 1 },
        },
        owns: {
          type: 'array',
          description: 'Write-authority globs. Disjoint owns + same deps ⇒ a parallel lane (§5).',
          items: { type: 'string', minLength: 1 },
        },
        readScope: {
          type: 'array',
          description: 'KIND 2 exposed dirs the model explores via `read` + the OS allow-list (§6a).',
          items: { type: 'string', minLength: 1 },
        },
        schema: {
          type: 'string',
          minLength: 1,
          description: 'Optional JSON-Schema path validated off-disk after the node.',
        },
        returnMode: {
          enum: ['optional', 'required'],
          description: 'optional (default when artifacts declared) | required (zero-artifact gate nodes).',
        },
        fillSentinel: {
          // Optional write-first sentinel; `null` is the spec's "off" literal (§3 example).
          type: ['string', 'null'],
          description: 'A sentinel (e.g. "<FILL:") that, if still present, marks an artifact incomplete. null ⇒ off.',
        },
      },
    },
    checks: {
      // DETECTION (§4), ⊥ policy. pre = over staged inputs; post = over produced artifacts.
      type: 'object',
      additionalProperties: false,
      properties: {
        pre: { type: 'array', items: { $ref: '#/$defs/check' } },
        post: { type: 'array', items: { $ref: '#/$defs/check' } },
      },
    },
    policy: {
      // CONSEQUENCE (§4): a non-pass verdict → an action. Keys are the non-pass verdicts.
      type: 'object',
      additionalProperties: false,
      properties: {
        warn: { $ref: '#/$defs/policyAction' },
        fail: { $ref: '#/$defs/policyAction' },
      },
    },
    hooks: {
      // Deterministic driver OPS (§4). Each lane omittable.
      type: 'object',
      additionalProperties: false,
      properties: {
        seed: { type: 'array', items: { $ref: '#/$defs/seedHook' } }, // PRE
        project: { type: 'array', items: { $ref: '#/$defs/derivedHook' } }, // POST derive
        merge: { $ref: '#/$defs/mergeHook' }, // POST merge — the DRIVER-MERGE op set
        promote: { type: 'array', items: { $ref: '#/$defs/promoteHook' } }, // POST → RunState
        registryProject: { $ref: '#/$defs/registryProjectHook' }, // POST derive — projections from a registry record
      },
    },
    return: {
      // Optional JSON-Schema for the node's structured fenced-JSON result. Kept permissive (it IS a schema).
      type: 'object',
      description: "Optional JSON-Schema for the node's structured result (the fenced-JSON tail).",
    },
    checkpoint: {
      // (G5 — HITL) A HUMAN CHECKPOINT on this node: it spawns no `pi`, writes a marker, parks for a reply,
      // validates + journals it. `kind`/`prompt` required; `choices`/`default`/`headless`/`timeoutMs` optional.
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'prompt'],
      description: 'A human checkpoint (G5): pause, ask the human, resume on their reply (or a headless default).',
      properties: {
        kind: { enum: ['confirm', 'input', 'select'], description: 'confirm (yes/no) | input (free text) | select (one of choices).' },
        prompt: { type: 'string', minLength: 1, description: 'The question shown to the human.' },
        choices: { type: 'array', items: { type: 'string', minLength: 1 }, description: 'For select: the allowed values.' },
        default: { description: 'Value taken headlessly (no reply) under headless:default. Any type.' },
        headless: { enum: ['default', 'abort'], description: 'No-reply policy: default (take default, journal it) | abort (error + halt). Default default.' },
        timeoutMs: { type: 'integer', minimum: 0, description: 'Bound on the interactive wait (ms). Omit ⇒ wait while a courier could reply.' },
      },
    },
    fusion: {
      // (Phase 2) Opt this node into the FUSION DAG expansion (spec §4): `expandFusion` turns the node into
      // a JUDGE and spawns N sibling producers upstream, which the existing compiler draws as
      // `deps → (siblings ‖) → judge → successors`. `mode` is the required discriminator; the rest resolve
      // node.fusion.<param> > ~/.piflow/fusion.json > built-in. Twin of the `checkpoint` block above.
      type: 'object',
      additionalProperties: false,
      required: ['mode'],
      description: 'Activate fusion on this node (siblings + judge expansion, spec §4). `mode` required.',
      properties: {
        mode: { enum: ['moa', 'best-of-n'], description: 'moa (panel of models → synthesize) | best-of-n (one model sampled N times → select).' },
        n: { type: 'integer', minimum: 1, description: 'best-of-n sample count (siblings). Omitted ⇒ default 3.' },
        panel: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true, description: 'moa: one sibling per entry (model id or tier alias). Overrides n.' },
        judge: { type: 'string', minLength: 1, description: "Judge model/tier. Omitted ⇒ the node's own resolved model." },
        obligations: { type: 'boolean', description: 'Derive a coverage checklist pre-node the panel + judge consume. Default false.' },
        verify: { type: 'boolean', description: 'Judge verify→revise loop (quality). false ⇒ fast. Default true.' },
      },
    },
    subworkflow: {
      // (G9) Opt this node into the SUB-DAG inlining: `expandSubworkflow` REPLACES the node with the
      // referenced sub-template's nodes (id-namespaced under it), before fusion + compile. `ref` is the
      // required path to the sub-template (relative to the template root). `inputs`/`outputs` are RESERVED
      // for a follow-up that rewrites paths; until then the child terminal writes the node's declared
      // artifact path (the `{{RUN}}`-relative handoff convention). Twin of the `fusion` block above.
      type: 'object',
      additionalProperties: false,
      required: ['ref'],
      description: 'Inline a sub-template as a sub-DAG in place of this node (G9). `ref` required.',
      properties: {
        ref: { type: 'string', minLength: 1, description: 'Path to the sub-template dir, relative to the template root (e.g. "subflows/verify").' },
        inputs: { type: 'object', additionalProperties: { type: 'string' }, description: 'RESERVED (not yet wired): parent→child input path-mapping.' },
        outputs: { type: 'object', additionalProperties: { type: 'string' }, description: 'RESERVED (not yet wired): child→parent output path-mapping.' },
      },
    },
  },
  $defs: {
    check: {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: {
        kind: { type: 'string', minLength: 1, description: 'Predicate kind (exists, non-empty, json-parses, …).' },
        path: { type: 'string', minLength: 1, description: 'Artifact path the check reads, run-relative.' },
        param: { description: 'Kind-specific parameter (regex string, dotted field, { path, min }, …). Any type.' },
        severity: { enum: ['fail', 'warn'], description: 'The verdict on failure (default fail).' },
      },
    },
    policyAction: { enum: ['block', 'warn', 'stop'], description: 'block | warn | stop (retry/subagent reserved → block).' },
    seedHook: {
      // PRE — stage a starting artifact before the model.
      type: 'object',
      additionalProperties: false,
      required: ['to', 'from'],
      properties: {
        to: { type: 'string', minLength: 1, description: 'Destination, run-relative (what the model FILLs).' },
        from: { type: 'string', minLength: 1, description: 'Source skeleton/slice (token-bearing path).' },
      },
    },
    derivedHook: {
      // POST — project/merge: derive a mechanical output from frozen on-disk inputs.
      type: 'object',
      additionalProperties: false,
      required: ['to', 'from'],
      properties: {
        to: { type: 'string', minLength: 1, description: 'Derived output path, run-relative.' },
        from: { description: 'Source path(s) — a string or an array of strings.', oneOf: [
          { type: 'string', minLength: 1 },
          { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
        ] },
      },
    },
    mergeHook: {
      // POST — the DRIVER-MERGE op set (`applyMergeOp` grammar). `{ ops: [...] }`, each op EXACTLY ONE of the
      // discriminated kinds (fold | concat | reconcile | run). The op bodies stay permissive (the executor
      // discriminates + reads kind-specific params), but each op MUST carry exactly one recognized kind key —
      // a bare `{to,from}` (the lossy migration stub) NO LONGER validates, which is the whole point of S4.
      type: 'object',
      additionalProperties: false,
      required: ['ops'],
      properties: {
        ops: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            // The four recognized op-kind keys (bodies stay permissive — the executor reads kind-specific
            // params); no OTHER key is allowed, so a bare {to,from} (the lossy migration stub) is rejected.
            additionalProperties: false,
            properties: {
              fold: { type: 'object' },
              concat: { type: 'object' },
              reconcile: { type: 'object' },
              run: { type: 'object' },
            },
            // EXACTLY ONE op-kind key per op (the discriminator the executor switches on).
            oneOf: [
              { required: ['fold'] },
              { required: ['concat'] },
              { required: ['reconcile'] },
              { required: ['run'] },
            ],
          },
        },
      },
    },
    promoteHook: {
      // POST → RunState (D6): lift a node output into a state channel; the driver applies the reducer.
      type: 'object',
      additionalProperties: false,
      required: ['from', 'to'],
      properties: {
        from: { type: 'string', minLength: 1, description: 'Source — "<artifact>:<field>" or a path (§3 example).' },
        to: { type: 'string', minLength: 1, description: 'Target RunState channel name.' },
        merge: { enum: ['set', 'append', 'deepMerge'], description: 'Channel reducer (default set).' },
      },
    },
    registryProjectHook: {
      // POST derive: run a registry record's `projections` map over a frozen source (runProjection).
      type: 'object',
      additionalProperties: false,
      required: ['source', 'mapRef', 'key'],
      properties: {
        source: { type: 'string', minLength: 1, description: 'Frozen JSON the projections derive from (run-relative).' },
        mapRef: { type: 'string', minLength: 1, description: 'Registry index carrying each record (token-bearing path).' },
        key: { type: 'string', minLength: 1, description: 'Record key — may be a {{state.*}} token.' },
      },
    },
  },
} as const;
