// pi-runner hook-op engine — DRIVER-SEED (the PRE-stage family).
//
// PHASE-1 PORT (sdk-convergence): driverSeed + resolveSeedTokens, ported verbatim from run.mjs. The
// only change is resolveSeedTokens takes `ctx` (for its RUN_CWD-relative file resolution) instead of
// closing over the run.mjs global. driverSeed is pure (prompt → seed list) — no ctx needed.

import fs from "node:fs";
import path from "node:path";

// DRIVER-SEED: <dest> <= <src> — deterministically PRE-STAGE a node's STARTING artifact before pi
// spawns. A node may declare MULTIPLE DRIVER-SEED lines (each <dest> <= <src>); staged in ORDER. <src>
// may carry {jsonfile:field} tokens (resolved by resolveSeedTokens). Returns an ARRAY of {to,from}.
export function driverSeed(prompt) {
  // Per-line, multi-match. The trailing boundary is a LOOKAHEAD (?=\n|$), never a consumed \n — three
  // ADJACENT DRIVER-SEED lines must all match, and consuming the separator would eat the next line's
  // leading anchor and skip every other one.
  const re = /(?:^|\n)[ \t]*DRIVER-SEED:[ \t]*(\S+)[ \t]*<=[ \t]*(\S+)[ \t]*(?=\n|$)/g;
  const seeds = [];
  let m;
  while ((m = re.exec(prompt || ""))) seeds.push({ to: m[1], from: m[2] });
  return seeds;
}

// {relpath.json:field} → the JSON at relpath (resolved vs ctx.runCwd), drilled by `field` as a DOTTED
// PATH (`a.b.0.c`, array indices allowed). Tokens NEST: an inner {…} is resolved first. We iterate to a
// fixpoint over the INNERMOST tokens (those with no nested brace). Bounded passes guard against a cycle.
export function resolveSeedTokens(spec, ctx) {
  const drill = (obj, dotted) => dotted.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
  const oneToken = /\{([^:{}]+):([^{}]+)\}/; // only INNERMOST tokens (no braces inside) match
  let out = spec;
  for (let pass = 0; pass < 8 && oneToken.test(out); pass++) {
    out = out.replace(new RegExp(oneToken, "g"), (whole, file, field) => {
      try {
        const abs = path.isAbsolute(file) ? file : path.resolve(ctx.runCwd, file);
        const v = drill(JSON.parse(fs.readFileSync(abs, "utf8")), field.trim());
        return v == null ? whole : String(v);
      } catch { return whole; }
    });
  }
  return out;
}
