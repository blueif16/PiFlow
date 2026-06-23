// piCommand — the @piflow/core `CommandBuilder` reproducing run.mjs `piArgs` (run.mjs:1439-1467).
//
// The SDK ships `defaultPiCommand`, but it diverges from run.mjs on two points game-omni depends on:
//   (1) it derives `--tools` from `resolved.piTools` (ALL resolved tools); run.mjs emits `--tools`
//       ONLY from the node's DRIVER-TOOLS allowlist (per-node gating) — and `--exclude-tools` from
//       DRIVER-EXCLUDE-TOOLS. game-omni nodes use pi's NATIVE tools and select none, so the SDK
//       default would pass an empty/garbage `--tools`; we mirror run.mjs and read node.tools.
//   (2) it has no `--thinking`; run.mjs emits it gated on PI_RUNNER_THINKING.
// And the OPEN-1 command side: the prompt is referenced as `@<ABSOLUTE path>` resolved under the
// node's per-node staging workspace (node.sandbox.workspace), so parallel nodes in a stage carry
// DISTINCT prompt refs — never the SDK's fixed relative `_pi/prompt.md` they would collide on. Pairs
// with LocalSandboxProvider({execCwd}) (the provider side): writeFile lands the prompt in the same
// per-node workspace, exec runs in the shared repo root.
//
// Signature is the CommandBuilder contract `(node, resolved, ctx) => string`; `resolved` is
// deliberately UNUSED (parity reads node.tools, not resolved.piTools).

import path from "node:path";
import { fileURLToPath } from "node:url";

// The pi-runner/ dir (this file is pi-runner/sdk/command.mjs) — to resolve the bundled contract ext.
const PI_RUNNER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Shell-quote a single token (the prompt/extension path may contain spaces). Mirrors command.ts `q`. */
function q(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Resolve the node-contract extension exactly as run.mjs (run.mjs:192-195): PI_RUNNER_CONTRACT_EXT
 * "1"/on ⇒ the bundled pi-runner/extensions/node-contract.ts; a path ⇒ that path; "0"/off/empty ⇒
 * none. The ext registers the typed `submit_result` return tool + the in-loop owned-paths block, and
 * loads via explicit `-e` even under --no-extensions. LOAD-BEARING for parity: the workflow's
 * DRIVER-TOOLS list `submit_result`, so WITHOUT this -e it is a dangling tool name and the model
 * returns inline instead of writing its artifact (the never-write divergence gate 3 surfaced).
 */
function contractExtPath() {
  const ce = process.env.PI_RUNNER_CONTRACT_EXT || "";
  if (/^(0|false|off|)$/i.test(ce)) return null;
  if (/^(1|true|on)$/i.test(ce)) return path.join(PI_RUNNER_DIR, "extensions", "node-contract.ts");
  return path.resolve(ce);
}

/**
 * Build the headless `pi` command for one node, parity-faithful to run.mjs `piArgs`.
 * @param {{ sandbox?: { workspace?: string }, tools?: { allow?: string[], deny?: string[] } }} node
 * @param {unknown} _resolved the resolved toolset — UNUSED (parity reads node.tools).
 * @param {{ promptFile: string, model?: string, provider?: string, extensionFile?: string }} ctx
 * @returns {string} the single shell-string command (run under `shell: true`).
 */
export const piCommand = (node, _resolved, ctx) => {
  const provider = ctx.provider ?? "cp";
  // The prompt path the model reads: ABSOLUTE under the node's staging workspace (OPEN-1). An already-
  // absolute ctx.promptFile passes through; a relative one resolves under node.sandbox.workspace.
  const promptAbs = path.isAbsolute(ctx.promptFile)
    ? ctx.promptFile
    : path.resolve(node.sandbox?.workspace || ".", ctx.promptFile);

  const a = [
    "pi", "-p", "--mode", "json", "-a", "--no-session",
    "--offline", "--no-extensions", "--no-context-files",
    "--provider", provider,
  ];
  if (ctx.model) a.push("--model", ctx.model);
  // Cap reasoning depth — gated on PI_RUNNER_THINKING exactly as run.mjs (env, not a per-node field).
  if (process.env.PI_RUNNER_THINKING) a.push("--thinking", process.env.PI_RUNNER_THINKING);
  // Per-node tool gating from the DRIVER-TOOLS / DRIVER-EXCLUDE-TOOLS markers (the bridge → node.tools).
  const allow = node.tools?.allow;
  const deny = node.tools?.deny;
  if (allow && allow.length) a.push("--tools", allow.join(","));
  if (deny && deny.length) a.push("--exclude-tools", deny.join(","));
  // -e order mirrors run.mjs: the bundled node-contract ext first, then any tool-binding extension.
  const contractExt = contractExtPath();
  if (contractExt) a.push("-e", q(contractExt));
  if (ctx.extensionFile) a.push("-e", q(ctx.extensionFile));
  a.push(`@${q(promptAbs)}`);
  return a.join(" ");
};
