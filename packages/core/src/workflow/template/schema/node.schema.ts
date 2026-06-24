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
