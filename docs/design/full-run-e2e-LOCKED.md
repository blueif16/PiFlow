# LOCKED DESIGN (ROUND-2, FINAL) — piflow honest control-plane full-run E2E suite

**Status:** LOCKED · **Date:** 2026-07-02 · **Supersedes:** the round-1 design in `.tasks/round1-design-and-reviews.md` (which shipped a mechanically-impossible Target 3, a fictional Target 6 seam, an inverted Target 8, and un-covered watchdog/J3/N-127-reach dimensions). **Source of truth:** `docs/design/full-run-simulation.md` (§3 catalog, §4 mode×host table, §5 rubric, §6 tiers, §7 cost). Downstream isolated test-writers implement each **TEST CONTRACT verbatim** without seeing the implementation — every contract is self-contained and code-accurate.

Every `file:line` / JSON-key path below was **read against the current tree** at `/Users/tk/Desktop/piflow/.claude/worktrees/full-run-e2e/`. The real package prefix is `packages/core/src/…` (not `core/src/…`).

---

## THE ONE ANCHORING DECISION (survives from round-1, re-verified)

`assessRunView` (`packages/core/src/observe/assess.ts:35`) reads `a.exists`/`a.bytes` **verbatim** from the run-view, which `buildRunView` copies verbatim from run.json (`runView.ts:319`), which the runner stat'd at run-time. So `assessRunView` is a **necessary run-level/verdict gate but NOT an independent post-hoc probe**. Therefore every tier that claims "the run really produced the artifact" pairs `assessRunView` with an **independent probe** that re-reads the deliverable through a *different code path than the runner*:

- **HTTP tiers (L2, L4, smoke):** `GET /__piflow/file/<run>?path=<artifact>` (`packages/server/src/handlers.ts:284`) — a fresh `readFile` off host disk, realpath-jailed, **404 on miss** (`handlers.ts:293,306`). No new endpoint, no new run.json field.
- **In-process fake tiers (L0/L1):** `readFileSync(resolve(outDir, declaredPath))` — a fresh fs read, different code path than the runner's `artifactState`.

The probe asserts on **expected content** (`CONTROL-VM-OK` / builder bytes), so it reds on empty, garbage, wrong-path (N-breach), or no-op executor. This is the design's non-hackable spine (all three reviews confirmed it sound).

---

## BUILD ORDER (test-first; dependency-ordered — each step: red-test lands first, then the fix greens it)

1. **N-breach SDK passthrough + fix (Target 3)** — add the real `sandbox.output` passthrough across 4 core files (`node.schema.ts`, `types.ts`, `loader.ts`, `render.ts`), then set both greet twins to `contract.output:"."` + `contract.artifacts:["out/greet/greeting.txt"]`. Its **L1 cross-kind parity red-test (Target 5-parity)** is the oracle — it must be GREEN under BOTH `local` (IN_PLACE) and `e2b` (flatten) arms. This unblocks every downstream tier that runs greet. **This is a `@piflow/core` change — the round-1 "deploy-template-only" claim was FALSE.**
2. **Independent-probe helpers (free)** — `piflowFile` already exists; no build. Author the shared test utils: `readArtifactFs(outDir, path)` (in-process) + `fetchArtifact(base, run, path, token)` (HTTP).
3. **N-127 mint fix + reach (Target 2)** — project `E2B_API_KEY`+`E2B_TEMPLATE` in `mintCloudSecrets` (`packages/cli/src/cloud.ts`); mint red-test + spawn-no-env reach test + FakeE2b template-less negative twin, all red-first. Then the `run.ts` fail-loud on missing `E2B_TEMPLATE`.
4. **N-126 message (Target 4)** — add cloud fallbacks to the bwrap warn string; message unit-test first.
5. **N-watchdog data path (new Target 12)** — thread `killedTimeout/killedStall` through `runView.ts` + add the `assess.ts` rubric check; L1 negative twin (killed node + present artifact → `pass===false`).
6. **J3 chained-hash (new Target 13)** — 2-node producer→consumer chain; consumer hashes its staged input, test recomputes `sha256(producerBytes)`; forged-intermediate red companion.
7. **L1 lifecycle + N-mutant + N-inmemory (Targets 5, 7, 8-inmemory)** — the fast fake tiers + their real-pipeline negative twins. **N-ratelimit (Target 8-ratelimit) is ALREADY covered** by `runner.test.ts:584-604` — pointer only.
8. **L2 HTTP replay (Target 6)** — in-process `runFromTemplate` (real artifact + real run.json via `LocalSandboxProvider`) → real handlers via the `resolveRunDir` mock → `assessRunView` + `REPLAY-OK` byte-probe; N-inmemory reproduced by dropping the provider + the `buildStartRunArgv` omit-sandbox unit.
9. **Honest smoke (Target 1)** — rewrite `smoke-live.mjs` C/D/E to force `sandbox:"e2b"`, call `assessRunView`, add the `piflowFile` content probe at the `out/greet/greeting.txt` path (agrees with Target 3), with a cost cap + missing-key fail-loud.
10. **L4 Playwright (Target 9)** + **CI wiring + budgetGuard (Target 10)** — journey test (SSE `data:`-frame interception) + the mode×host matrix + the L0-tested cost cap seam.
11. **Control-plane handover (Target 11)** — verify the live-run command sequence; only the `gui`-follows-context delta is net build.

---

## Target 1 — HONEST SMOKE

### FIX SPEC
Rewrite `deploy/control-vm/smoke-live.mjs` (deploy dir — NOT `packages/*`; it may `import { assessRunView } from '@piflow/core/observe'`).

- **B (:117):** change the start body from `sandbox: "local"` to `sandbox: "e2b"`. Per §4, the control plane on Railway can NEVER run nodes in-VM under bwrap (`local × Railway = N/A`, userns blocked) — `e2b` is the only honest Railway choice. `--sandbox e2b` flows through `buildStartRunArgv` (`start-run.ts:90`, `if (body.sandbox) argv.push("--sandbox", …)`).
- **C (:182):** keep `sawDone` as a **necessary-but-insufficient** gate; relabel it "SSE reached done (necessary, not sufficient)". No longer a PASS by itself.
- **D (:188-211):** DELETE the regexes `hasArtifact = /greeting\.txt/.test(blob) || /out\/greet/.test(blob)` and the `greetOk` status regex. Replace with two steps:
  1. `GET ${runViewUrl}` → parse JSON → `const assessment = assessRunView(view, { expectNodes: ["greet"] })` (default `forbidSandbox:['inmemory']`, `requireArtifacts:true`). Assert `assessment.pass === true` (evidence: `assessment.failures.join("; ")`). This rejects `inmemory`, requires `view.ok`, `greet` status ok + `artifacts[].exists && bytes>0`.
  2. **Independent probe** — `GET ${BASE}/__piflow/file/${run}?path=out/greet/greeting.txt` with `authHeaders`. Assert `resp.status===200 && body.trim()==="CONTROL-VM-OK"`. **The `?path=` MUST be `out/greet/greeting.txt`** — under Target 3's fix the artifact is declared AND lands on host at `out/greet/greeting.txt` under BOTH kinds (traced in Target 3's truth table), so this agrees with `view.nodes.find(n=>n.id==="greet").artifacts[0].displayPath === "out/greet/greeting.txt"`. (Round-1's `?path=greeting.txt` contradicted Target 3 and would 404 — FIXED here per Review 3 #5.)
- **E (:230-238):** replace `jailedRunLanded = sawDone` with the honest composite: PASS iff `assessment.pass && probeMatched`.
- **Prompt:** UNCHANGED. `deploy/control-vm/e2e-template/.piflow/greet/template/nodes/greet/prompt.md:5` **already** writes `out/greet/greeting.txt` with content `CONTROL-VM-OK` then `submit_result status "ok"`. The round-1 "update the prompt to emit CONTROL-VM-OK" was a verified no-op (Review 1 #3). The real fix is entirely the contract (Target 3), not the prompt.

### COST CAP + FAIL-LOUD (Review 1 #6, Review 3 #5)
- **Cost cap on the smoke itself:** `timeout-minutes: 12`, **0 retries** on assertion steps (a retry = a new paid e2b session), pass `--max-turns` to the agent, NO `continue-on-error`. The smoke's own budget is bounded by the §7 `budgetGuard` seam (Target 10) before the POST.
- **Missing-key fail-loud:** before the POST, if `sandbox==="e2b"` and `process.env.E2B_TEMPLATE` is unset, the smoke ABORTS with `E2B backend not projected — set E2B_TEMPLATE (see deploy/e2b/build.md)`, NOT a generic assess failure. (Mirrors the `run.ts` fail-loud in Target 2.)
- **Operational precondition (Review 3 #5):** the smoke asserts the *deployed* plane's behavior, so it is only honest **after N-127 has been redeployed to the Railway plane**. Document in the smoke header + the release runbook: *"Run this smoke only against a plane deployed at or after the N-127 commit; a stale plane 127s or falls through to a non-e2b backend and the assess gate reds with a confusing signal."*

### RELEASE-GATE DECISION (Review 1 #6)
Do **NOT** put the uncapped live-e2b smoke on the release critical path. Gate `release.yml` on the **free L2 HTTP tier (Target 6)** + require a **green nightly live-e2b** (Target 9/10 `e2e-live.yml`) within the last N hours (a heartbeat check), rather than a fresh paid e2b call per release. The live smoke stays as nightly + dispatch + a manual pre-publish sanity, cost-capped.

### TEST CONTRACT — L0 composite guard (the live driver is guarded by a pure unit so a broken smoke can't silently pass)
- **Seam under test:** `assessRunView` (`assess.ts:35`) + the `fetchArtifact` HTTP helper.
- **Tier / cadence:** driver = **L3** (nightly + dispatch + heartbeat-required-in-release). Composite guard = **L0** (every push).
- **Falsifiable assertions (`packages/core/test/assess-probe.test.ts`):** build a RunView fixture with `sandbox:'e2b'`, `ok:true`, `done:true`, node `greet` status `ok`, one artifact `{displayPath:'out/greet/greeting.txt', exists:true, bytes:13}`. Assert `assessRunView(view,{expectNodes:['greet']}).pass === true`.
- **Injected fault (RED against PRODUCTION `assess.ts`):** flip the fixture artifact to `exists:false` → `assessRunView(...).pass === false` with a failure naming `out/greet/greeting.txt`. This reds only because `assess.ts:71` reads `a.exists` — deleting that check reds the standing `exists:true` positive too. (Not a test-option flip.)
- **No-op litmus:** a no-op executor yields `exists:false` / `ok:false` and the probe `GET /file` 404s → both the assess gate and the byte-match fail. **PASS.**
- **Reuse seam:** `assess.ts:35`, `deploy/docker/smoke-live.mjs:83-93` (byte-match shape lifted onto HTTP), `handlers.ts:284`.

---

## Target 2 — N-127 (control plane projects the e2b worker backend) — RC-CORRECTED

### FIX SPEC (`packages/cli/src/cloud.ts` — CLI deploy layer, NOT `@piflow/core`; SDK boundary respected)

**Edit A — deploy constant** (next to `CONTROL_VM_DEMO_PRODUCT`, ~`cloud.ts:351`):
```ts
/** The pre-built E2B template ID baked with pi (deploy/e2b/build.md). Deploy config — NEVER in @piflow/core. */
export const DEFAULT_E2B_TEMPLATE = 'riwrtwrfanz3tewd5pw6';
```

**Edit B — thread `e2bTemplate` into the mint opts** (`cloud.ts:164`, the real signature is `opts: { appUrl; provider?; providerSecret }`):
```ts
opts: { appUrl: string; provider?: string; providerSecret: string; e2bTemplate?: string },
```

**Edit C — project the two vars.** Append after the OAuth block, BEFORE the defense-in-depth `FORBIDDEN_SECRETS` sweep (insert between `cloud.ts:213` and `:215` so `E2B_API_KEY` passes the final sweep at :216-220). Resolve `E2B_API_KEY` through the **same `cloudCred` allowlist seam** the provider creds already use (`cloud.ts:204`) — NOT a raw `resolver` call — so it takes the identical `isCloud:true` mint-not-forward path AND the existing `fixedMintDeps().cloudCred` fake covers it with zero harness change:
```ts
// N-127: without these the control plane's e2b worker boots a pi-less base image → 'pi: command not found'
// → exit 127. E2B_API_KEY is a real SECRET (allowlist seam, mint-not-forward); E2B_TEMPLATE is deploy CONFIG
// (staged in-clear via displayValue).
const e2bEnv = await cloudCred(['E2B_API_KEY'], true, MINT_NODE_ID, resolver);
if (e2bEnv.E2B_API_KEY) secrets.push({ name: 'E2B_API_KEY', value: e2bEnv.E2B_API_KEY });
else missing.push('E2B_API_KEY');
const e2bTemplate = opts.e2bTemplate ?? DEFAULT_E2B_TEMPLATE;
secrets.push({ name: 'E2B_TEMPLATE', value: e2bTemplate, displayValue: e2bTemplate });
```
- `CloudSecret.displayValue` **exists** (`cloud.ts:99-104`, verified). Masking is **`displayValue`-presence-driven** in `secretsSetStep` (`cloud.ts:282`: `${s.name}=${s.displayValue ?? '***'}`) — present ⇒ shown in-clear, absent ⇒ `***`. So `E2B_TEMPLATE` (config, has `displayValue`) renders in-clear; `E2B_API_KEY` (bare `{name,value}`) renders `***`. **Correction vs round-1:** the analogy "renders in-clear like `modelsJson`" is FALSE — `modelsJson` is a top-level `MintedSecrets` field, not a `CloudSecret`; the correct precedent is the `displayValue` field itself (Review 3 #2, RC).
- Unresolved `E2B_API_KEY` ⇒ `missing.push`, NEVER staged empty (mirrors the `missing`-not-empty-stage law at `cloud.ts:208`).
- **Do NOT** add `E2B_API_KEY` to `FORBIDDEN_SECRETS` — it is not an `ANTHROPIC_*` var, so it has no `claude -p` billing-precedence hazard.
- `E2B_DOMAIN`: NOT projected (optional self-host override; the SDK defaults the public domain).

**Edit D — source `e2bTemplate` in the CLI dispatch.** In `runCloudUp` (`cloud.ts:~505`) thread `e2bTemplate: process.env.E2B_TEMPLATE ?? DEFAULT_E2B_TEMPLATE` into the `mintCloudSecrets` call (mirrors how `run.ts:649` reads the env, override-able). A `--e2b-template` flag on `CloudUpOpts` is optional (env+default suffices; keep minimal).

**Edit E — FAIL LOUD in `run.ts` (the silent-127 latent bug, RC §4).** `packages/cli/src/run.ts:649-666` reads `const template = process.env.E2B_TEMPLATE;` and, when absent, calls `makeE2bProvider` with NO template → the SDK boots the **default base image (no pi)** → `pi: command not found` → exit 127. Today `run.ts:665` is a `print()`, not a throw (verified). Add at `:649`:
```ts
const template = process.env.E2B_TEMPLATE;
if (!template && !process.env.PIFLOW_E2B_ALLOW_BASE) {
  throw new Error(
    `--sandbox e2b requires E2B_TEMPLATE (the pi-baked template id) — without it the sandbox boots the ` +
    `E2B default base image with no pi installed → 'pi: command not found' → exit 127. ` +
    `Set E2B_TEMPLATE (see deploy/e2b/build.md), or set PIFLOW_E2B_ALLOW_BASE=1 to boot the bare base image deliberately.`);
}
```
This converts a confusing generic "artifact missing" (mis-triaged as a workflow bug) into an actionable config error **before a paid VM boots**, and aligns with the sibling loud-on-missing-key philosophy the e2b comment at `run.ts:642-643` already documents. Escape hatch = `PIFLOW_E2B_ALLOW_BASE` (fail-loud-by-default, not fail-closed-absolute). **Grep before landing** — `grep -rn "sandbox.*e2b" packages/*/test` — and confirm no existing test runs `--sandbox e2b` intentionally without `E2B_TEMPLATE`.

### TEST CONTRACT (a) — mint projection unit (`packages/cli/test/cloud.test.ts`, extends `describe('mintCloudSecrets')`)
- **Seam:** `mintCloudSecrets` (`cloud.ts:163`), reusing `fixedMintDeps()` (`cloud.test.ts:27-33`).
- **Tier / cadence:** **L0**, every push.
- **Falsifiable assertions (observable = returned `secrets[]`/`missing[]` + one render):**
  ```ts
  const m = await mintCloudSecrets(
    { appUrl: flyAppUrl('a'), providerSecret: 'NEBIUS_API_KEY', e2bTemplate: 'riwrtwrfanz3tewd5pw6' },
    fixedMintDeps());
  expect(m.secrets.map(s => s.name)).toContain('E2B_API_KEY');
  const tmpl = m.secrets.find(s => s.name === 'E2B_TEMPLATE')!;
  expect(tmpl.value).toBe('riwrtwrfanz3tewd5pw6');
  expect(tmpl.displayValue).toBe('riwrtwrfanz3tewd5pw6');            // present ⇒ in-clear
  expect(m.secrets.find(s => s.name === 'E2B_API_KEY')!.displayValue).toBeUndefined(); // absent ⇒ ***
  ```
  Plus one render assertion proving the mechanism (per `cloud.test.ts:134-139` idiom):
  ```ts
  const plan = buildFlyDeployPlan({ app:'a', appUrl:m.appUrl, config:'c', dockerfile:'d', token:m.token, secrets:m.secrets });
  const set = plan.steps.find(s => s.id === 'secrets-set')!;
  expect(set.display).toContain('E2B_TEMPLATE=riwrtwrfanz3tewd5pw6');  // config: in the clear
  expect(set.display).toContain('E2B_API_KEY=***');                    // secret: redacted
  expect(set.command).toContain(`E2B_API_KEY=${PROVIDER_VALUE}`);       // execute form has the real value
  ```
- **Injected fault #1 (RED against PRODUCTION — un-projected backend):** run **current unfixed** `mintCloudSecrets` (no `e2bTemplate` opt, no Edit C) → `secrets.map(s=>s.name)` is `['PIFLOW_TOKEN','NEBIUS_API_KEY','CLAUDE_CODE_OAUTH_TOKEN']` only → `toContain('E2B_API_KEY')` and the `E2B_TEMPLATE` find both fail. RED before the fix.
- **Injected fault #2 (never-stage-empty):** `fixedMintDeps({ cloudCred: async () => ({}) })` → `m.missing` contains `'E2B_API_KEY'` AND `m.secrets` does NOT contain `E2B_API_KEY`; `E2B_TEMPLATE` still present (config, always staged). Mirrors `cloud.test.ts:63-73`.
- **No-op litmus:** N/A (pure function); the fault is the un-projected backend, detected directly.

### TEST CONTRACT (b) — the REACH test (the mint's projected var actually reaches the worker child) — RC §(b)
The mint test proves projection, NOT that the var reaches the child's `process.env`. The load-bearing link is that `start-run.ts` spawns the child with **NO `env` override** (verified `start-run.ts:132-134` — the options object is `{ cwd, detached: true, stdio: "ignore" }`, no `env` key), so Node defaults `env` to `process.env` and the child inherits `E2B_TEMPLATE`/`E2B_API_KEY`.
- **Seam:** `makePiflowStartRun()(req,res,next)` → `node:child_process.spawn` (real).
- **Tier / cadence:** **L2**, every PR (free). File `packages/server/test/start-run-env-reach.test.ts` (or extend `start-run.test.ts`).
- **Falsifiable assertions:**
  ```ts
  import * as cp from 'node:child_process';
  const spy = vi.spyOn(cp, 'spawn').mockReturnValue(
    Object.assign(new EventEmitter(), { unref: () => {}, on: () => {} }) as any);
  // drive makePiflowStartRun with a body { templateDir, sandbox:'e2b' } via the file's existing harness
  const opts = spy.mock.calls[0][2];                 // 3rd arg = spawn options
  expect(opts).not.toHaveProperty('env');            // ← the load-bearing inheritance link
  expect(opts).toMatchObject({ detached: true, stdio: 'ignore' });
  ```
- **Injected fault (RED against PRODUCTION):** a future refactor adding `env: { ...scrubbed }` to the spawn options (dropping the inherited `E2B_TEMPLATE`) reds `expect(opts).not.toHaveProperty('env')` — catching the exact regression that would silently re-break N-127 reach. This mutates the real `start-run.ts` spawn call, not a test option.
- **No-op litmus:** N/A (asserts the spawn contract shape, not an artifact) — this is the reach dimension, paired with the negative twin (c) for the produce dimension.

### TEST CONTRACT (c) — the N-127 negative twin (template-less run fails the rubric) — RC §(c), Review 2 #4
`§3 N-127`'s falsifiable form is "e2b boots a pi-less base (no template) → node produces no artifact → the rubric fails." Model the fault as "the e2b worker produced no artifact" (exactly what a pi-less base yields: exit 127, nothing written), using the FakeE2b seam.
- **Seam:** `runWorkflow` (kind `'e2b'`) → `buildRunView` → `assessRunView`.
- **Tier / cadence:** **L1**, every push (free, no VM/model). File `packages/e2b/test/n127-negative-twin.test.ts` (or extend `sandbox-e2b-parity.test.ts`).
- **Falsifiable assertions:**
  ```ts
  import { buildRunView, assessRunView } from '@piflow/core/observe';
  const provider = new E2bSandboxProvider(new FakeE2bSdk(), { homeDir });   // kind === 'e2b'
  const g = compile(wf([node('Greet', [], ['out/greet/greeting.txt'])]));
  await runWorkflow(g, { run:'n127', outDir, provider, buildCommand: stubBuilder(() => []), nodeTimeoutMs:15000 }); // writes NOTHING
  const { view } = buildRunView(outDir);
  expect(view.sandbox).toBe('e2b');                        // real backend ran — NOT rejected as inmemory
  const a = assessRunView(view, { expectNodes: ['greet'] });
  expect(a.pass).toBe(false);                              // the rubric CATCHES the silent 127
  expect(a.failures.join(' ')).toMatch(/greeting\.txt.*missing|missing.*greeting\.txt/i);
  ```
- **Injected fault (RED against PRODUCTION — the inversion that proves teeth):** swap `stubBuilder(() => [])` for `stubBuilder((n) => ['out/greet/greeting.txt'])` (writes the declared artifact) → `a.pass` flips to `true`. The standing test asserts `pass===false`; the no-write is the permanently-injected fault. `assess.ts:71` (`if (!a.exists)`) is the production line that must stay wired.
- **Why honest (not the mint restated):** `view.sandbox==='e2b'` means `forbidSandbox:['inmemory']` does NOT fire — the run genuinely used a real backend; the ONLY thing that reds is the missing on-disk artifact. Distinguishes N-127 (missing artifact on a real backend) from N-inmemory (backend-gate red).
- **No-op litmus:** a no-op worker (writes nothing) is rejected by construction. **PASS.**
- **Reuse seam:** `sandbox-e2b-parity.test.ts:48` (`FakeE2bSdk`), `:186` (`stubBuilder`), `:326-349` (blocked-path harness), `@piflow/core/observe` (`index.ts:15,23`).

---

## Target 3 — N-BREACH (greet output-path parity) — RA-CORRECTED (real SDK passthrough; traced through BOTH kinds)

### Root cause (verified, all three reviews + RA)
The greet `node.json` declares `contract.artifacts:["greeting.txt"]` but the prompt writes `out/greet/greeting.txt` — they already disagree, and the compile hardcodes `sandbox.output = out/greet` (`render.ts:110`, derived from the node id). Round-1's `sandbox.output:"."` "deploy-template-only" lever is **un-loadable**: the `contract` schema is `additionalProperties:false` (`node.schema.ts:135-137`) with keys ONLY `{artifacts, owns, readScope, execCwd, execReads, fullAccess, schema, returnMode, fillSentinel}` — **no `output`/`sandbox` key** (verified). The loader threads no `output`. And with `output` id-derived, **no single artifact string reconciles the two kinds**: e2b's `downloadDir` re-roots each file at `path.posix.relative(remoteRoot, entry.path)` (`e2b.ts:363`), stripping the `out/greet/` prefix, while local IN_PLACE strips nothing — so any fix that greens one arm reds the other (Reviews 1/3 proved the inversion). The **only** config that greens both is `output:"."` (identity, no strip) + the declared artifact = the exact write path. That requires a **real `@piflow/core` passthrough**.

### FIX SPEC — a genuine node-level `sandbox.output` passthrough (4 core edits + 2 deploy edits)

**This is a `@piflow/core` change** (generic mechanism, no product-specific value enters the SDK — the SDK boundary holds; the round-1 "deploy-template-only, SDK boundary respected" claim was FALSE and is corrected here).

1. **Schema** — `packages/core/src/workflow/template/schema/node.schema.ts`, inside the `contract` `properties` block (after `fillSentinel`, before the block's closing brace ~`:191`):
   ```json
   "output": { "type": "string", "minLength": 1,
     "description": "Node output-collection root, workdir-relative. Omitted ⇒ out/<id> (isolated kinds downloadDir this back). Set \".\" for identity (no flatten)." }
   ```
   (`additionalProperties:false` at `:135` is why the key MUST be added here.)
2. **TemplateNode `contract` type** — `packages/core/src/workflow/template/types.ts`, add an optional `output?: string` alongside `execCwd`/`execReads`/`fullAccess` in the `contract` shape the loader reads.
3. **Loader thread** — `packages/core/src/workflow/template/loader.ts`, in the `sandbox:{…}` block (next to the `execCwd`/`execReads`/`fullAccess`/`timeoutMs` conditional spreads, `:153-160`), add:
   ```ts
   ...(c.output ? { output: c.output } : {}),
   ```
4. **Render override** — `packages/core/src/workflow/template/render.ts:110`, change the hardcoded literal to honor the authored value (`c` is `def.contract`, `render.ts:99`):
   ```ts
   sandbox: { provider: 'inmemory', workspace: '.', read: c.readScope, write: c.owns, output: c.output ?? `out/${def.id}` },
   ```
5. **Deploy templates (both twins)** — the declared artifact = the exact write path + pin output to identity:
   - `deploy/control-vm/e2e-template/.piflow/greet/template/nodes/greet/node.json`: `contract.artifacts` → `["out/greet/greeting.txt"]`; add `contract.output: "."`; keep `contract.owns: ["out/**"]`. **Prompt UNCHANGED** (already writes `out/greet/greeting.txt`).
   - `deploy/e2b/e2e-template/nodes/greet/node.json`: SAME edits (identical latent bug in the twin). Its prompt already writes `out/greet/greeting.txt`.

**Opt-in / no-regression:** the passthrough defaults to `out/<id>` (Edit 4's `?? \`out/${def.id}\``), so every existing node compiles byte-identical — no regression to parity/pid/warm-resume tests.

### FIXED-STATE TRUTH TABLE (RA — traced through BOTH kinds; BOTH pass)

| | in-VM/workdir write path `P` | `node.sandbox.output` | `downloadDir` behavior | final host path | contract stat `resolve(outDir, D)` | verdict |
|---|---|---|---|---|---|---|
| **local (danger-full-access, IN_PLACE)** | cwd = `outDir`; writes `out/greet/greeting.txt` → `outDir/out/greet/greeting.txt` | `"."` → IN_PLACE returns `outputDir:"."`; download SKIPPED | none (skipped) | `outDir/out/greet/greeting.txt` | `outDir/out/greet/greeting.txt` | **MATCH → ok** |
| **e2b** | cwd = `workdir`; writes `<workdir>/out/greet/greeting.txt` | `"."` | `downloadDir(".", outDir)`: `remoteRoot=<workdir>`; `rel = out/greet/greeting.txt` (nothing stripped); dest = `outDir/out/greet/greeting.txt` | `outDir/out/greet/greeting.txt` | `outDir/out/greet/greeting.txt` | **MATCH → ok** |

Both kinds land the file at `outDir/out/greet/greeting.txt` — exactly where the contract stats it. `readFileSync(resolve(outDir,'out/greet/greeting.txt'))` returns `CONTROL-VM-OK` under BOTH. `D = "out/greet/greeting.txt"`. (The `output:"."` e2b collection copies the whole node workspace, not just `out/greet` — negligible for greet; opt-in per node so heavy producers keep the `out/<id>` default.)

### TEST CONTRACT — cross-kind parity red-test (the N-breach signature) — L1
- **Seam:** `runWorkflow(compile(greetWf), { outDir, provider })` over a node compiled with `contract.output:"."` + `artifacts:["out/greet/greeting.txt"]`.
- **Tier / cadence:** **L1**, every push (fakes, no model). File `packages/e2b/test/sandbox-e2b-parity.test.ts` (extend — it has the FakeE2b provider at `:48`), or a sibling.
- **Harness (both arms):** compile a 1-node "greet" workflow declaring `output:"."` + `artifacts:["out/greet/greeting.txt"]`. Builder writes `CONTROL-VM-OK` at the RELATIVE path `out/greet/greeting.txt` (mirror `relativeWriteBuilder`, `in-place-artifact.test.ts:23` — `mkdir -p <dir> && printf … > <path>`, NO `output/` prefix, exactly how the agent writes). Run twice:
  - **Arm A — IN_PLACE:** `provider = new LocalSandboxProvider({ enforceReadScope: false })` (kind `'local'` ⇒ IN_PLACE; workdir=outDir; download skipped). (Proven danger-full-access harness, `in-place-artifact.test.ts:66`.)
  - **Arm B — e2b:** `provider = new E2bSandboxProvider(new FakeE2bSdk(), { homeDir })` (kind `'e2b'` ⇒ workdir + `downloadDir(".", outDir)` real flatten over host tmp).
- **Falsifiable assertions (BOTH arms):**
  1. `status.nodes.greet.status === 'ok'` (verdict ladder `node-lifecycle.ts:769`).
  2. **Independent post-hoc probe:** `readFileSync(path.resolve(outDir, 'out/greet/greeting.txt'), 'utf8').trim() === 'CONTROL-VM-OK'` — fresh read at the contract stat path, NOT `view.artifacts[].exists`.
  3. Path-equality invariant: the file exists at `resolve(outDir,'out/greet/greeting.txt')` and NOT duplicated at bare `resolve(outDir,'greeting.txt')`.
- **Injected fault (RED against PRODUCTION — the N-breach signature):** set `contract.output` back to the compile default `out/greet` (drop the identity override) while builder writes `out/greet/greeting.txt`. Traced:
  - `output:"out/greet"` + `artifacts:["out/greet/greeting.txt"]`: **Arm A (local) GREENS** (no strip → `outDir/out/greet/greeting.txt` matches), **Arm B (e2b) REDS** — `downloadDir("out/greet", outDir)` strips `out/greet/` → file at `outDir/greeting.txt`, contract stats `outDir/out/greet/greeting.txt` → MISS → `blocked` + assertion 2 `readFileSync` throws. **e2b reds.**
  - `output:"out/greet"` + bare `artifacts:["greeting.txt"]`: **Arm A (local) REDS**, **Arm B (e2b) GREENS**. **local reds.**
  Either mutation reds EXACTLY ONE arm — that asymmetry is the N-breach discriminator a single-kind test structurally cannot catch. The FIXED state (`output:"."` + `artifacts:["out/greet/greeting.txt"]`) is the ONLY config where BOTH arms green.
- **No-op litmus:** a stub builder that writes nothing → assertion 2's `readFileSync` throws under BOTH kinds; assertion 1 is `blocked`. **PASS.** (Mirrors `sandbox-e2b-parity.test.ts:326-349`, which proves both backends report `blocked` identically on a no-op.)
- **Reuse seam:** `sandbox-e2b-parity.test.ts:48` (FakeE2b), `in-place-artifact.test.ts:23,66` (relativeWriteBuilder + IN_PLACE harness), `status.ts:296` (`artifactState` — the stat path the probe bypasses).

---

## Target 4 — N-126 (bwrap guidance message lists cloud fallbacks)

### FIX SPEC (`packages/core/src/sandbox/bwrap.ts:138-143`)
The fail-closed 126 is CORRECT (Railway blocks userns, §4); only the guidance is thin. Extend `warnNoBwrapOnce`'s message tail from `…or pass --sandbox danger-full-access to run unsandboxed.` to:
`…or run this node in a cloud sandbox instead: --sandbox e2b, --sandbox docker, or --sandbox daytona (or, as a last resort on a trusted single-tenant host, --sandbox danger-full-access to run unsandboxed).`

### TEST CONTRACT — message-only unit — L0
- **Seam:** `warnNoBwrapOnce` via `__setBwrapAvailableForTest(false)` (`bwrap.ts:125`) + `__resetBwrapWarningForTest()` (`bwrap.ts:147`).
- **Tier / cadence:** **L0**, every push. Existing `sandbox-bwrap.test.ts`.
- **Falsifiable assertion (observable = the emitted `console.warn` string, `vi.spyOn(console,'warn')`):** after resetting the latch and triggering the no-bwrap path, the captured message **contains all three** of `--sandbox e2b`, `--sandbox docker`, `--sandbox daytona`. Plus: the warn fires **exactly once** across two triggers (`spy` call count `=== 1`) — covers the warn-once latch.
- **Injected fault (RED against PRODUCTION):** against the current unfixed message (`bwrap.ts:139-142`, names only `danger-full-access`), the `--sandbox e2b` substring is absent → RED. This asserts the code's own emitted diagnostic — NOT config/template text (§5 std #1 forbids config substrings, not diagnostics).
- **No-op litmus:** message-only — N/A executor; the observable is the code's own output.

---

## Target 5 — L1 LIFECYCLE (fakes, falsifiable content assertion)

### FIX SPEC
NO production change — NEW test `packages/core/test/lifecycle-e2e.test.ts` exercising `runWorkflow` bind→stage→exec→collect→verify end-to-end through fakes.

### TEST CONTRACT
- **Seam:** `runWorkflow(compile(wf), { outDir, provider, buildCommand })`.
- **Tier / cadence:** **L1**, every push (free, no model).
- **Harness:** compile a 1-node workflow declaring `artifacts:['out/result.md']`. `provider = new InMemorySandboxProvider()` OR the `ExecRunner` fake (`runner.test.ts:507-538`). `buildCommand = contentBuilder({'out/result.md':'LIFECYCLE-OK'})` (`runner.test.ts:69`).
- **Falsifiable assertions (observable = verdict + fresh fs read):**
  1. `status.nodes.<id>.status === 'ok'`.
  2. **Independent probe:** `readFileSync(path.resolve(outDir,'out/result.md'),'utf8').trim() === 'LIFECYCLE-OK'` — fresh read, different path than the runner's `artifactState`.
  3. `status.ok === true`.
- **Injected fault (RED — real pipeline, not a test-option flip):** run the SAME pipeline with a builder that writes to a DIFFERENT path than the declared artifact (`contentBuilder({'out/other.md':'X'})`, node still declares `out/result.md`). The real runner's artifact gate (`node-lifecycle.ts:552-555`) sets verdict `blocked`/`gap` (missing declared artifact) AND assertion 2's `readFileSync` throws. This is a real "executor produced nothing at the contract path" run, catching a regression that weakens the artifact gate.
- **No-op litmus:** `stubBuilder` that writes nothing → assertion 2 throws, assertion 1 is `blocked`. **PASS** — cannot pass on a no-op.
- **Reuse seam:** `runner.test.ts:48,69,507-538`, `InMemorySandboxProvider`.

---

## Target 6 — L2 HTTP REPLAY (POST → SSE → run-view → probe, sandbox≠inmemory) — RB-CORRECTED (real seam)

### The seam reality (RB, Review 1 #2)
`makePiflowStartRun` → `spawn(process.execPath, [cliBin, ...argv], {cwd, detached, stdio})` (`start-run.ts:132-136`) launches a **real independent `piflowctl run` OS process** that re-resolves the provider from `--sandbox` + `process.env` (`run.ts:649` for e2b). `StartBody.provider` is a **string** gateway name, not a `SandboxProvider` object; `buildStartRunArgv` maps ONLY flags. **There is NO cross-spawn provider/buildCommand/env-override channel** — the round-1 "provider-injection across the spawn" seam does not exist. The honest L2 seam bypasses the spawn: drive a REAL in-process `runFromTemplate` run to POPULATE a real run dir (real artifact + real run.json, non-inmemory kind), then run the actual HTTP handlers over it via the `resolveRunDir` mock.

### FIX SPEC
NEW test `packages/server/test/http-replay-e2e.test.ts`. Two units:

**L2a (HTTP-contract, has teeth):** in-process
```ts
runFromTemplate(templateDir, {
  run, outDir,
  provider: new LocalSandboxProvider(),                          // kind 'local' → non-inmemory; files land in outDir
  buildCommand: contentBuilder({ '<declaredArtifact>': 'REPLAY-OK' }),  // real shell write, no pi/model
});
```
`RunFromTemplateOpts extends RunOptions` which carries `buildCommand?`, `provider?` — injectable **in-process** (the injection the spawn destroys is available here). The runner writes the artifact bytes + `run.json` HONESTLY (NOT hand-forged) and stamps `status.sandbox = provider.kind` → `'local'` (≠ inmemory, `runner.ts:435`). Then mock `resolveRunDir` → this `outDir` and drive the **real** `piflowRunView` + `piflowFile` (+ optionally `piflowRunStream`) handlers with a fake `req`/`res`.

**L2b (start-argv unit, the N-inmemory reproduction):** a pure unit on `buildStartRunArgv` — `--sandbox` is appended ONLY when `body.sandbox` is set (`start-run.ts:90`, `if (body.sandbox) …` — verified). This is the exact Railway false-green mechanism (a POST omitting `sandbox` → the child parses `sandbox:'inmemory'` at `run.ts:242`).

### TEST CONTRACT
- **Seam:** `runFromTemplate` (in-process) → `piflowRunView` (`handlers.ts:103`) + `piflowFile` (`handlers.ts:284`) via the `resolveRunDir` mock; and `buildStartRunArgv` (pure).
- **Tier / cadence:** **L2**, every PR to `main`, path-filtered (`packages/**`, `gui/**`, `**/.piflow/**`), free.
- **Falsifiable assertions (L2a):**
  1. `piflowRunView` → 200, and `assessRunView(view, { expectNodes:[<node>] }).pass === true` (default `forbidSandbox:['inmemory']` — simultaneously asserts `view.sandbox==='local'`, `view.ok`, node status ok, artifact `exists && bytes>0`).
  2. **Independent probe:** `piflowFile` on `?path=<declaredArtifact>` → 200, and `body.toString().trim() === 'REPLAY-OK'` — a fresh host-disk `readFile` (`handlers.ts:316`), different code path than the runner's stat.
  3. (optional) consume `piflowRunStream` until `{kind:'done'}` (necessary-not-sufficient; the handler breaks on `kind==="done"`, `handlers.ts:92`).
- **Injected fault A (RED against PRODUCTION — N-inmemory, the exact Railway false-green):** re-run the SAME `runFromTemplate` with the **`provider` OMITTED** → the runner defaults to `InMemorySandboxProvider` (`runner.ts:29`, kind `'inmemory'`) → real `view.sandbox==='inmemory'` → assertion 1 flips to `pass===false` with a failure naming `inmemory` (`assess.ts:43`). This runs the real pipeline with a real inmemory backend — deleting the `forbid.has(view.sandbox)` check in `assess.ts:43` also reds the standing positive. (Not a test-option flip.)
- **Injected fault B (no-op litmus):** swap `contentBuilder` for a builder that writes NOTHING to the declared artifact → `assessRunView.pass===false` (`exists:false`) AND `piflowFile` returns 404. Both assertions red.
- **L2b assertion (the argv discriminator):** `buildStartRunArgv(TPL, RUN, { sandbox:'e2b' })` CONTAINS `--sandbox e2b`; `buildStartRunArgv(TPL, RUN, {})` does NOT contain `--sandbox` — the pure proof that an omitted `sandbox` yields the inmemory default downstream. Extends `start-run.test.ts:42-48`.
- **Scoping waiver (RB):** L2a bypasses the spawn, so it does NOT prove cross-spawn env-reach (that is TEST CONTRACT (b) of Target 2) nor the real e2b flatten (that is the live L3 tier + Target 3's parity test) nor the real pi/model executor (live tier). Named explicitly.
- **Reuse seam:** `run-digest-endpoint.test.ts:14-57` (the `resolveRunDir` mock + `call()` handler-driver harness — reuse verbatim, but REPLACE its forged `writeRun(okRun())` fixture with a real `runFromTemplate` run so run.json is genuine), `runner.test.ts:48-84,126,142` (builders + collected-bytes-from-outDir precedent), `assess.ts:35`, `handlers.ts:103,284`.

---

## Target 7 — N-mutant GUARDRAIL (rubric-has-teeth negative control)

### FIX SPEC
NEW test `packages/core/test/mutant-guardrail.test.ts`. A node that **structurally cannot** produce its declared artifact — declare `artifacts:['out/must-exist.md']` and a `buildCommand` that exits 0 but writes NOTHING (or writes a DIFFERENT path). Run it through the SAME `runWorkflow` pipeline as L1.

### TEST CONTRACT
- **Seam:** `runWorkflow` + `buildRunView` + `assessRunView` (the full rubric, real pipeline).
- **Tier / cadence:** **L1 guardrail**, every push (fake) + periodic (§5 std #4).
- **Falsifiable assertions:** build the run-view from the mutant run; `assessRunView(view, { expectNodes:['mutant'] }).pass === false` AND `assessment.failures` contains a string naming the missing artifact. Independently, `existsSync(resolve(outDir,'out/must-exist.md')) === false`.
- **Injected fault (RED against PRODUCTION — the inversion that proves teeth):** this test's STANDING assertion (`pass===false` on a real no-op run) IS the teeth. To prove it catches a real code regression: mutate `assess.ts` to default `requireArtifacts=false` OR delete the `if (!a.exists)` check at `assess.ts:71` → `assessment.pass` flips to `true` on this real mutant run → the standing `pass===false` REDS. This mutates PRODUCTION `assess.ts`, not a test option (fixes Review 1 #5 — round-1's "prose future weakening" is replaced by a runnable mutation on real code). Drop any option-flip framing.
- **No-op litmus:** the test's whole purpose is the litmus — a no-op-equivalent executor is REJECTED. **PASS by construction.**
- **Reuse seam:** `assess.ts:35`, `runner.test.ts:48`.

---

## Target 8 — N-inmemory + N-ratelimit (the two remaining negative twins)

### N-inmemory — FIX SPEC
No production change; `assessRunView` already forbids `inmemory` by default (`assess.ts:37,43`). NEW lock-in test `packages/core/test/assess-negatives.test.ts`.

**TEST CONTRACT (L1, every push) — RUN THE REAL PIPELINE (Review 1 #5, Review 2):**
- **Seam:** `runWorkflow` with `InMemorySandboxProvider` → `buildRunView` → `assessRunView` (default opts).
- **Falsifiable assertion:** run a real 1-node workflow (a `contentBuilder` that DOES write the artifact) on `InMemorySandboxProvider`, build the view, then `assessRunView(view).pass === false` (DEFAULT `forbidSandbox`) AND a failure line mentions `inmemory` and "non-proving". **The run genuinely produced the artifact — the ONLY thing that reds is the inmemory backend gate**, proving the gate is what disqualifies it (not a missing artifact).
- **Injected fault (RED against PRODUCTION):** delete the `forbid.has(view.sandbox)` push at `assess.ts:43` → this inmemory run (artifact present) would green → the standing `pass===false` REDS. A real code mutation, not a test-side `forbidSandbox:[]` toggle (round-1's fault was theater — Review 1 #5).
- **No-op litmus:** an inmemory run is the canonical no-op-equivalent; the test rejects it. **PASS.**
- **Reuse seam:** `runner.test.ts:126` (in-process `runWorkflow` on InMemory), `assess.ts:43`.

### N-ratelimit — RD-CORRECTED: ALREADY COVERED (direction is `ok`, seam is the verdict ladder — round-1 was INVERTED and aimed at the wrong seam)
Round-1's Target 8 N-ratelimit (`parseClaudeResult → verdict==='gap'`) is **DELETED** — `parseClaudeResult` (`claude-result.ts:30-66`) returns `{ok, isError, subtype}` with NO verdict string and NO `'gap'` (verified). The real fix lives in the verdict ladder at `node-lifecycle.ts:612-614` (NEUTER the pi self-report for claude: `let parsed = isClaude ? null : lastJsonBlock(result.stdout)`), and the CORRECT direction is **`ok`** (a benign `rate_limit_event {status:"allowed"}` must NOT be misread into a spurious `gap`), the OPPOSITE of round-1's "must map to `gap`".

**This is ALREADY COVERED — do NOT write a new file.** The exact test exists at `packages/core/test/runner.test.ts:553-604` (`describe('runWorkflow — claude-code node derives its verdict from parseClaudeResult, not lastJsonBlock')`), driving the real 23-event fixture `fixtures/claude-stream-json-sample.ndjson` (contains the `rate_limit_event {status:"allowed"}` line):
- `runner.test.ts:584-593` — claude node, exit 0, `is_error:false`, artifact present, stdout = the real fixture → asserts `status.nodes.fix.status === 'ok'` and `status.ok === true`. Comment `:589`: *"WITHOUT the fix this is 'gap'."* — the CORRECT direction.
- `runner.test.ts:595-604` — the negative twin: `result` event `is_error:true` → asserts `status === 'error'` (discriminates a real claude failure from the benign rate-limit line).

**Contract decision:** DELETE round-1 Target 8 N-ratelimit; replace with a one-line pointer + a **mutation drill note** (the injected fault, RD): in `node-lifecycle.ts:614`, change `let parsed = isClaude ? null : lastJsonBlock(result.stdout);` to `let parsed = lastJsonBlock(result.stdout);` (remove the claude neuter) → the fixture's `rate_limit_event {status:"allowed"}` flows into the ladder clause at `:761` (`parsed.status !== 'ok'` → `st = 'gap'`) → `runner.test.ts:590` (`expect(...).toBe('ok')`) goes RED. That mutation reds the PRODUCTION neuter, proving teeth. Optional belt-and-suspenders: add one assertion to `packages/core/test/claude-result.test.ts` that `parseClaudeResult(fixtureWithRateLimit).ok === true` (parser layer, secondary to the ladder test).

---

## Target 9 — L4 PLAYWRIGHT (J2 browser journey)

### FIX SPEC
NEW Playwright project under `gui/` (`gui/playwright.config.ts` + `gui/e2e/journey.spec.ts`). `webServer = piflowctl serve` (test port, seeded token). The browser opens `http://127.0.0.1:<port>/?token=<TOKEN>` (the `?token=` bearer shipped — `gui/src/data/apiBase.ts:7-10`). **PR mode** = the L2 in-process replay populates a real run dir (sandbox=local, real artifact, no model), served through `serve`; **nightly mode** = a real live run (env-gated, cost-capped). No production GUI change for PR mode.

### TEST CONTRACT
- **Seam:** the full J2 slice — DOM console → `POST /api/runs/start` → SSE `runStream` (`gui/src/data/runStream.ts:103`) → run-view render → artifact.
- **Tier / cadence:** **L4**; PR = replay (free), nightly = live (capped §7).
- **Falsifiable assertions:**
  1. **DOM:** the greet node's status element reaches text/attr `ok` within a **polled** realistic timeout (`expect.poll`, never a fixed `sleep`). Selector: the node-status testid in `WorkflowCanvas.tsx`; the writer adds a stable `data-testid="node-status-greet"` if absent.
  2. **SSE-per-transition (ONE concrete mechanism, Review 2 #7):** intercept the real SSE transport with **Playwright route interception counting `data:` frames on the SSE endpoint** — `page.route('**/__piflow/stream/**', …)` (or `page.on('response')` on the stream URL) and assert the response body streamed **≥1 `data:` frame per node transition** (i.e. ≥ the number of nodes). This reds if the GUI renders from a stale cache without live SSE. **NOT** a test-injected `window.__sseEvents` hook (round-1's hand-wave — a hook is only as trustworthy as the injection).
  3. **Artifact (independent probe):** the test process (Node, outside the browser) does `GET /__piflow/file/<run>?path=out/greet/greeting.txt` with the bearer and asserts `sha256(body) === sha256('CONTROL-VM-OK')` — the SAME path+hash the smoke/L1 probe verified (§5 std #2, path agrees with Target 3).
- **Injected fault (RED — real pipeline):** point the GUI at a run whose greet node blocked (inject via the N-breach mutation or a mutant node). DOM never reaches `ok` (poll times out) AND `/file` 404s → assertions 1 & 3 fail LOUD. A real blocked run, not a test toggle.
- **No-op litmus:** DOM stays non-ok, `/file` 404s. **PASS** — a no-op cannot green the journey.
- **Reuse seam:** `gui/src/data/apiBase.ts:7-10` (`?token=`), `gui/src/data/runStream.ts:103` (SSE client), `handlers.ts:284` (`piflowFile`), `deploy/docker/smoke-live.mjs:83-93` (byte-match shape).

---

## Target 10 — CI WIRING (§4 mode×host matrix) — REVIEW-CORRECTED (matrix scope + budgetGuard seam)

### FIX SPEC — name the files
1. **`.github/workflows/ci.yml`** (existing; jobs `verify`, `test`, `smoke`):
   - Add job **`l2-replay`**: trigger `pull_request` → `main`, `paths: [packages/**, gui/**, '**/.piflow/**']`. Runs L2 (Target 6) + L4-PR-replay (Target 9 replay) + all L0/L1 negatives (Targets 2a/2b/2c, 3-parity, 4, 5, 7, 8, 12, 13). Free, no live cell. `timeout-minutes: 15`.
2. **NEW `.github/workflows/e2e-live.yml`** (L3 + live L4):
   - Triggers: `push: [main]` + `schedule` (nightly cron) + `workflow_dispatch`.
   - **Matrix from §4 (`full-run-simulation.md:14-20`), corrected scope (Review 3 #4).** The matrix hosts are `{gh-hosted, self-hosted}` CI runners ONLY — Fly/Railway are NOT CI hosts (their docker cells are `n/a (VM-in-VM)`, and they are covered by the live `cloud up` smoke, not this matrix). Per §4: `docker × self-hosted = ✅` (SUPPORTED — do NOT exclude it), `local × gh-hosted = N/A` (GH runner can't userns), `danger-full-access × CI = excluded` (never unsandboxed in CI):
     ```yaml
     strategy:
       fail-fast: false
       max-parallel: 2                                    # rate-limit guard on real cloud cells
       matrix:
         mode: [e2b, docker, local]
         host: [gh-hosted, self-hosted]
         exclude:
           - { mode: local, host: gh-hosted }             # §4: N/A — GH runner can't userns (bwrap 126)
         # NOTE: docker × self-hosted is SUPPORTED (§4 ✅) — NOT excluded.
         # danger-full-access is omitted from `mode` entirely (§4: excluded in CI, never unsandboxed).
         # Fly/Railway docker cells (§4 n/a, VM-in-VM) are NOT in this matrix — covered by `cloud up` live smoke.
     ```
     Cells: `e2b × gh-hosted` = the nightly cost-capped live cell; `docker × {gh-hosted, self-hosted}` = free container mirror; `e2b/local × self-hosted` = the self-hosted runner cells. (Fixes round-1's wrong `docker × self-hosted` exclude whose reason belonged to Fly/Railway — Review 3 #4.)
   - **§7 cost caps per live job:** `timeout-minutes: 15`; **0 retries** on live assertion steps (a retry = a new paid session); `--max-turns N` to the agent; NO `continue-on-error` on any assertion step (fail LOUD); the **`budgetGuard` pre-flight reject** (below) runs before any paid call.
   - Upload Playwright trace + failing run-view `if: failure()`, `retention-days: 14`.
   - A `workflow_run` heartbeat-on-success notifier so a *missed* nightly is caught (a skipped required check must not report green).
3. **`.github/workflows/release.yml`** (existing): gate publish on the **free L2/L4-replay tier + the nightly-live heartbeat** (per Target 1's release decision), NOT a fresh uncapped live e2b on the critical path. Never gate release on a label-skippable check.

### THE §7 COST CAP AS TESTABLE CODE — `budgetGuard(estCost, cap)` (Review 2 #6)
CI YAML is not unit-asserted (§5 std #1 forbids asserting on config substrings), so the round-1 "trust the YAML" left the §7 ceiling ($1.00/run, pre-flight reject, 0 retries) covered by nothing. Put the pre-flight cap behind a small **unit-testable seam** in code, called by both the smoke and the live matrix runner:

**FIX SPEC:** add `export function budgetGuard(estCost: number, cap: number): void` to `packages/cli/src/` (deploy-adjacent CLI layer) that **throws** `Error(\`budget exceeded: est $${estCost} > cap $${cap}\`)` when `estCost > cap`. The live-e2b entrypoints (smoke + matrix runner) call `budgetGuard(estimate, PIFLOW_RUN_BUDGET_USD ?? 1.0)` **before** the POST/spawn that boots a paid VM.

**TEST CONTRACT (L0, every push) — `packages/cli/test/budget-guard.test.ts`:**
- **Seam:** `budgetGuard(estCost, cap)`.
- **Falsifiable assertions:** `expect(() => budgetGuard(1.5, 1.0)).toThrow(/budget exceeded/)`; `expect(() => budgetGuard(0.5, 1.0)).not.toThrow()`; boundary `expect(() => budgetGuard(1.0, 1.0)).not.toThrow()`.
- **Injected fault (RED against PRODUCTION):** invert the comparison to `estCost >= cap` OR `estCost < cap` in `budgetGuard` → the boundary/over/under cases red. A real code mutation, not YAML.
- **No-op litmus:** N/A (pure function guarding the paid call); the assertion IS the litmus — an over-cap estimate cannot proceed.

### TEST CONTRACT (the CI wiring itself)
- **This is config** — no unit assertion on YAML text (§5 std #1). Correctness is proven by: (a) the L2/L3 jobs it invokes ARE the falsifiable tests above; (b) the `budgetGuard` L0 test proves the cap FIRES in code; (c) a one-shot **mutation drill** (§9): revert one blocker fix on a branch and confirm the corresponding N-* job goes RED in CI — observable = a real CI red, not a YAML grep.
- **Cadence:** L2 on every PR (path-filtered); L3 nightly + dispatch + heartbeat-required-in-release.

---

## Target 11 — CONTROL-PLANE HANDOVER (not a test target; live-run phase note)

Runs + live monitoring ALREADY WORK via the persisted `cloud` context (Railway URL + bearer in `~/.piflow/contexts.json`; `resolveRemote` delegation in run/status/watch). Live-run sequence for the L3 phase:
```
piflowctl context use cloud          # selects the live Railway plane (saved bearer, worker=e2b via cascade)
piflowctl run <templateDir>          # → POST https://…railway.app/api/runs/start (bearer); node runs on the plane's e2b worker
piflowctl watch <runId>              # → SSE https://…railway.app/__piflow/stream/<runId>
piflowctl status <runId>             # → snapshot over the same remote SSE
piflowctl context use local          # hand control back to the laptop
```
**Two minor deltas (not blockers):**
- The user's literal word is `railway`, but the saved context is named `cloud`. Either `cloud up --host railway --context railway` (durable row named `railway`), OR tell the user the verb is `context use cloud`. Naming nicety, not a capability gap.
- **`piflowctl gui` does NOT follow the active context** (`gui.ts:69-86` ignores `resolveActive`). If a locally-launched GUI must point at the plane, add ~10-15 lines in `packages/cli/src/gui.ts` to read the active remote entry, pass `baseUrl`→`VITE_PIFLOW_API`, and seed `?token=` on the `--open` URL (`gui/src/data/apiBase.ts:20-30` supports remote baseUrl+token). Until then, open the plane's own served GUI URL with `?token=`. **Follow-up:** verify `optimize`/`fix` also route through `resolveRemote` (only run/status/watch traced).

---

## Target 12 (NEW) — N-watchdog (§5-PROCESS #3: a watchdog-killed run must fail the rubric) — RD

### The gap (verified)
§5-PROCESS #3 requires `killedTimeout/killedStall == false`. The fields ARE written to the node record (`node-lifecycle.ts:811-812`, typed `NodeStatusRecord` `status.ts:149-150`) so run.json carries them — but `RunViewNode`/`RunJsonNode` (`runView.ts:34,201`) don't carry them, `assembleNode` (`runView.ts:330-344`) never maps them, and `assessRunView` (`assess.ts:35-79`) never reads them. **Failure scenario:** a node killed mid-write leaves a non-empty stale/partial artifact (`exists:true, bytes>0`) → the rubric can green a killed run.

### FIX SPEC (`@piflow/core` observe — 4 additive edits, no behavior change to a clean run)
- **Edit A — `runView.ts:201` (`RunJsonNode`):** add `killedTimeout?: boolean; killedStall?: boolean;` (so on-disk run.json values parse through).
- **Edit B — `runView.ts:34` (`RunViewNode`):** add `killedTimeout?: boolean; killedStall?: boolean;`.
- **Edit C — `runView.ts:330-344` (`assembleNode`):** thread verbatim, mirroring the `agentType` passthrough idiom (`:332`): `...(rec.killedTimeout ? { killedTimeout: true } : {}), ...(rec.killedStall ? { killedStall: true } : {}),`.
- **Edit D — `assess.ts`**, in the per-node loop (after the status check at `:64-66`, inside `for (const id of targets)`):
  ```ts
  if (n.killedTimeout) failures.push(`node '${id}' was killed by the timeout watchdog — its artifacts are not proof of a completed run`);
  if (n.killedStall) failures.push(`node '${id}' was killed by the stall watchdog — its artifacts are not proof of a completed run`);
  ```
(A clean run leaves both flags absent, so the new failures never fire — no regression.)

### TEST CONTRACT — the negative twin — L1
- **Seam:** `runWorkflow` → `buildRunView` → `assessRunView` (the full data path Edits A-D wire).
- **Tier / cadence:** **L1**, every push (fakes, no model). File `packages/core/test/watchdog-rubric.test.ts`.
- **Harness:** compile a 1-node workflow declaring `artifacts:['out/result.md']`. Drive it through the `execRunner` seam with a runner that (i) WRITES `out/result.md` with non-empty bytes (the stale artifact), then (ii) returns `{ result:{stdout:'', stderr:'', code:0}, killed:'timeout' }` (the `ExecRunner` return shape, `runner.test.ts:576`; kill-classification `node-lifecycle.ts:811`). Reproduces "watchdog killed the node but an artifact is present on disk."
- **Falsifiable assertions:**
  1. `view.nodes.find(n=>n.id===<id>).killedTimeout === true` (Edits A-C wired it through).
  2. `assessRunView(view, { expectNodes:[<id>] }).pass === false` AND `assessment.failures` contains a string naming the timeout watchdog (Edit D). **This must fail even though the artifact `exists:true, bytes>0`** — the whole point.
- **Injected fault (RED against PRODUCTION):** delete Edit D's two `if (n.killedTimeout …)` lines in `assess.ts` (the pre-fix rubric that never reads the watchdog dimension). With the stale artifact present, `assessRunView(...).pass` flips to `true` → the standing `pass===false` REDS. Mutates PRODUCTION `assess.ts`, not a test option (MUST-FIX 5).
- **No-op litmus:** a watchdog-killed run IS a no-op-equivalent (the deliverable is untrustworthy); the rubric rejects it even with a byte-present artifact. **PASS.**
- **Reuse seam:** `runner.test.ts:576` (`ExecRunner` return shape + `runner.test.ts:1821` reads `status.nodes.slow.killedTimeout`), `node-lifecycle.ts:811`, `assess.ts:64`.

---

## Target 13 (NEW) — J3 chained-hash (§5-NODE #4: consumer input hash == recomputed producer output; blocks forged intermediates) — RD

### The gap (verified)
§3 J3 / §5-NODE #4 = "consumer's input hash == recomputed hash of producer's output (blocks forged intermediates)." Every other target runs single-node greet or a 1-node fake. A consumer's `io.reads` ARE staged into its sandbox at the same relative path before exec (`node-lifecycle.ts:285-288`), so the consumer's shell command can hash the REAL staged producer bytes at exec time — a genuine chain, not a build-time fabrication.

### FIX SPEC
NEW test `packages/core/test/chained-hash-e2e.test.ts`. NO production change.

### TEST CONTRACT
- **Seam:** `runWorkflow(compile(wf([producer, consumer])), …)` on `InMemorySandboxProvider` (or `LocalSandboxProvider`), plus a fresh-fs read + `crypto.createHash('sha256')` in the test process.
- **Tier / cadence:** **L1**, every push (free, no model).
- **Harness (producer→consumer, mirroring `deploy/docker/smoke-live.mjs:75-93`):**
  - `producer = n('Producer', [], ['a.txt'])`; build command writes deterministic bytes: `printf '%s' 'PRODUCER-PAYLOAD' > <output>/a.txt`.
  - `consumer = n('Consumer', ['a.txt'], ['b.txt'])`; build command reads its STAGED input and records the hash of the producer's actual output. **Use the `node -e` hash form for macOS/Linux portability** (no `sha256sum`-vs-`shasum` coreutils flake across the CI matrix): `node -e "process.stdout.write(require('crypto').createHash('sha256').update(require('fs').readFileSync('a.txt')).digest('hex'))" > <output>/b.txt`.
- **Falsifiable assertions (observable = fresh fs reads + recomputed hash, NOT run-view copies):**
  1. `status.nodes.producer.status === 'ok'` AND `status.nodes.consumer.status === 'ok'`.
  2. **Chain-link:** `producerBytes = readFileSync(resolve(outDir,'a.txt'))`; `consumerRecordedHash = readFileSync(resolve(outDir,'b.txt'),'utf8').trim()`; assert `consumerRecordedHash === createHash('sha256').update(producerBytes).digest('hex')` — the §5-NODE-#4 invariant: the consumer's recorded input-hash equals an independent recomputation of the producer's real output bytes.
- **Injected fault (RED — real pipeline, forged intermediate):** replace the consumer's command with one that hashes FABRICATED bytes instead of the staged producer output: `node -e "process.stdout.write(require('crypto').createHash('sha256').update('FORGED-NOT-THE-PRODUCER-OUTPUT').digest('hex'))" > <output>/b.txt`. Now `consumerRecordedHash !== sha256(producerBytes)` → assertion 2 REDS. The standing test greens ONLY when the consumer genuinely hashes the producer's real staged output — this is the forged-intermediate the spec says must be blocked, run through the real staging path (`node-lifecycle.ts:285-288`).
- **No-op litmus:** a no-op consumer writes no `b.txt` → assertion 2's `readFileSync('b.txt')` throws; a no-op producer → the staged `a.txt` is empty/absent → the hashes diverge. **PASS.**
- **Reuse seam:** `deploy/docker/smoke-live.mjs:75-93` (producer→consumer shape), `runner.test.ts:23,32,48-84` (n/wf/builders), `node-lifecycle.ts:285-288` (read-staging that makes the chain real), Node `crypto.createHash`.

---

## SELF-CHECK (audited against `<the_bar>` + `<self_check>`)

**Per-contract no-op litmus + injected-fault-reds-PRODUCTION audit:**

| Target | No-op litmus (fails on a no-op executor?) | Injected fault reds PRODUCTION code (not a test option)? |
|---|---|---|
| 1 Smoke (L0 guard) | PASS — `exists:false`/`ok:false` reds assess + `/file` 404 | PASS — flip fixture `exists:false` reds `assess.ts:71` |
| 2a Mint projection | N/A (pure fn) — fault = un-projected backend, detected directly | PASS — current unfixed mint omits `E2B_API_KEY`/`E2B_TEMPLATE` → reds |
| 2b Reach (spawn no-env) | N/A (spawn contract) — paired with 2c for produce | PASS — adding `env:` to `start-run.ts` spawn reds `not.toHaveProperty('env')` |
| 2c N-127 twin (FakeE2b) | PASS — no-write worker reds `assess.pass===false` | PASS — deleting `assess.ts:71` greens the missing artifact → reds standing `pass===false` |
| 3 N-breach parity (both kinds) | PASS — no-op `readFileSync` throws under BOTH arms | PASS — reverting `output:"."`→`out/greet` reds exactly one arm (the SDK compile default) |
| 4 N-126 message | N/A (message) — observable is the code's diagnostic | PASS — current `bwrap.ts:139` lacks `--sandbox e2b` → reds |
| 5 L1 lifecycle | PASS — stub-writes-nothing → `readFileSync` throws + `blocked` | PASS — builder-writes-wrong-path reds the real artifact gate `node-lifecycle.ts:552` |
| 6 L2 HTTP replay | PASS — no-op → `/file` 404 + `exists:false` | PASS — drop provider → real `inmemory` run reds `assess.ts:43`; delete `:43` reds standing positive |
| 7 N-mutant | PASS by construction (asserts a no-op is REJECTED) | PASS — default `requireArtifacts=false` OR delete `assess.ts:71` greens mutant → reds standing `pass===false` |
| 8 N-inmemory | PASS — inmemory = canonical no-op-equivalent, rejected | PASS — delete `assess.ts:43` forbid greens artifact-present inmemory run → reds |
| 8 N-ratelimit | PASS — verdict from event content, not exit code | PASS — remove the `isClaude ? null :` neuter (`node-lifecycle.ts:614`) reds `runner.test.ts:590` to `gap` |
| 9 L4 Playwright | PASS — DOM non-ok + `/file` 404 on a no-op | PASS — a blocked greet run (real N-breach mutation) reds DOM-poll + hash probe |
| 10 budgetGuard | N/A (pure guard) — assertion IS the litmus | PASS — invert the `>` comparison in `budgetGuard` reds the boundary/over/under cases |
| 12 N-watchdog | PASS — killed run is a no-op-equivalent, rejected despite byte-present artifact | PASS — delete Edit D's `if (n.killedTimeout)` in `assess.ts` greens killed run → reds standing `pass===false` |
| 13 J3 chained-hash | PASS — no-op consumer/producer → `readFileSync` throws / hashes diverge | PASS — consumer hashes FABRICATED bytes (real forged run) reds the chain-link equality |

**All negative twins have a real red-test that reds PRODUCTION code:** N-127 (Targets 2a un-projected + 2c template-less twin), N-126 (Target 4), N-breach (Target 3 both-kinds parity), N-inmemory (Targets 6 + 8, real pipeline), N-ratelimit (Target 8 pointer + `node-lifecycle.ts:614` mutation), N-mutant (Target 7 real `assess.ts` mutation), N-watchdog (Target 12 real `assess.ts` mutation), J3 (Target 13 forged-intermediate). ✔

**RA's fix traced through BOTH kinds:** the truth table shows `output:"."` + `artifacts:["out/greet/greeting.txt"]` lands the file at `outDir/out/greet/greeting.txt` under local (IN_PLACE, no download) AND e2b (`downloadDir(".")` strips nothing) — the ONLY config where both arms green; either reversion reds exactly one arm. ✔

**N-127 reach is TESTED, not just projection:** Target 2b asserts the spawn carries no `env` override (inheritance holds) + Target 2c asserts a template-less run fails the rubric on a real `e2b`-kind backend. ✔

**N-ratelimit targets the real seam + correct direction:** the verdict ladder (`node-lifecycle.ts:612-614`), direction `ok` (benign rate-limit NOT misread into a gap), already covered by `runner.test.ts:584-604`; mutation drill on `:614`. ✔

**Watchdog + J3 coverages exist:** Targets 12 + 13. ✔

**No assertion reads config/template/contract/scheduler text or `done` alone:** the smoke's regex-over-blob and status-regex are DELETED; `sawDone`/SSE-done are necessary-not-sufficient; the N-126 assertion reads an emitted *diagnostic*; every "produced the artifact" claim is a fresh independent read of on-disk bytes. ✔

**SDK boundary holds:** `DEFAULT_E2B_TEMPLATE` + N-127 projection + `budgetGuard` live in `packages/cli` (deploy layer). The N-breach `sandbox.output` passthrough lives in `@piflow/core` — but it is **generic mechanism** (an output-collection-root knob), NOT product-specific data or a collected snapshot; no product value enters the SDK. The watchdog fields are generic observe fields. ✔

**No target points at a non-existent seam/field/JSON-path** (all re-verified against the tree): the `contract.output` schema key is ADDED by Target 3 (round-1's assumed-existing lever is corrected to a real edit); `parseClaudeResult` is NOT asked to return `'gap'` (retargeted to the ladder); the L2 provider-injection-across-spawn fiction is replaced by in-process `runFromTemplate`; `CloudSecret.displayValue` confirmed real; the CI matrix excludes only the true §4 `N/A` cell (`local × gh-hosted`) and keeps the supported `docker × self-hosted`; the smoke `?path=` agrees with Target 3's declared artifact. ✔

**Round-1's broken Targets 3/6/8 are NOT restated** — all three are replaced with traced, buildable, code-accurate contracts. ✔
