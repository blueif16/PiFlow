// pi-runner hook-op engine — MARKER PARSERS + shared pure helpers.
//
// PHASE-1 PORT (sdk-convergence): this is a behavior-preserving extraction of the deterministic
// hook-op engine from pi-runner/run.mjs. run.mjs keeps its own copies (it stays the live engine);
// this package is the reusable, run.mjs-globals-free copy a future SDK consumer binds to. Every
// function here is byte-identical in BEHAVIOR to its run.mjs original; the only change is that the
// run.mjs module globals (RUN_CWD / PROJECT_BASE / ROOT / HERE) are passed in as an explicit `ctx`
// (see index.mjs) instead of closed over.

import fs from "node:fs";
import path from "node:path";

// ── shared pure helpers (ported verbatim from run.mjs) ─────────────────────────────────────────
export function ensureDir(d) { return fs.mkdirSync(d, { recursive: true }); }
// Pretty-print JSON the way the existing artifacts are formatted (2-space indent + trailing newline)
// so a projected file is byte-identical to a hand/LLM-written one.
export const projJson = (obj) => JSON.stringify(obj, null, 2) + "\n";
export const drillPath = (obj, dotted) => String(dotted).split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
export const dedupSort = (xs) => [...new Set(xs.map(String))].sort();

// Conventional asset sub-dir/ext by slot `type` (the generic asset-path convention W2's index.json
// uses — NOT game-specific). Used by the `union` op to fill a slot's conventional default `path`.
export const ASSET_DIR_BY_TYPE = { sprite: "sprites", animation: "sprites", image: "images", tileset: "tiles", background: "backgrounds", audio: "audio", model: "models" };
export const ASSET_EXT_BY_TYPE = { audio: "mp3", model: "glb" };
export function assetDefaultPath(slot, type) {
  const dir = ASSET_DIR_BY_TYPE[type] || "sprites";
  const ext = ASSET_EXT_BY_TYPE[type] || "png";
  return `${dir}/${slot}.${ext}`;
}

// ── marker parsers ─────────────────────────────────────────────────────────────────────────────
// markerPaths: a space-separated multi-path marker (e.g. DRIVER-ARTIFACTS / DRIVER-PREFLIGHT).
export function markerPaths(prompt, key) {
  const m = new RegExp(`(?:^|\\n)\\s*${key}:\\s*(.+?)\\s*(?:\\n|$)`).exec(prompt || "");
  if (!m) return null;
  const paths = m[1].split(/\s+/).filter(Boolean);
  return paths.length ? paths : null;
}
// Single-VALUE marker (the rest of the line as ONE token), e.g. DRIVER-SCHEMA / DRIVER-FILL-SENTINEL.
export function markerValue(prompt, key) {
  const m = new RegExp(`(?:^|\\n)\\s*${key}:\\s*(.+?)\\s*(?:\\n|$)`).exec(prompt || "");
  return m ? m[1] : null;
}
// base64-on-one-line marker (the DRIVER-MERGE convention) → the decoded JSON, tolerating inline JSON
// for a hand-authored marker. Returns null when absent/unparseable.
export function decodeB64Marker(prompt, key) {
  const v = markerValue(prompt, key);
  if (!v) return null;
  try { return JSON.parse(Buffer.from(v.trim(), "base64").toString("utf8")); }
  catch { try { return JSON.parse(v); } catch { return null; } }
}
