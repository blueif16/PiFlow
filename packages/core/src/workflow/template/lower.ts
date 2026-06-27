// (M5 · G13) lowerToOps — the GRAMMAR-UNIFICATION lowering. A pure transform that maps an authored
// `node.json` (its deprecated `inject`/`hooks`/`checks`/`policy` aliases, OR a directly-authored `op`)
// into the ONE canonical `OpSpec[]` envelope (design §2.2 migration table). Runs AT THE LOADER ONLY: the
// dense `NodeSpec` gains exactly the one `op` field; the old keys never survive on it (design §5).
//
// The lowering is byte-faithful to the migration table:
//   • inject:[p]               → { when:'pre', reads:[p] }                                          (#10)
//   • hooks.seed:[{to,from}]   → { when:'pre',  writes:[to], transform:{kind:'seed', from} }
//   • hooks.project:[{to,from}]→ { when:'post', writes:[to], reads:[…from], transform:{kind:'project', from} }
//   • hooks.merge:{ops}        → { when:'post', transform:{kind:'merge', ops} }
//   • hooks.promote:[{…}]      → { when:'post', transform:{kind:'promote', from, to, reducer} }
//   • hooks.registryProject    → { when:'post', transform:{kind:'projectRegistry', …} }
//   • checks.pre:[Check]       → { when:'pre',  gate:{kind,path,param}, onFailure:<from policy/severity> } (#11)
//   • checks.post:[Check]      → { when:'post', gate:{kind,path,param}, onFailure:<from policy/severity> }
// `policy` folds into each gate's `onFailure` (the checks⊥policy split made universal, design §2.4): a
// `fail`-severity check takes `policy.fail` (default 'block'); a `warn`-severity check takes 'warn'.
//
// The order is STABLE: pre reads → pre seeds → pre gates → post transforms → post gates — so the codec /
// edge-inference see a deterministic envelope and the two authorings compare equal as a SET.

import type { OpSpec, OnFailure, Reducer, TransformBody, NodeOps, RerouteSpec, RetrySpec, EscalateSpec, ActionBody } from '../../types.js';
import type { TemplateNode, TemplateCheck } from './types.js';

/** The consequence a lowered gate carries: a `warn`-severity check warns; a `fail` check takes policy.fail. */
function gateOnFailure(check: TemplateCheck, policy: TemplateNode['policy']): OnFailure {
  if (check.severity === 'warn') return 'warn';
  const fail = (policy?.fail as OnFailure | undefined) ?? 'block';
  return fail;
}

/** Lower one authored check → a `gate` op fired in the given lane. */
function lowerCheck(check: TemplateCheck, when: 'pre' | 'post', policy: TemplateNode['policy']): OpSpec {
  const gate: OpSpec['gate'] = { kind: check.kind };
  if (check.path !== undefined) gate.path = check.path;
  if (check.param !== undefined) gate.param = check.param;
  return { when, gate, onFailure: gateOnFailure(check, policy) };
}

/**
 * Lower a node's deprecated authoring grammars into the canonical `op[]`. If the node ALREADY authors `op`
 * directly, it is returned verbatim (authoring may declare the envelope outright). Returns undefined when
 * the node declares NONE of the lowerable surfaces (so an op-free node stays op-free — additive).
 */
export function lowerToOps(def: TemplateNode): OpSpec[] | undefined {
  if (def.op) return def.op as OpSpec[];

  const ops: OpSpec[] = [];

  // PRE — injected forced reads (#10): each becomes a read-only pre-op whose `reads` fold into the prompt.
  for (const p of def.inject ?? []) ops.push({ when: 'pre', reads: [p] });

  // PRE — seeds (stage a starting artifact before the model).
  for (const s of def.hooks?.seed ?? []) {
    ops.push({ when: 'pre', writes: [s.to], transform: { kind: 'seed', from: s.from } });
  }

  // PRE — checks.pre (#11): a gate that fires BEFORE the model over staged inputs.
  for (const c of def.checks?.pre ?? []) ops.push(lowerCheck(c, 'pre', def.policy));

  // POST — project/merge/promote/registryProject transforms (derive outputs from frozen inputs).
  for (const p of def.hooks?.project ?? []) {
    const reads = Array.isArray(p.from) ? [...p.from] : [p.from];
    ops.push({ when: 'post', writes: [p.to], reads, transform: { kind: 'project', from: p.from } });
  }
  if (def.hooks?.merge) {
    ops.push({ when: 'post', transform: { kind: 'merge', ops: def.hooks.merge.ops } });
  }
  for (const p of def.hooks?.promote ?? []) {
    const t: Extract<TransformBody, { kind: 'promote' }> = { kind: 'promote', from: p.from, to: p.to };
    if (p.merge !== undefined) t.reducer = p.merge as Reducer;
    ops.push({ when: 'post', transform: t });
  }
  if (def.hooks?.registryProject) {
    const rp = def.hooks.registryProject;
    ops.push({ when: 'post', transform: { kind: 'projectRegistry', source: rp.source, mapRef: rp.mapRef, key: rp.key } });
  }

  // POST — checks.post: a gate over produced artifacts.
  for (const c of def.checks?.post ?? []) ops.push(lowerCheck(c, 'post', def.policy));

  return ops.length ? ops : undefined;
}

/**
 * (G13 — M5) opsToNodeOps — the SYMMETRIC INVERSE of `lowerToOps`'s DERIVE section: read a node's
 * canonical `op[]` envelope back into the runtime `NodeOps` (seed/project/merge/promote/registryProject)
 * the runner's POST-derive executors consume (`runner.ts` reads `node.ops?.{…}` at the derive sites). It
 * exists for the node authored DIRECTLY in `op[]` (no `hooks` alias): `lowerToOps` returns that `op[]`
 * verbatim and NEVER re-derives `hooks`, so without this back-fill an op[]-authored derive sets `node.op`
 * but leaves `node.ops` undefined and the derive SILENTLY never runs. The loader calls this ONLY when no
 * `hooks` block already single-sourced `node.ops` (the guard — never double-source). Returns undefined
 * when the envelope carries NO derive transform (a gate/action/run-only node stays op-free — additive).
 *
 * Field mappings mirror `lowerToOps` (lines ~53-76) inverted — incl. the NAME FLIP `transform.reducer` →
 * `NodeOps.promote.merge`. `seed`/`project` recover their `to` from the op's `writes[0]`.
 */
export function opsToNodeOps(op: OpSpec[]): NodeOps | undefined {
  const out: NodeOps = {};
  for (const o of op) {
    const t = o.transform;
    if (!t) continue;
    if (t.kind === 'seed') {
      (out.seed ??= []).push({ to: (o.writes ?? [])[0], from: t.from });
    } else if (t.kind === 'project') {
      (out.project ??= []).push({ to: (o.writes ?? [])[0], from: t.from as string | string[] });
    } else if (t.kind === 'merge') {
      out.merge = { ops: t.ops };
    } else if (t.kind === 'promote') {
      const p: { from: string; to: string; merge?: Reducer } = { from: t.from, to: t.to };
      if (t.reducer !== undefined) p.merge = t.reducer;
      (out.promote ??= []).push(p);
    } else if (t.kind === 'projectRegistry') {
      out.registryProject = { source: t.source, mapRef: t.mapRef, key: t.key };
    }
  }
  return out.seed || out.project || out.merge || out.promote || out.registryProject ? out : undefined;
}

/**
 * (M5 · G13) The CONTROL action ops are SUGAR that lowers to the canonical M3/M4 primitives:
 *   action:rerouteTo → NodeIntent.reroute (consumed by expandReroute pre-compile — never the dense NodeSpec);
 *   action:retry     → NodeIO.retry (M4);
 *   action:escalate  → NodeIO.escalate (M4 — `via` resolves through model-routing as a tier, else a model id).
 * Returns the canonical fields the loader attaches onto the intent (the action op carries the SLOT; G12 owns
 * the runtime). A node with no action ops yields all-undefined (additive). The FIRST of each kind wins.
 */
export function lowerActions(op: OpSpec[] | undefined): {
  reroute?: RerouteSpec;
  retry?: RetrySpec;
  escalate?: EscalateSpec;
} {
  const out: { reroute?: RerouteSpec; retry?: RetrySpec; escalate?: EscalateSpec } = {};
  for (const o of op ?? []) {
    const a = o.action as ActionBody | undefined;
    if (!a) continue;
    if (a.kind === 'rerouteTo' && !out.reroute) {
      out.reroute = { onFail: a.node, max: a.max, ...(a.evidence ? { evidence: a.evidence } : {}) };
    } else if (a.kind === 'retry' && !out.retry) {
      out.retry = { max: a.max ?? 1 };
    } else if (a.kind === 'escalate' && !out.escalate) {
      // `via` is a tier alias OR a model id — carried as `tier` (resolved through model-routing precedence).
      out.escalate = { tier: a.via };
    }
  }
  return out;
}
