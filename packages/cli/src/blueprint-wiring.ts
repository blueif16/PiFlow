// The CODE-SIDE wiring map keyed by blueprint id — the deterministic mechanical skeleton `stamp` composes.
//
// Design decision (docs/design/blueprint-compose-verb.md, "Machine-readable wiring rule" + the user steer):
// the wiring rule is a CODE map keyed by blueprint id, NOT frontmatter — a user blueprint without a rule is
// discoverable (list/show) but NOT stampable (stamp exits non-zero, "compose by hand"). Each rule encodes,
// per ROLE, the fixed mechanical fields that reproduce that blueprint's golden `node.json` set BY
// CONSTRUCTION (authored by reading the 2 goldens): the owns glob, the dep pattern (role references), the
// reads, the artifact, on-fail (default block), returnMode, and the reroute {toRole, max-from-lane-plan}.
// It carries ZERO DAG logic — it never draws an edge; `deps` are authored ids and `extract`/`inferEdges`
// still derive the topology from `reads ⋈ produces`. The INTELLIGENT holes (which preset each lane binds,
// how many producer lanes, the ids) come from the agent-authored lane-plan; this map is the fixed function
// of those choices.
//
// This map now covers 4 shapes: the 2 canonical linear/fan-out (produce-verify-fix, spec-fanout-build) and
// the 2 that exercise the FULL lane-plan field set (candidate-fusion-refine, fan-out-map-reduce). `insert`
// remains a LATER task.

/**
 * A dep reference: the ROLE(s) whose lane id(s) become this role's `deps`. Resolved against the lane-plan at
 * stamp time (role → the lane id filling it). `all: true` ⇒ every lane filling that role (the fan-in join).
 */
export interface DepRef {
  role: string;
  all?: boolean;
}

/**
 * The mechanical skeleton for one blueprint ROLE — the fixed fields that reproduce the golden node. Paths are
 * `{{RUN}}`-relative on `reads` and template-relative on `owns`/`artifacts`. `{facet}` in a template is
 * filled from the lane (the parallel producer's disjoint sub-namespace; see `facetOf`).
 */
export interface RoleSkeleton {
  /** The decorative `phase` label for lanes in this role, when the shape pins one that DIFFERS from the lane
   *  id (map-reduce workers are `phase: "review"` though their ids are `review-a`/`review-b`). Omit ⇒
   *  buildNode's default (phase = the lane id — correct for the linear fusion spine). */
  phase?: string;
  /** Upstream role references → this node's `deps` (resolved to lane ids, in listed order). */
  deps: DepRef[];
  /** Write-authority glob(s); `{facet}` ⇒ the lane's facet (disjoint parallel lane). */
  owns: string[];
  /** Required output artifact(s), template-relative; `{facet}` ⇒ the lane's facet. `[]` ⇒ a return-only gate. */
  artifacts: string[];
  /** Exposed read dirs (`{{RUN}}`-relative) — the OS allow-list + the seam this role consumes. */
  reads: string[];
  /** The contract's returnMode when the shape pins one (`required` = a verdict-only gate; `optional` = the
   *  fusion goldens' explicit optional). Omit ⇒ buildNode's default (no returnMode key emitted). */
  returnMode?: 'required' | 'optional';
  /** A bounded reroute back to the `toRole` lane on failure (verify's self-fix loop). `max` = lane-plan K. */
  reroute?: { toRole: string };
  /** policy.fail (default 'block' — every producing/gating node must complete or block). */
  onFail?: 'block' | 'warn' | 'stop';
  /** policy.warn — set only where the golden pins it (the fan-out-map-reduce workers carry `warn: warn`). */
  onWarn?: 'block' | 'warn' | 'stop';
  /** Tools DENIED for every lane in this role — shape-inherent (both fusion goldens deny `bash` everywhere).
   *  For a preset lane it flows into `mergePreset` deny; for a no-preset lane it becomes tools.deny directly. */
  deny?: string[];
  /** Post-check templates the shape fixes (fusion: `non-empty` over the artifact; map-reduce: `json-parses` +
   *  `field-present:verdict`). `{artifact}` ⇒ the lane's (facet-filled) FIRST artifact path. */
  checks?: SkeletonCheck[];
}

/** A post-check the wiring rule fixes for a role — the `$defs/check` shape with a `path` template. */
export interface SkeletonCheck {
  kind: string;
  /** Literal, or `{artifact}` → the lane's first (facet-filled) artifact path. */
  path?: string;
  severity?: 'fail' | 'warn';
  param?: unknown;
}

/** A blueprint's full wiring rule: the per-role skeletons + which role fans out into parallel lanes. */
export interface WiringRule {
  /** role name → its mechanical skeleton. */
  roles: Record<string, RoleSkeleton>;
  /**
   * The role that MAY appear as N parallel lanes (each a disjoint `{facet}` producer). Every OTHER role is a
   * single lane. Absent ⇒ a purely linear blueprint (every role is one lane). Used to validate the plan +
   * to know which role's `deps` fan IN.
   */
  parallelRole?: string;
}

/**
 * The facet of a parallel producer lane — its disjoint sub-namespace, the LAST `-`-delimited segment of its
 * id (the golden ids `prod-impl`/`prod-tests`/`prod-types` ⇒ `impl`/`tests`/`types`, filling `frag/impl/**`
 * etc.). A single-segment id is its own facet. PURE; the ONLY id-derived value the map reads.
 */
export function facetOf(id: string): string {
  const i = id.lastIndexOf('-');
  return i < 0 ? id : id.slice(i + 1);
}

/**
 * The wiring rules, keyed by blueprint id. Authored FROM the 2 goldens so rule and fixture agree by
 * construction (each field lifted from the golden's node.json set):
 *   • produce-verify-fix (`.piflow/example-produce-verify-fix/template/`): plan → produce → verify⟲.
 *   • spec-fanout-build  (`.piflow/example-spec-fanout/template/`): design → M×produce ∥ → verify-join → build.
 */
export const WIRING_RULES: Record<string, WiringRule> = {
  'produce-verify-fix': {
    roles: {
      // FIXED head — freezes the spec + the acceptance bar. Root (no dep), reads the raw request.
      plan: { deps: [], owns: ['plan/**'], artifacts: ['plan/plan.md'], reads: ['{{RUN}}'] },
      // The producer — reads the plan, writes the deliverable under out/**.
      produce: { deps: [{ role: 'plan' }], owns: ['out/**'], artifacts: ['out/result.md'], reads: ['{{RUN}}/plan'] },
      // The read-only Critic gate — RETURNS a verdict (no artifact), reroutes to produce on FAIL (bounded K).
      verify: {
        deps: [{ role: 'produce' }],
        owns: ['verify/**'],
        artifacts: [],
        reads: ['{{RUN}}/out'],
        returnMode: 'required',
        reroute: { toRole: 'produce' },
      },
    },
  },
  'spec-fanout-build': {
    parallelRole: 'produce',
    roles: {
      // FREEZES one spec — root, reads the request, writes the strict-JSON blueprint the fan-out reads.
      design: { deps: [], owns: ['spec/**'], artifacts: ['spec/blueprint.json'], reads: ['{{RUN}}'] },
      // M PARALLEL producers — each owns ONE disjoint facet's fragment, all read ONLY the frozen spec.
      produce: {
        deps: [{ role: 'design' }],
        owns: ['frag/{facet}/**'],
        artifacts: ['frag/{facet}/{facet}.md'],
        reads: ['{{RUN}}/spec'],
      },
      // The join gate — deps on EVERY producer, reads all fragments + the spec, RETURNS a PASS/FAIL verdict.
      'verify-join': {
        deps: [{ role: 'produce', all: true }],
        owns: ['verify/**'],
        artifacts: [],
        reads: ['{{RUN}}/frag', '{{RUN}}/spec'],
        returnMode: 'required',
      },
      // Assembles the verified fragments into the final module.
      build: { deps: [{ role: 'verify-join' }], owns: ['out/**'], artifacts: ['out/module.md'], reads: ['{{RUN}}/frag'] },
    },
  },
  // candidate-fusion-refine (`.piflow/example-fusion/template/`): a LINEAR spine plan → draft → harden →
  // publish where `draft`/`harden` are FUSION nodes (moa panel · best-of-n). The shape fixes the mechanical
  // skeleton (deps chain · disjoint owns · single artifact · full-run readScope · optional returnMode · a
  // `non-empty` post-check over the artifact · deny bash · block). What VARIES per stamp — the preset each
  // lane binds, the fusion mode/panel/judge/n, which stage(s) fuse, and the injected upstream artifact —
  // stays in the lane-plan. Every lane reads `{{RUN}}` (the golden's readScope is the full run, not the
  // upstream stage), so `reads` is `{{RUN}}` for all four.
  'candidate-fusion-refine': {
    roles: {
      // FIXED head — freezes the outline the draft must honor. Root (no dep).
      plan: {
        deps: [],
        owns: ['plan/**'],
        artifacts: ['plan/outline.md'],
        reads: ['{{RUN}}'],
        returnMode: 'optional',
        deny: ['bash'],
        checks: [{ kind: 'non-empty', path: '{artifact}' }],
      },
      // The MoA-panel drafter (fusion from the lane-plan) — injects the outline, writes the merged draft.
      draft: {
        deps: [{ role: 'plan' }],
        owns: ['draft/**'],
        artifacts: ['draft/draft.md'],
        reads: ['{{RUN}}'],
        returnMode: 'optional',
        deny: ['bash'],
        checks: [{ kind: 'non-empty', path: '{artifact}' }],
      },
      // The best-of-n hardener (fusion + tier from the lane-plan) — injects the draft, writes the hardened.
      harden: {
        deps: [{ role: 'draft' }],
        owns: ['harden/**'],
        artifacts: ['harden/hardened.md'],
        reads: ['{{RUN}}'],
        returnMode: 'optional',
        deny: ['bash'],
        checks: [{ kind: 'non-empty', path: '{artifact}' }],
      },
      // The plain consumer — injects the hardened artifact, assembles the final explainer.
      publish: {
        deps: [{ role: 'harden' }],
        owns: ['out/**'],
        artifacts: ['out/explainer.md'],
        reads: ['{{RUN}}'],
        returnMode: 'optional',
        deny: ['bash'],
        checks: [{ kind: 'non-empty', path: '{artifact}' }],
      },
    },
  },
  // fan-out-map-reduce (`templates/quality/verify/`): N PARALLEL workers over the SAME staged subject → one
  // reduce that folds them. Mirrors spec-fanout's `parallelRole`, but each worker owns a SINGLE JSON file
  // (not a facet dir) and carries the `adjudicate`-mode post-checks (`json-parses` + `field-present:verdict`
  // fail). The shape fixes: disjoint per-worker owns (`verify/<id>.json`), full-run readScope, the two
  // post-checks over each node's OWN artifact, deny bash, and `policy {fail:block, warn:warn}`. The N and the
  // preset (here `agentType: null`, hand-wired) stay in the lane-plan.
  'fan-out-map-reduce': {
    parallelRole: 'worker',
    roles: {
      // N PARALLEL reviewers — deps [] (the caller stages the subject), each owns ONE disjoint verdict file
      // named by the FULL lane id (`{id}`, NOT the `-`-tail facet — the golden owns `verify/review-a.json`),
      // reads the whole run, emits strict JSON gated by json-parses + a required `verdict` field.
      worker: {
        phase: 'review',
        deps: [],
        owns: ['verify/{id}.json'],
        artifacts: ['verify/{id}.json'],
        reads: ['{{RUN}}'],
        returnMode: 'optional',
        deny: ['bash'],
        onWarn: 'warn',
        checks: [
          { kind: 'json-parses', path: '{artifact}' },
          { kind: 'field-present', path: '{artifact}', param: 'verdict', severity: 'fail' },
        ],
      },
      // The reduce — deps on EVERY worker, reads the whole run, adjudicates one consolidated verdict JSON.
      reduce: {
        deps: [{ role: 'worker', all: true }],
        owns: ['verify/verdict.json'],
        artifacts: ['verify/verdict.json'],
        reads: ['{{RUN}}'],
        returnMode: 'optional',
        deny: ['bash'],
        onWarn: 'warn',
        checks: [
          { kind: 'json-parses', path: '{artifact}' },
          { kind: 'field-present', path: '{artifact}', param: 'verdict', severity: 'fail' },
        ],
      },
    },
  },
};

/** The wiring rule for a blueprint id, or `undefined` when the id is not stampable (no code-side rule). */
export function wiringRuleFor(id: string): WiringRule | undefined {
  return WIRING_RULES[id];
}
