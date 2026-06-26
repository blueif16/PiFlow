import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runFromTemplate } from '../src/runner/index.js';
import { nodeEventsFile } from '../src/runner/layout.js';

// ── M0 — Live-pi E2E gate: the RED BAR for the G11 tool-wiring blocker (#1/#8). ──────────────────────
//
// The disease (investigation §3a, design §4): the ingest→schema→bind→execute tool pipeline is fully built
// (`seededRegistry()` carries the `oc.calc:add` sdk seed + the community catalog) but has ZERO non-test
// callers, so the CANONICAL run path (`runFromTemplate` → `runWorkflow`) falls through to
// `registry: opts.registry ?? new DefaultToolRegistry()` (runner.ts:1347) — a builtins+submit_result-only
// registry that does NOT carry `oc.calc:add`. A node that SELECTS `oc.calc:add` therefore fails its
// pre-spawn bind check (`verifyToolBinding`, runner.ts:775) and is `blocked` BEFORE pi binds.
//
// This file is M0: TESTS ONLY. It is written FIRST and the deterministic case FAILS on today's code for the
// RIGHT reason — the node is `blocked` with `oc.calc:add` reported MISSING — and flips GREEN only once M1
// wires `assembleRunTools` (seededRegistry) into the run entries. Per the fix plan §M0 the deterministic
// blocker gate is the LOAD-BEARING red bar; the live-pi case is the stronger (gated) execution proof.
//
// M0 FINDING for M1 (do not silently lose this): the run path must end up with a registry that carries BOTH
// `oc.calc:add` AND `contract:submit_result`. Today's `seededRegistry()` (catalog.ts:58) is NOT a superset of
// `DefaultToolRegistry()` — it = `BUILTIN_TOOLS + loadCatalog()` and DROPS `SUBMIT_RESULT_TOOL` (only
// `DEFAULT_TOOLS` carries it). So wiring `seededRegistry()` verbatim would unblock `oc.calc:add` but RE-block
// every node that declares `submit_result` (template-arg/template-min both do). M1's `assembleRunTools` must
// keep `submit_result` (the fix-plan additivity claim "seededRegistry ⊇ DefaultToolRegistry" holds for
// BUILTINS only, not the first-party contract tool). This test asserts the node reaches `ok`, so it stays
// RED until BOTH are bound — exactly the additivity bar M1 owes.

const TEMPLATE_CALC_DIR = path.resolve(__dirname, 'fixtures', 'template-calc');

/** A fresh host run dir under the OS tmp (so a test never writes into the repo). */
async function tmpRunDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'piflow-calc-run-'));
}

/**
 * THE OFFLINE STUB BUILDER (the runner.test.ts pattern): instead of spawning `pi`, return a shell command
 * that writes each declared artifact into the node's sandbox OUTPUT dir + a fenced return block. This
 * exercises the REAL lifecycle (bind-check → stage → exec → collect → verify) with NO pi, isolating the
 * BIND/wiring concern from execution. A node reaches `ok` IFF it BINDS (passes the pre-spawn bind check) —
 * which is exactly the behavior under test: TODAY it does NOT bind (`oc.calc:add` absent from the
 * self-assembled DefaultToolRegistry), so the node is `blocked` and never reaches this command at all.
 */
function stubBuilder() {
  return (node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
    const writes = node.io.artifacts
      .map((a) => {
        const dest = `${node.sandbox.output}/${a.path}`;
        const dir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '.';
        return `mkdir -p ${dir} && printf '%s' 5 > ${dest}`;
      })
      .join(' && ');
    const ret = `printf '%s' '\`\`\`json\\n{"status":"ok","summary":"${node.id} done"}\\n\`\`\`'`;
    return writes ? `${writes} && ${ret}` : ret;
  };
}

/**
 * Is `pi` + a configured provider/model usable for a real nested run here? Copied verbatim-in-shape from
 * `openclaw-host-llm-task.test.ts:78-91`: `pi --list-models` is offline + fast and proves the binary runs
 * and the provider/model is configured. With pi installed (0.79.x) but NO provider configured, this returns
 * `runnable:false` and the live case SKIPS (never fails) with the reason.
 */
function probePi(): { runnable: boolean; provider: string; model: string; reason: string } {
  const provider = 'mmgw';
  const model = 'MiniMax-M3';
  try {
    const out = execFileSync('pi', ['--list-models'], { encoding: 'utf8', timeout: 20_000 });
    if (!out.includes(model)) {
      return { runnable: false, provider, model, reason: `model ${model} not in \`pi --list-models\`` };
    }
    return { runnable: true, provider, model, reason: '' };
  } catch (err) {
    return { runnable: false, provider, model, reason: `pi --list-models failed: ${(err as Error).message}` };
  }
}

describe('runFromTemplate — tool-wiring blocker (G11/#1): a node-declared oc.calc:add must BIND on the canonical path', () => {
  // ── V1 — the LOAD-BEARING DETERMINISTIC red bar (no pi). ──────────────────────────────────────────
  // Route the `oc.calc:add`-selecting node through the CANONICAL entry (`runFromTemplate`) with NO explicit
  // `registry` and a `buildCommand` stub (so no pi spawns — the bind gate is the only thing in question).
  // The node finishing `ok` PROVES it bound. TODAY this is RED: `runFromTemplate` → `runWorkflow` builds
  // `new DefaultToolRegistry()` (no `oc.calc:add`), so `verifyToolBinding` reports it MISSING and the node
  // is `blocked` before the stub command ever runs. Turns GREEN when M1 seeds `seededRegistry` into entry.ts.
  it('a node selecting oc.calc:add BINDS (status ok) when run through runFromTemplate with NO explicit registry', async () => {
    const runDir = await tmpRunDir();

    const result = await runFromTemplate(TEMPLATE_CALC_DIR, {
      run: 'calc-bind',
      runDir,
      buildCommand: stubBuilder(), // offline: no pi; isolates the BIND from execution
      // NO `registry` passed ⇒ the self-assembling canonical path is exercised (the blocker surface).
    });

    // THE LOAD-BEARING ASSERTION: the node bound and finished ok. Today it is `blocked` (oc.calc:add absent
    // from the self-built DefaultToolRegistry), so this fails for the RIGHT reason — the catalog never
    // reaches the run path. The companion assertions below name that exact reason so the RED is diagnosable.
    expect(result.status.nodes.calc.status).toBe('ok');
    expect(result.status.ok).toBe(true);

    // Diagnostic on the RED: the failure is specifically the unresolved catalog tool, not some other block.
    // (When this test is RED these assertions describe WHY; when M1 lands and it is GREEN they are vacuously
    //  satisfied because the node is `ok` with no issues.)
    if (result.status.nodes.calc.status !== 'ok') {
      const issues = (result.status.nodes.calc.issues ?? []).join(' ');
      expect(issues).toMatch(/oc\.calc:add/);
      expect(issues).toMatch(/bind|not in catalog|will not bind|missing/i);
    }

    await fs.rm(runDir, { recursive: true, force: true });
  });
});

// ── V1-live — the GATED real-pi EXECUTION proof (stronger; SKIPS when pi/provider is unconfigured). ──
// Same `oc.calc:add` node through the SAME canonical entry, but with NO stub `buildCommand` (the real
// `defaultPiCommand` spawns `pi … -e _pi/calc/tools.ts --tools calc_add,submit_result,write`) and
// `recordEvents:true`. It asserts on the agent's OWN event stream — `events.jsonl` carries a
// `tool_execution_end` for `calc_add` with the sum 5 — proving EXECUTION via the generated `-e`, not the
// model guessing "5" in prose. Like the deterministic case it is RED on today's code (the node blocks before
// pi spawns); it additionally requires a configured pi/provider, else it SKIPS with the reason (never fails).
const probe = probePi();
// LIVE-MODEL gate: a real-pi run is non-deterministic against a weak model, so this must NOT run in a default
// `vitest run` (CI) — it is an ON-DEMAND execution proof. Opt in with `PIFLOW_LIVE=1` (AND a configured
// pi/provider). The LOAD-BEARING wiring red bar is the deterministic V1 above, which always runs.
const liveEnabled = probe.runnable && !!process.env.PIFLOW_LIVE;

describe('runFromTemplate — LIVE pi: oc.calc:add EXECUTES via the generated -e (gated, PIFLOW_LIVE=1)', () => {
  if (!liveEnabled) {
    const why = !probe.runnable ? `pi not runnable: ${probe.reason}` : 'set PIFLOW_LIVE=1 to run the live execution proof';
    it.skip(`SKIPPED — ${why}`, () => {});
  }

  it.skipIf(!liveEnabled)(
    `binds + EXECUTES oc.calc:add in a LIVE pi (${probe.provider}/${probe.model}); events.jsonl has tool_execution_end{calc_add,sum:5}`,
    async () => {
      const runDir = await tmpRunDir();

      await runFromTemplate(TEMPLATE_CALC_DIR, {
        run: 'calc-live',
        runDir,
        providerName: probe.provider,
        model: probe.model,
        recordEvents: true,
        // NO `buildCommand` ⇒ the real `defaultPiCommand` spawns a genuine headless pi with the generated -e.
        // NO `registry` ⇒ the canonical self-assembling path (the blocker surface) is exercised end-to-end.
        nodeTimeoutMs: 120_000,
      });

      // THE PROOF is the agent's OWN event stream: a `tool_execution_end` for `calc_add` can exist ONLY if the
      // tool BOUND and the generated `-e` loaded in a real headless pi (a blocked node never spawns pi → no
      // events). We deliberately do NOT assert the node's terminal `status`: whether the model ALSO writes the
      // declared artifact is a separate, model-dependent concern (a weak live model may skip the fs:write),
      // orthogonal to the tool-wiring behavior under test. The deterministic V1 carries the bind red→green;
      // this carries EXECUTION via the generated -e.
      const eventsPath = nodeEventsFile(runDir, 'calc');
      expect(existsSync(eventsPath), `expected node event archive at ${eventsPath}`).toBe(true);
      const lines = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
      const toolEnds = lines
        .map((l) => {
          try {
            return JSON.parse(l) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((e): e is Record<string, unknown> => !!e && e.type === 'tool_execution_end');

      // At least one tool_execution_end names calc_add — the tool actually fired in the headless run.
      const calcEnds = toolEnds.filter((e) => JSON.stringify(e).includes('calc_add'));
      expect(calcEnds.length, 'a tool_execution_end for calc_add must exist in events.jsonl').toBeGreaterThan(0);
      // …and carries the computed sum 5 (proven in real pi 0.79: details.sum === a+b === 2+3 === 5).
      expect(JSON.stringify(calcEnds)).toMatch(/(\"sum\"\s*:\s*5\b)|(\b5\b)/);

      await fs.rm(runDir, { recursive: true, force: true });
    },
    180_000,
  );
});
