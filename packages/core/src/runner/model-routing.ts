// G1 — per-node model/provider ROUTING: the SINGLE home of the override order.
//
// Everything that decides "which model + which provider does THIS node run on" lives here, so the precedence
// can never drift across files (the project's explicit ask: never get confused about the config tracks). The
// override order is the contract in docs/specs/per-node-routing-and-fusion.md §2:
//
//   model:    node.model  >  tiers[node.tier] (only when tiers.active)  >  run --model  >  pi provider default
//   provider: node.provider  >  models.json lookup (by effective model)  >  run --provider  >  caller's default
//
// `resolveNodeModel` is PURE (configs passed in) so it is exhaustively testable; `loadModelTiers` /
// `loadModelsIndex` are the thin, READ-ONLY adapters over the two global files in ~/.piflow and pi's
// ~/.pi/agent (never written — the SDK-boundary rule). Absence is graceful: a missing file ⇒ a safe default,
// never a throw. The ONLY loud failure is an UNRESOLVABLE tier (set but inactive/unknown) — silently dropping
// a requested tier would route the wrong model, so we throw.

import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

/** The optional, activatable tier→model alias map (`~/.piflow/model-tiers.json`). Names are free product data. */
export interface ModelTiers {
  /** When false, `tier` references do NOT resolve (a node that sets `tier` then fails loudly). */
  active: boolean;
  /** Alias → model id. Keys are whatever the product chose (small/medium/large AND/OR fast/balanced/deep). */
  tiers: Record<string, string>;
}

/** The per-node routing inputs `resolveNodeModel` reads (the subset of `NodeSpec`). */
export interface NodeRouting {
  model?: string;
  provider?: string;
  tier?: string;
}

/** Run-level routing context: the run's default model/provider + the two resolved global configs. */
export interface RunRouting {
  /** Run-level `--model` (the default for nodes that pin none). */
  model?: string;
  /** Run-level `--provider` (the default gateway). */
  provider?: string;
  /** Resolved tier map (default inactive). */
  tiers?: ModelTiers;
  /** model id → provider name, built from pi's `models.json` (for provider auto-resolve). */
  modelsIndex?: Map<string, string>;
}

/** The resolved effective model/provider for one node. `undefined` ⇒ the caller applies pi's own default. */
export interface EffectiveModel {
  model?: string;
  provider?: string;
}

/** Thrown when a node requests a tier that cannot be resolved (inactive map, or unknown name). */
export class ModelRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelRoutingError';
  }
}

/**
 * Resolve a node's EFFECTIVE model + provider per the §2 precedence. Pure: all config is passed in.
 * Throws `ModelRoutingError` only when the node sets a `tier` that does not resolve AND no explicit `model`
 * overrides it (an unresolvable tier the precedence would otherwise use is a loud failure, not a silent skip).
 */
export function resolveNodeModel(node: NodeRouting, run: RunRouting): EffectiveModel {
  let model = node.model;
  // A tier only matters when no explicit model wins. If it's needed, it MUST resolve.
  if (!model && node.tier) {
    if (!run.tiers?.active) {
      throw new ModelRoutingError(
        `node tier "${node.tier}" requested but model-tiers is inactive (set "active": true in ~/.piflow/model-tiers.json)`,
      );
    }
    const mapped = run.tiers.tiers[node.tier];
    if (!mapped) {
      throw new ModelRoutingError(
        `unknown tier "${node.tier}" — not in ~/.piflow/model-tiers.json (have: ${Object.keys(run.tiers.tiers).join(', ') || 'none'})`,
      );
    }
    model = mapped;
  }
  model = model ?? run.model; // undefined ⇒ pi's provider default

  let provider = node.provider;
  if (!provider && model && run.modelsIndex) provider = run.modelsIndex.get(model);
  provider = provider ?? run.provider; // undefined ⇒ the caller's default (cp)

  return { model, provider };
}

/** Default location of the tier map (global, never repo-local). */
export function defaultTiersPath(): string {
  return path.join(os.homedir(), '.piflow', 'model-tiers.json');
}

/** Default location of pi's native model registry (read-only — pi owns it). */
export function defaultModelsPath(): string {
  return path.join(os.homedir(), '.pi', 'agent', 'models.json');
}

/** Read the tier map (READ-ONLY). Absent/invalid ⇒ `{ active:false, tiers:{} }` (never throws on absence). */
export function loadModelTiers(file: string = defaultTiersPath()): ModelTiers {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ModelTiers>;
    return { active: Boolean(raw.active), tiers: raw.tiers ?? {} };
  } catch {
    return { active: false, tiers: {} };
  }
}

/** Build `model id → provider name` from pi's `models.json` (READ-ONLY). Absent/invalid ⇒ an empty map. */
export function loadModelsIndex(file: string = defaultModelsPath()): Map<string, string> {
  const idx = new Map<string, string>();
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      providers?: Record<string, { models?: { id?: string }[] }>;
    };
    for (const [provider, cfg] of Object.entries(raw.providers ?? {})) {
      for (const m of cfg.models ?? []) {
        if (m.id && !idx.has(m.id)) idx.set(m.id, provider); // first provider listing a model wins
      }
    }
  } catch {
    /* absent/invalid ⇒ empty map */
  }
  return idx;
}
