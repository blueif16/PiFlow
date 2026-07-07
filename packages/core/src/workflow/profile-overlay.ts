// (gate-list-and-additive-profiles.md §b/§c) The ADDITIVE PROFILE overlay — a sparse, per-file overlay
// (`template/profiles/<name>.json`) that APPENDS gates to the nodes it names. This is the NEW profile
// model: additive-only. It never elides a node (the deprecated `elidePhases` model, `workflow/profile.ts`)
// and has no on/off switch.
//
// Two pure-ish pieces:
//   • `loadProfileOverlay(dir, name, validate)` — read `<dir>/profiles/<name>.json`, validate it against
//     `profileSchema` (fail-closed), return the parsed overlay — or `null` if the file is absent (so the
//     caller can fall through to the legacy meta.json path / a loud unknown-profile error).
//   • `mergeProfileOverlay(loaded, overlay)` — APPEND each `nodes[<id>]` list to that loaded node's
//     `gates[]`. A named node the template does not declare is a LOUD error (never a silent no-op — a typo
//     in a profile must not quietly gate nothing).
//
// FILE FENCE: additive. Consumes the profile schema + `LoadedNode`. Does NOT touch the runner or the CLI.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { SchemaValidator } from '../runner/schema.js';
import { profileSchema } from './template/schema/index.js';
import type { LoadedNode } from './template/types.js';
import type { GateEntry } from './gate-list.js';

/** Thrown when a profile overlay is malformed or names a node the template does not declare. Loud. */
export class ProfileOverlayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileOverlayError';
  }
}

/** A parsed profile overlay file. `nodes` maps a template node id → the gate additions appended to it. */
export interface ProfileOverlay {
  /** OPTIONAL human note. */
  description?: string;
  /** Per-node gate ADDITIONS — appended to each named node's `gates[]`. */
  nodes: Record<string, GateEntry[]>;
}

/**
 * Read + validate the additive overlay `<templateDir>/profiles/<name>.json`. Returns the parsed overlay,
 * or `null` when the file does not exist (the caller then falls through to the legacy path / an unknown-
 * profile error). A file that exists but is malformed is a LOUD `ProfileOverlayError` (fail-closed, the
 * same stance as the node.json gate). `validate` is the injectable ajv seam (the loader's single ajv).
 */
export async function loadProfileOverlay(
  templateDir: string,
  name: string,
  validate: SchemaValidator,
): Promise<ProfileOverlay | null> {
  const file = path.join(templateDir, 'profiles', `${name}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; // absent ⇒ not an additive overlay
    throw new ProfileOverlayError(`profile "${name}": ${file} is not valid JSON`);
  }
  const res = validate(profileSchema as object, raw);
  if (!res.ok) {
    throw new ProfileOverlayError(`profile "${name}" is invalid — ${res.errors.join('; ') || 'does not match profileSchema'}`);
  }
  return raw as ProfileOverlay;
}

/**
 * APPEND the overlay's per-node gate additions to the loaded nodes' `gates[]`, IN PLACE. Additive: an
 * existing `gates[]` is preserved and the overlay entries follow it (authored-first, overlay-second). A
 * `nodes` key that is not a loaded node id is a LOUD `ProfileOverlayError` listing the known ids. Returns
 * the same `loaded` array (mutated) for chaining.
 */
export function mergeProfileOverlay(loaded: LoadedNode[], overlay: ProfileOverlay): LoadedNode[] {
  const byId = new Map(loaded.map((n) => [n.def.id, n]));
  for (const [id, additions] of Object.entries(overlay.nodes)) {
    const node = byId.get(id);
    if (!node) {
      const known = loaded.map((n) => n.def.id).sort().join(', ');
      throw new ProfileOverlayError(`profile names unknown node "${id}" — the template's nodes are: ${known}`);
    }
    node.def.gates = [...(node.def.gates ?? []), ...additions];
  }
  return loaded;
}
