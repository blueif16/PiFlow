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
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';

/** The optional, activatable tier→model alias map (`~/.piflow/model-tiers.json`). Names are free product data. */
export interface ModelTiers {
  /** When false, `tier` references do NOT resolve (a node that sets `tier` then fails loudly). */
  active: boolean;
  /** Alias → model id for the `pi` executor (fed to `pi --model`). The canonical executor's tier map. */
  tiers: Record<string, string>;
  /**
   * OPTIONAL parallel map for the `claude-code` executor (same tier keys, Claude model values: aliases like
   * `opus`/`sonnet`/`haiku` or full `claude-*` ids). The claude-code executor reads THIS; absence is graceful
   * (it falls back to a Claude-valid `tiers` value, else the account default). `pi` never reads it, so adding
   * this block is byte-identical for pi routing. See docs/design/agent-executor-interface.md.
   */
  claude?: Record<string, string>;
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

// ── claude-code executor model resolution (the parallel `claude` tier block) ──────────────────
//
// pi routing is resolveNodeModel above; the claude-code executor resolves its model HERE so the two
// tracks never get confused. Claude Code's `--model` accepts these aliases (docs: model-config) or a
// full `claude-*` id. `default` is the account's recommended model (we express that as "omit --model").

/** Claude Code `--model` aliases (the values that are NOT `claude-*` ids but still valid). */
const CLAUDE_MODEL_ALIASES = new Set([
  'default',
  'best',
  'fable',
  'opus',
  'sonnet',
  'haiku',
  'opusplan',
  'opus[1m]',
  'sonnet[1m]',
]);

/** True if `s` is a value Claude Code's `--model` accepts — a known alias or a `claude-*` full id. */
export function isClaudeModel(s: string): boolean {
  return CLAUDE_MODEL_ALIASES.has(s) || s.startsWith('claude-');
}

/**
 * Resolve the EFFECTIVE Claude Code model for a node (the `claude-code` executor). `undefined` ⇒ omit
 * `--model` ⇒ Claude uses the account's recommended/default model. Precedence:
 *
 *   node.model  >  run.tiers.claude[tier]  >  run.tiers.tiers[tier] (ONLY if Claude-valid)  >  undefined
 *
 * `node.model` is passed through verbatim (an explicit pin — the author owns using a Claude-valid value).
 * A tier resolves only when the map is `active`; the `tiers` fallback is gated by `isClaudeModel` so a
 * pi-only id (e.g. `deepseek-v3`) is NEVER handed to `claude --model`. TOTAL (never throws): unlike pi,
 * Claude always has a sensible account default, so an unresolvable tier degrades to it rather than failing.
 */
export function resolveClaudeModel(node: NodeRouting, run: RunRouting): string | undefined {
  if (node.model) return node.model;
  if (node.tier && run.tiers?.active) {
    const fromClaude = run.tiers.claude?.[node.tier];
    if (fromClaude) return fromClaude;
    const fromTiers = run.tiers.tiers?.[node.tier];
    if (fromTiers && isClaudeModel(fromTiers)) return fromTiers;
  }
  return undefined;
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
    const out: ModelTiers = { active: Boolean(raw.active), tiers: raw.tiers ?? {} };
    // Only include `claude` when the file actually carries it — keep the absent-file return exactly
    // `{active,tiers}` (an empty `claude:{}` would change the shape callers/tests deep-equal against).
    if (raw.claude && typeof raw.claude === 'object') out.claude = raw.claude;
    return out;
  } catch {
    return { active: false, tiers: {} };
  }
}

// ── SA-C · Canonical tier vocabulary (expert-representations, decision 1) ─────────────────────
//
// The THREE settled tiers for piflow are 'fast' | 'balanced' | 'deep'. These are the canonical
// strings referenced everywhere: gate-authoring.ts, fusion-nodes.md, docs/specs/per-node-routing-
// and-fusion.md §1, and the test corpus. They are FREE DATA (user maps each to a concrete model id
// in ~/.piflow/model-tiers.json) — the SDK only carries the names as constants so typos fail
// loudly. A tier is NEVER a model id; it is a semantic CLASS the user's tiers.json resolves.
//
// Tier semantics (normative recipe descriptions — NOT enforced by the runtime):
//   fast      — cheap + fast; good for high-volume, low-complexity tasks (e.g. executors, coders)
//   balanced  — mid-range; good for most producer / research nodes
//   deep      — frontier deliberate; good for judges, architects, hard reasoning tasks

/** The three canonical tier keys. Use these constants; never hard-code the strings. */
export const TIER_FAST = 'fast';
export const TIER_BALANCED = 'balanced';
export const TIER_DEEP = 'deep';

/** The canonical tier set as an array (stable order: cheapest → most expensive). */
export const CANONICAL_TIERS: readonly string[] = [TIER_FAST, TIER_BALANCED, TIER_DEEP] as const;

/**
 * The default seed for `~/.piflow/model-tiers.json` (SA-C, decision 1).
 * Seeds placeholders — the user fills in the concrete model ids for their provider.
 * `active: false` by default so a seed never silently routes the wrong model.
 *
 * Three canonical tiers with placeholder model ids — the user edits these to real ids
 * (e.g. `"fast": "deepseek-v3"`, `"deep": "claude-opus-4-8"`).
 */
export const DEFAULT_TIERS_SEED: ModelTiers = {
  active: false,
  tiers: {
    [TIER_FAST]: '',     // fill in: cheap + fast model (e.g. "deepseek-v3", "haiku", "gemini-flash")
    [TIER_BALANCED]: '', // fill in: mid-range model (e.g. "sonnet", "gemini-pro", "gpt-4o-mini")
    [TIER_DEEP]: '',     // fill in: frontier deliberate model (e.g. "claude-opus-4-8", "o3", "gemini-ultra")
  },
};

/**
 * Seed `~/.piflow/model-tiers.json` with the three canonical tiers if the file does not exist.
 * WRITE-ONCE: never overwrites an existing file. Silently no-ops if the dir/file cannot be written.
 *
 * Called by `piflowctl new` and `piflowctl init` so a fresh install has a ready-to-edit template.
 * The seed is INACTIVE (`active: false`) — the user must set `active: true` and fill in model ids.
 */
export function seedModelTiers(file: string = defaultTiersPath()): void {
  try {
    if (existsSync(file)) return; // never overwrite
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify(
        {
          ...DEFAULT_TIERS_SEED,
          $comment:
            'piflow model tiers — set active:true and fill in real model ids to enable tier routing. ' +
            'Canonical tier keys: fast (cheap/quick), balanced (mid), deep (frontier/deliberate). ' +
            'See docs/specs/per-node-routing-and-fusion.md §1.',
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );
  } catch {
    /* best-effort: absent write permissions → silently skip */
  }
}

/**
 * WRITE the tier map atomically (the round-trip partner of `loadModelTiers` — same `{active,tiers}` shape,
 * so the runner reads EXACTLY what the CLI writes). `mkdir -p` the home, write a sibling `.tmp`, then
 * `rename` it over the target (atomic on POSIX — a reader never sees a half-written file). Unlike the
 * write-once `seedModelTiers`, this OVERWRITES — it is the CLI's `model set`/`activate` mutation sink, so the
 * caller (not the writer) owns the don't-clobber decision (the lazy ensure guards on `existsSync`).
 *
 * Additive: does NOT touch `loadModelTiers`/`resolveNodeModel`/the precedence. Pretty-printed + a trailing
 * newline (git-friendly + matches `seedModelTiers`).
 */
export function writeModelTiers(tiers: ModelTiers, file: string = defaultTiersPath()): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(tiers, null, 2) + '\n', 'utf8');
  renameSync(tmp, file); // atomic publish
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
