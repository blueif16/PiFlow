// (Phase 2 · T2.3) The READ-ONLY reader for the global fusion defaults (`~/.piflow/fusion.json`).
//
// Mirrors `runner/model-routing.ts`'s `loadModelTiers`: a thin adapter over ONE global file, graceful on
// absence (a missing/invalid file ⇒ a safe `{active:false, defaults:{}}`, never a throw), never written
// (the SDK-boundary rule). It only EXPOSES the config: `active` is the toggle the init SKILL honors when
// auto-marking best-quality nodes (spec §2) — core never auto-marks here; `defaults` are the param
// fallbacks each `node.fusion.<param>` resolves to (`expandFusion`'s `FusionExpandOpts.defaults`). The
// built-in numeric/boolean defaults (n=3, verify=true, obligations=false) live in `expandFusion`, so this
// reader surfaces ONLY what the file actually sets — it does not bake in the built-ins.

import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import type { FusionDefaults } from '../workflow/fusion/expand.js';

/** The resolved global fusion config: the init toggle + the param defaults `expandFusion` falls back to. */
export interface FusionConfig {
  /** When true, the init SKILL may auto-mark best-quality nodes as fusion (spec §2). Core never auto-marks. */
  active: boolean;
  /** Param fallbacks for every `node.fusion.<param>` (`mode/n/panel/judge/obligations/verify`). */
  defaults: FusionDefaults;
}

/** Default location of the global fusion config (never repo-local — the SDK-boundary rule). */
export function defaultFusionConfigPath(): string {
  return path.join(os.homedir(), '.piflow', 'fusion.json');
}

/** Pick ONLY the known fusion param keys off a parsed object (unknown keys never leak into defaults). */
function pickDefaults(raw: Record<string, unknown>): FusionDefaults {
  const d: FusionDefaults = {};
  if (raw.mode === 'moa' || raw.mode === 'best-of-n') d.mode = raw.mode;
  if (typeof raw.n === 'number') d.n = raw.n;
  if (Array.isArray(raw.panel)) d.panel = raw.panel.map(String);
  if (typeof raw.judge === 'string') d.judge = raw.judge;
  if (typeof raw.obligations === 'boolean') d.obligations = raw.obligations;
  if (typeof raw.verify === 'boolean') d.verify = raw.verify;
  return d;
}

/**
 * Read the global fusion config (READ-ONLY). Absent/invalid ⇒ `{active:false, defaults:{}}` (never throws
 * on absence). Pure/injectable: pass a `file` path in tests.
 */
export function loadFusionConfig(file: string = defaultFusionConfigPath()): FusionConfig {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    return { active: Boolean(raw.active), defaults: pickDefaults(raw) };
  } catch {
    return { active: false, defaults: {} };
  }
}
