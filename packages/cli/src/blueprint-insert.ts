// `piflowctl blueprint insert <id> --plan <plan.json> --into <existing-dir> --ns <prefix>` — splice a
// blueprint FRAGMENT into an EXISTING template. insert = `spliceBlueprint(existingDir, plan, rule, {ns,seam})`
// (the SHARED core stamp also calls — stamp ⊆ insert) PLUS insert's THREE deltas:
//
//   1. NAMESPACING (delta 1)   — done inside splice via `ns`: inserted ids → `<ns>__<id>`, owns/artifacts/
//      internal reads → `<ns>/…`, inserted-lane deps + the reroute target → their namespaced ids.
//   2. SEAM-BIND (delta 2)     — the fragment's input seam (`seams.input`, a `{{RUN}}` produce path) is
//      resolved to the EXISTING node that produces it; that node becomes a dep + inject of every fragment-
//      ROOT lane (so the fragment reads it AND is ordered after it — §6 checkProducers demands an upstream
//      producer). Optionally, a named downstream consumer (`seams.consumer`) is ADDITIVELY extended: it gains
//      a dep on the inserted reduce + a read of `seams.consumerReads` (the ONLY mutation of a pre-existing
//      node insert ever makes — additive, never rewriting its prompt/owns/existing deps).
//   3. COLLISION + ADDITIVE-INVARIANT (delta 3) — the namespaced ids must be unique vs existing nodes and the
//      namespaced owns write-disjoint vs existing owns; else HALT non-zero (never a partial splice).
//
// The namespacing helper is the verb's OWN scaffolder-layer transform (blueprint-namespace.ts), NOT the
// load-time graph-rewrite (docs/design/blueprint-compose-verb.md, "Boundaries / invariants").

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseLanePlan, LanePlanError, type LanePlan } from './blueprint-plan.js';
import { wiringRuleFor, WIRING_RULES, type WiringRule } from './blueprint-wiring.js';
import { nsRewriteId, nsRewritePath } from './blueprint-namespace.js';
import { validatePlanAgainstRule, spliceBlueprint, type SeamBind, type StampDeps } from './blueprint-stamp.js';

/** Strip a leading `{{RUN}}/` (whitespace-tolerant) to the run-relative path used for producer matching. A
 *  path with no `{{RUN}}` root (or a `{{WORKSPACE}}`/`{{state}}` path) returns null — not a routed produce. */
function runRelative(p: string): string | null {
  const m = /^\{\{\s*RUN\s*\}\}\/(.+)$/.exec(p.trim());
  return m ? m[1] : null;
}

/** Two owns-globs collide if either is a prefix of the other once the trailing `/**` glob is stripped —
 *  mirrors core's `ownsOverlap` (checks.ts) so the CLI rejects the same overlap the loader would. */
function ownsOverlap(a: string, b: string): boolean {
  const norm = (g: string): string => g.replace(/\/?\*+$/, '').replace(/\/+$/, '');
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  return na.startsWith(nb + '/') || nb.startsWith(na + '/');
}

/** An existing node's minimal shape the insert deltas read (ids, deps, owns, artifacts, readScope). */
interface ExistingNode {
  id: string;
  raw: Record<string, unknown>;
  owns: string[];
  artifacts: string[];
  produces: string[]; // run-relative artifact paths this node produces
}

/** Scan the target's per-node `node.json` set (the pre-existing DAG the fragment splices into). */
async function scanExisting(dir: string): Promise<ExistingNode[]> {
  const nodesDir = path.join(dir, 'nodes');
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = await fs.readdir(nodesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ExistingNode[] = [];
  for (const e of entries.filter((x) => x.isDirectory())) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(await fs.readFile(path.join(nodesDir, e.name, 'node.json'), 'utf8'));
    } catch {
      continue;
    }
    const contract = (raw.contract ?? {}) as { owns?: string[]; artifacts?: string[] };
    const owns = contract.owns ?? [];
    const artifacts = contract.artifacts ?? [];
    const produces = artifacts.map((a) => a.replace(/^\/+/, '')); // owns/artifacts are template-relative
    out.push({ id: (raw.id as string) ?? e.name, raw, owns, artifacts, produces });
  }
  return out;
}

/**
 * `piflowctl blueprint insert <id> --plan <plan.json> --into <existing-dir> --ns <prefix>`. Returns the exit
 * code (0 = ok). Any malformed input, an unresolvable seam, or a collision HALTS non-zero BEFORE any write
 * (never a partial splice). Ends by re-running the `extract` oracle over the whole spliced template.
 */
export async function runBlueprintInsert(
  id: string | undefined,
  planPath: string | undefined,
  into: string | undefined,
  ns: string | undefined,
  deps: StampDeps = {},
): Promise<number> {
  const out = deps.out ?? ((s: string) => void process.stdout.write(s));
  const err = deps.err ?? ((s: string) => void process.stderr.write(s));

  if (!id) {
    err('piflowctl blueprint insert: a blueprint id is required.\n  usage: piflowctl blueprint insert <id> --plan <plan.json> --into <existing-dir> --ns <prefix>\n');
    return 1;
  }
  if (!planPath) {
    err('piflowctl blueprint insert: --plan <lane-plan.json> is required.\n');
    return 1;
  }
  if (!into) {
    err('piflowctl blueprint insert: --into <existing-dir> is required.\n');
    return 1;
  }
  // --ns MAY be '' (the degenerate namespace) — undefined means the flag was absent (default to '').
  const nsPrefix = ns ?? '';

  const rule = wiringRuleFor(id);
  if (!rule) {
    err(
      `piflowctl blueprint insert: "${id}" is not stampable — compose by hand via  piflowctl blueprint show ${id}\n` +
        `  (stampable: ${Object.keys(WIRING_RULES).join(', ')})\n`,
    );
    return 1;
  }

  let plan: LanePlan;
  try {
    plan = parseLanePlan(await fs.readFile(planPath, 'utf8'));
  } catch (e) {
    err(`piflowctl blueprint insert: ${(e as Error).message}\n`);
    return 1;
  }
  if (plan.blueprint !== id) {
    err(`piflowctl blueprint insert: --plan is for blueprint "${plan.blueprint}" but you asked to insert "${id}".\n`);
    return 1;
  }
  try {
    validatePlanAgainstRule(plan, rule);
  } catch (e) {
    err(`piflowctl blueprint insert: ${(e as Error).message}\n`);
    return 1;
  }

  // The target must already be a template (an existing dir with nodes/) — insert never creates it.
  const existing = await scanExisting(into);
  if (existing.length === 0) {
    err(`piflowctl blueprint insert: no existing nodes under "${into}" — use  blueprint stamp  for a fresh dir.\n`);
    return 1;
  }
  const existingById = new Map(existing.map((n) => [n.id, n]));

  // ── DELTA 3a: id collision (namespaced inserted ids must be unique vs existing) ──────────────────────
  for (const lane of plan.lanes) {
    const nsId = nsRewriteId(lane.id, nsPrefix);
    if (existingById.has(nsId)) {
      err(
        `piflowctl blueprint insert: id collision — inserted lane "${lane.id}" namespaces to "${nsId}", ` +
          `which is already a node in "${into}" (pick a different --ns or lane id).\n`,
      );
      return 1;
    }
  }

  // ── DELTA 2: resolve the input seam → the surrounding node that produces it, bind it to the roots ─────
  // The fragment ROOTS = lanes whose wiring skeleton has NO deps (the caller stages their input). Each root
  // gets the seam producer as a dep + the seam path as an inject.
  const seam: SeamBind = {
    depsByLane: new Map(),
    injectByLane: new Map(),
    externalDeps: new Set(),
    externalReads: new Set(),
  };
  const seams = plan.seams ?? {};
  const inputSeam = seams.input;
  if (inputSeam) {
    const rel = runRelative(inputSeam);
    if (!rel) {
      err(`piflowctl blueprint insert: seams.input "${inputSeam}" is not a {{RUN}}-rooted path — cannot bind.\n`);
      return 1;
    }
    const producer = existing.find((n) => n.produces.includes(rel));
    if (!producer) {
      err(
        `piflowctl blueprint insert: seams.input "${inputSeam}" resolves to no existing produce — no node in ` +
          `"${into}" produces "${rel}" (bind to a real surrounding artifact, never invent an edge).\n`,
      );
      return 1;
    }
    const rootLanes = plan.lanes.filter((l) => rule.roles[l.role].deps.length === 0);
    if (rootLanes.length === 0) {
      err(
        `piflowctl blueprint insert: the fragment has no root lane (every role declares a dep) — its input ` +
          `seam cannot bind. The lane-plan seams shape cannot express this fragment; HALT.\n`,
      );
      return 1;
    }
    for (const l of rootLanes) {
      seam.depsByLane.set(l.id, [producer.id]);
      seam.injectByLane.set(l.id, [inputSeam]);
    }
    seam.externalDeps.add(producer.id);
    seam.externalReads.add(inputSeam);
  }

  // ── DELTA 3b: owns write-disjointness (namespaced inserted owns vs existing owns) ────────────────────
  // Compute the namespaced owns the splice will emit (mirror the skeleton owns fill + ns) and reject an
  // overlap BEFORE writing (else the loader's checkParallelOwns would fail at extract, but we halt cleanly).
  for (const lane of plan.lanes) {
    const skeleton = rule.roles[lane.role];
    const facet = lane.id.includes('-') ? lane.id.slice(lane.id.lastIndexOf('-') + 1) : lane.id;
    for (const g of skeleton.owns) {
      const filled = g.replaceAll('{facet}', facet).replaceAll('{id}', lane.id);
      const nsOwns = nsRewritePath(filled, nsPrefix);
      for (const ex of existing) {
        for (const exOwns of ex.owns) {
          if (ownsOverlap(nsOwns, exOwns)) {
            err(
              `piflowctl blueprint insert: owns collision — inserted lane "${lane.id}" would own "${nsOwns}", ` +
                `overlapping existing node "${ex.id}" (owns "${exOwns}"). Namespace the writes with --ns.\n`,
            );
            return 1;
          }
        }
      }
    }
  }

  // ── SPLICE the fragment (shared core: map ⋈ seam-bind ⋈ namespace → scaffoldAddNode → extract) ────────
  const { code } = await spliceBlueprint(into, plan, rule, { ns: nsPrefix, seam }, { err });
  if (code !== 0) {
    err(`piflowctl blueprint insert: ${plan.blueprint} did not splice cleanly — see above (target left as-was for the pre-existing nodes).\n`);
    return code;
  }

  // ── DELTA 2 (consumer): additively extend the named downstream consumer to read the fragment's output ──
  // The ONLY mutation of a pre-existing node insert makes: append ONE dep (the inserted producer of
  // `consumerReads`) + ONE readScope entry. Its prompt/owns/existing deps are byte-unchanged.
  const consumerId = seams.consumer;
  if (consumerId) {
    const consumer = existingById.get(consumerId);
    if (!consumer) {
      err(`piflowctl blueprint insert: seams.consumer "${consumerId}" is not a node in "${into}".\n`);
      return 1;
    }
    const consumerReads = seams.consumerReads;
    if (!consumerReads) {
      err(`piflowctl blueprint insert: seams.consumer needs a seams.consumerReads path (what the consumer reads).\n`);
      return 1;
    }
    const rel = runRelative(consumerReads);
    if (!rel) {
      err(`piflowctl blueprint insert: seams.consumerReads "${consumerReads}" is not a {{RUN}}-rooted path.\n`);
      return 1;
    }
    // find the INSERTED node that produces `consumerReads` (its namespaced artifact) → the dep to add.
    const producerLane = plan.lanes.find((lane) => {
      const skeleton = rule.roles[lane.role];
      const facet = lane.id.includes('-') ? lane.id.slice(lane.id.lastIndexOf('-') + 1) : lane.id;
      return skeleton.artifacts.some((a) => {
        const filled = a.replaceAll('{facet}', facet).replaceAll('{id}', lane.id);
        return nsRewritePath(filled, nsPrefix) === rel;
      });
    });
    if (!producerLane) {
      err(
        `piflowctl blueprint insert: seams.consumerReads "${consumerReads}" (run-rel "${rel}") is produced by no ` +
          `inserted lane — the consumer bind would dangle (never invent an edge).\n`,
      );
      return 1;
    }
    const producerId = nsRewriteId(producerLane.id, nsPrefix);
    // ADDITIVE mutation — read → append dep + readScope → write back. Existing entries untouched.
    const nodePath = path.join(into, 'nodes', consumerId, 'node.json');
    const node = JSON.parse(await fs.readFile(nodePath, 'utf8')) as Record<string, unknown>;
    const nodeDeps = Array.isArray(node.deps) ? (node.deps as string[]) : [];
    if (!nodeDeps.includes(producerId)) nodeDeps.push(producerId);
    node.deps = nodeDeps;
    const contract = (node.contract ?? {}) as { readScope?: string[] };
    const rs = Array.isArray(contract.readScope) ? contract.readScope : [];
    if (!rs.includes(consumerReads)) rs.push(consumerReads);
    contract.readScope = rs;
    node.contract = contract;
    await fs.writeFile(nodePath, JSON.stringify(node, null, 2) + '\n');
  }

  // Re-run the oracle over the WHOLE spliced template (the consumer edit may have introduced a dangle).
  try {
    const { extractTemplate } = await import('./extract.js');
    const preview = await extractTemplate(into);
    out(`inserted ${plan.lanes.length} nodes (ns "${nsPrefix}") into ${into}\n${preview}\n`);
    out(`next: Write each new nodes/<id>/prompt.md (the task prose — the verb seeds only a placeholder).\n`);
    return 0;
  } catch (e) {
    err(
      `piflowctl blueprint insert: the spliced template did not compile (extract failed):\n  ${(e as Error).message}\n`,
    );
    return 1;
  }
}
