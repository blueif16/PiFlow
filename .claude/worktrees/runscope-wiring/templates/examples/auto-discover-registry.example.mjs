#!/usr/bin/env node
// ── EXAMPLE (adapt me) — auto-discovered registration: the worktree merge-back enabler ──
//
// Worktree isolation's one cost is merge-back: if every run hand-appends to a SHARED registration
// list (e.g. a Remotion src/Root.tsx <Composition> list, a routes file, a plugin index), N parallel
// branches collide on that file. Fix: stop hand-editing the shared list. Each unit exports a uniform
// DESCRIPTOR from its OWN file; this generator statically discovers every file that opts in and
// writes a generated index the shared entry-point maps over. Then every run's changes are DISJOINT
// paths and merge-back is a conflict-free union.
//
// THIS IS A REMOTION-LESSON EXAMPLE — tune three things for your project:
//   1) SRC_GLOB / file match     — which files can register (here: Complete*Lesson.tsx)
//   2) OPT_IN_MARKER             — the export that means "I'm ready to register"
//   3) the generated index shape — what your entry-point imports + maps over
//
// The OPT-IN marker matters: a half-built unit WITHOUT the marker is never imported, so broken WIP
// can't break the bundle (unlike a glob/require.context that evaluates everything). Commit the
// generated file (code-as-truth) OR gitignore it + regenerate in a prebuild hook — either way the
// merge-back REGENERATES it (never hand-merges), exactly like a primitive registry.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");                  // ← tune
const DIR = path.join(REPO, "src/lessons");             // ← tune: where the units live
const OUT = path.join(DIR, "_registry.generated.tsx");  // ← tune: the generated index
const FILE_RE = /^Complete.*Lesson\.tsx$/;              // ← tune (1)
const OPT_IN = /export\s+const\s+lessonComposition\b/;  // ← tune (2)
const check = process.argv.includes("--check");

const alias = (base) => base.charAt(0).toLowerCase() + base.slice(1) + "Registration";
const discovered = fs.readdirSync(DIR).filter((f) => FILE_RE.test(f)).sort()
  .filter((f) => OPT_IN.test(fs.readFileSync(path.join(DIR, f), "utf8")))
  .map((f) => path.basename(f, ".tsx"));

// ← tune (3): the generated-index shape your entry-point consumes.
const body = [
  "// GENERATED — do NOT hand-edit. Source of truth = each file that exports the opt-in descriptor.",
  ...discovered.map((b) => `import { lessonComposition as ${alias(b)} } from "./${b}";`),
  "",
  `export const REGISTERED = [\n${discovered.map((b) => `  ${alias(b)},`).join("\n")}\n];`,
  "",
].join("\n");

if (check) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
  if (cur !== body) { console.error(`registry --check FAILED — ${path.relative(REPO, OUT)} stale; run the generator.`); process.exit(1); }
  console.log(`registry --check ok — ${discovered.length} registered.`);
} else {
  fs.writeFileSync(OUT, body);
  console.log(`registry ok — ${discovered.length}: ${discovered.join(", ") || "(none)"}`);
}
