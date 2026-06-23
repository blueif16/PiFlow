# SDK canonical build plan — promote the consumer glue INTO `@piflow/core`

> **Strategy (set 2026-06-23).** Build the robust, canonical version of each "consumer glue" feature
> **in `@piflow/core` upstream, independently** — NOT a port of game-omni's local `pi-runner/sdk/`.
> game-omni's glue *works*, but it carries gap-workarounds and local habits; the upstream version is the
> best-practice basis future updates build on. Every change here is **ADDITIVE** — the existing game-omni
> consumer keeps running unchanged. **Phase 2 (deferred):** once upstream ships these, migrate the local
> repo to consume them (delete its local copies). Do NOT do the consumer opt-in in this phase.
>
> Source: four read-only planning agents (2026-06-23) over the real code; this doc is their synthesis.
> Each unit is test-first (`test-discipline`): a new failing test mirroring the named existing test file,
> then the impl, then a mutation self-check on the load-bearing assertion.

## Load-bearing canonical decisions (the "best version", with rationale)

- **D1 — OPEN-1 is a RUNNER bug, fix it at the root.** The runner stages three FIXED files —
  `_pi/prompt.md` (`runner.ts:444`), `_pi/tools.ts` (`:451`), `_pi/mcp.json` (`:399/459`) — so parallel
  nodes that share a workspace (the in-place case) clobber each other. game-omni worked around it THREE
  times (the `execCwd` decoupling, the absolute `@promptFile`, the `wf.nodes` `sandbox.workspace` mutation).
  **Fix:** namespace the staged files per node — `_pi/<id>/{prompt.md,tools.ts,mcp.json}` — so EVERY
  provider is collision-safe and the three hacks dissolve. Unconditional (strictly safer; InMemory just
  gains a dir level).
- **D2 — in-place sandbox = a first-class `'local'` kind.** `'inmemory'` *means* wipe-on-dispose
  (`InMemorySandbox.dispose` does `fs.rm(root)`); in-place is the semantic opposite (NEVER delete the user's
  tree). Reusing `'inmemory'` (what game-omni does) is a deliberate lie. Add `'local'` to
  `SandboxProviderKind` (the one designed extension point), model in-place as the **trivial `RunScope`**
  (root = repoRoot; per-node `create`; no-op run-level `dispose`), make `downloadDir` **guarded-identity**
  (throw on a real mismatch, not a silent no-op), and **extract the shared `exec` helper** (the 4 providers
  duplicate it).
- **D3 — the registry stays the single tool authority.** game-omni reads `node.tools` directly in its
  command builder and uses a synthetic `nativeToolRegistry` to NO-OP the bind check — both because the
  registry can't resolve the BARE pi names (`read`/`write`) the workflow authors (it addresses builtins as
  `fs:read`). **Fix:** the builtin registry resolves bare pi names (alias) AND `resolve()` returns
  `excludeTools` (from `node.tools.deny`) in `ResolveResult`. Then `defaultPiCommand` derives both
  `--tools` and `--exclude-tools` from `resolved` — no node.tools read, no hack. The dry-run
  `auditWorkflow` keeps the gate-3 whitespace/collision protection.
- **D4 — the two-base distinction is load-bearing → a spine field, not a closure footgun.** Hook POST
  executors need BOTH the repo root (resolves repo-relative marker paths) and the project base
  (`out/<run>`, where ops write). game-omni threads this out-of-band with a `ctx + resolveProjectBase`
  closure whose `?? workspace ?? runCwd` fallback is the silent-misresolve trap. **Fix:** add
  `HookContext.projectBase` (required, explicit); `runHooks` sets it. The DRIVER→Hook codec becomes
  `makeHookCodec(families)` + batteries-included `DRIVER_FAMILIES`; `extractWorkflow`/`extractSpec` promote
  into core; op executors promote with an injected `assetConventions` (the `sprite/tileset/public-assets`
  vocabulary is game-domain — it does NOT go into core); seed-staging consolidates into ONE core executor.
- **D5 — `runFromConfig` is env-agnostic; the CLI owns the convention.** Core ships
  `runFromConfig(resolvedConfig)` (a plain object — no env parsing) so a library consumer passes an object;
  `loadConfig` + the `PI_RUNNER_*` names live in core's CLI layer behind a `piflow run [--dry-run]`
  subcommand. `returnProtocol` generalizes (any pi node needs the write-then-fence handshake) → a default
  `RunOptions.returnProtocol`. **The bridge stays consumer-injected** (it is workflow-dialect-specific):
  `runFromConfig` takes a `workflowSpec`/`buildWorkflowSpec`, it does NOT own the bridge.

## Build order (each: additive · test-first · its own commit · mirrors the named test file)

| # | Unit | Files | Test mirror | Effort |
|---|---|---|---|---|
| **U1** | Runner per-node staging `_pi/<id>/{prompt,tools,mcp}` (D1) | `runner.ts` | `test/runner.test.ts` (recording-provider writeFile capture) | S–M |
| **U2** | `LocalSandboxProvider` + `'local'` kind + RunScope + exec-helper extract (D2) | `src/sandbox/local.ts`, `types.ts:44`, `index.ts`, `src/sandbox/index.ts` | `test/sandbox.test.ts`, `test/sandbox-worktree.test.ts` | S–M |
| **U3** | Registry: resolve bare builtins + `excludeTools` in `ResolveResult` (D3) | `src/tools/registry.ts`, `types.ts` (ResolveResult), `src/tools/verify.ts` | `test/tools.test.ts` | M |
| **U4** | `defaultPiCommand(node, resolved, ctx, opts?)` — `thinking`, `extraExtensions`, `--exclude-tools` (D3) | `src/runner/command.ts`, `types.ts` | `test/runner.test.ts` (defaultPiCommand block) | S |
| **U5** | `extractWorkflow` → core (D4-A) | `src/workflow/extract.ts`, `index.ts` | new, vs a fixture workflow | S |
| **U6** | `HookContext.projectBase` + `makeHookCodec`/`DRIVER_FAMILIES` + `extractSpec` (D4-B) | `types.ts`, `src/hooks/index.ts`, `src/workflow/{codec,bridge}.ts` | `test/contract.test.ts`, `test/dag.test.ts`, `test/hooks.test.ts` | M |
| **U7** | Promote op executors + `assetConventions` + consolidate seed-staging (D4-C) | `src/workflow/ops/*` | port game-omni `hooks/test/*` | L |
| **U8** | `runFromConfig` + `loadConfig` + `piflow run [--dry-run]` + `RunOptions.returnProtocol` (D5) | `src/runner/{entry,config}.ts`, `src/cli.ts`, `runner.ts` | `test/runner.test.ts` | M |

Sequence: U1 first (unblocks the clean U2/U4 by killing the hacks); U2/U3/U5 are independent; U4 depends on
U3; U6 depends on U5; U7 depends on U6; U8 composes the rest. U7 is the only L — split further if needed.

## Out of scope (Phase 2)
The consumer opt-in: game-omni's `pi-runner/sdk/*` switching to import from `@piflow/core` and deleting its
local copies; the `templates/pi-runner/` shrink to ~Tier 1 + a one-line `run.mjs`; the `parse-claude-workflow`
CLI collapsing onto `extractSpec`. Done only AFTER upstream ships U1–U8 and a parity run is green.
