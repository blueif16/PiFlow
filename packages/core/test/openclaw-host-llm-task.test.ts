import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hostOpenClawTool, type RunPiCommand } from '../src/tools/openclaw-host.js';

// ── S3 INTEGRATION TEST — drive the REAL OpenClaw `llm-task` tool through our in-process host, with its
//    `runtime.agent.runEmbeddedAgent` seam bound to the pi CLI ───────────────────────────────────────
//
// This is NOT a unit test of a mock. It imports the ACTUAL installed `llm-task` plugin entry
// (`node_modules/openclaw/dist/extensions/llm-task/index.js`), runs its real `register(api)` on our host,
// captures the LAZY `llm-task` tool factory, and drives the plugin's OWN `execute(...)`. That execute calls
// `api.runtime.agent.runEmbeddedAgent({ prompt, model, provider, timeoutMs, disableTools, ... })` and reads
// the result's `payloads` (`extensions/llm-task/index.js:162` → `collectText` at :25-27 filters
// `!p.isError && typeof p.text === "string"`, joins the `.text` values; throws "LLM returned empty output"
// at :163 when empty). It then `JSON.parse`s that text (:167). The host's job under test: bind that ONE
// seam to a nested `pi -p --mode json …` run and translate the result into `{ payloads, meta }`.
//
// THE SUBPROCESS BOUNDARY IS THE ONLY THING FAKED. The deterministic case injects a `runPiCommand` that
// returns a RECORDED-SHAPE pi `--mode json` stdout — a verbatim subprocess-boundary TAPE recorded from a
// live `pi -p --mode json -a --no-session --offline --no-extensions --no-context-files --provider mmgw
// --model MiniMax-M3 @<prompt>` run (the genuine per-line event stream: session → agent_start → turn_start
// → message_start/_end (user) → message_start (assistant) → thinking_* deltas → text_* deltas → message_end
// → turn_end → agent_end). It is a tape of pi's OUTPUT FORMAT, NOT a manufactured "successful model answer":
// the assertion proves OUR translation (events → final assistant text → payloads → llm-task's JSON.parse),
// and it goes RED if the adapter's command-build or its event-stream parse is wrong. The model's reasoning
// is never asserted as real here — that is what the env-GATED live case below does (real nested pi, no mock).

const LLM_TASK_ENTRY = '../../../node_modules/openclaw/dist/extensions/llm-task/index.js';

// The marker the recorded tape carries as the assistant's final text. We choose it; it is the value the
// adapter must surface through `payloads[].text` for llm-task to JSON.parse and return.
const TAPE_MARKER = 'OC_S3_TAPE_MARKER_4d7c';

/**
 * A RECORDED-SHAPE pi `--mode json` stdout tape (one JSON event per line). Recorded from a real live pi run
 * (provider mmgw / MiniMax-M3) and then PARAMETERIZED on the final assistant text so a test can assert a
 * value it controls. The terminal `agent_end` event carries the full assistant message whose `content[]`
 * has a `thinking` block (which MUST be excluded) and a `text` block (the answer the adapter must surface).
 * This is a subprocess-boundary tape of pi's OUTPUT FORMAT — never a fabricated success of model reasoning.
 */
function recordedPiStdout(finalText: string): string {
  const t = JSON.stringify(finalText); // embed as a JSON string value, faithfully escaped
  const assistantMsg = {
    role: 'assistant',
    content: [
      {
        type: 'thinking',
        thinking: 'The user wants the JSON value. I will return just the JSON.',
        thinkingSignature: 'sig-deadbeef',
      },
      { type: 'text', text: finalText },
    ],
    api: 'anthropic-messages',
    provider: 'mmgw',
    model: 'MiniMax-M3',
    stopReason: 'stop',
  };
  const lines = [
    `{"type":"session","version":3,"id":"019ef277-tape","cwd":"/tmp/oc-s3"}`,
    `{"type":"agent_start"}`,
    `{"type":"turn_start"}`,
    `{"type":"message_start","message":{"role":"user","content":[{"type":"text","text":"<prompt>"}]}}`,
    `{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"<prompt>"}]}}`,
    `{"type":"message_start","message":{"role":"assistant","content":[],"provider":"mmgw","model":"MiniMax-M3"}}`,
    `{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"The "}}`,
    `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":${t}}}`,
    `{"type":"message_end","message":${JSON.stringify(assistantMsg)}}`,
    `{"type":"turn_end","message":${JSON.stringify(assistantMsg)},"toolResults":[]}`,
    `{"type":"agent_end","messages":[${JSON.stringify(assistantMsg)}],"willRetry":false}`,
  ];
  return lines.join('\n') + '\n';
}

/** Is the `cp` (or available) provider usable for a real nested-pi run here? Probe pi + a cheap model list. */
function piLiveProbe(): { runnable: boolean; provider: string; model: string; reason: string } {
  const provider = 'mmgw';
  const model = 'MiniMax-M3';
  try {
    // `pi --list-models` is offline and fast; it proves the binary runs and the provider/model is configured.
    const out = execFileSync('pi', ['--list-models'], { encoding: 'utf8', timeout: 20_000 });
    if (!out.includes(model)) {
      return { runnable: false, provider, model, reason: `model ${model} not in \`pi --list-models\`` };
    }
    return { runnable: true, provider, model, reason: '' };
  } catch (err) {
    return { runnable: false, provider, model, reason: `pi --list-models failed: ${(err as Error).message}` };
  }
}

describe('hostOpenClawTool — S3: real llm-task driven through the pi-bound runEmbeddedAgent seam', () => {
  it('DETERMINISTIC: a recorded pi tape flows through the adapter to llm-task’s JSON output', async () => {
    const mod = await import(LLM_TASK_ENTRY);
    // A REAL workspace dir on disk so the adapter runs the (faked) nested pi with cwd = the workspace
    // (the adapter degrades a MISSING workspace to its stage dir; here we prove the happy path).
    const workspaceDir = mkdtempSync(join(tmpdir(), 'oc-s3-det-'));

    // Capture what the host hands the pi runner so we can assert the command was built from the params.
    let seenCommand: string | undefined;
    let seenCwd: string | undefined;
    let seenTimeout: number | undefined;
    const fakePi: RunPiCommand = async (req) => {
      seenCommand = req.command;
      seenCwd = req.cwd;
      seenTimeout = req.timeoutMs;
      // Return the RECORDED-SHAPE tape carrying a JSON value as the assistant's final text. llm-task wraps
      // the prompt as a "JSON-only function"; the answer text must be a JSON value it can parse.
      return { stdout: recordedPiStdout(JSON.stringify({ marker: TAPE_MARKER })), stderr: '', code: 0 };
    };

    const result = (await hostOpenClawTool({
      mod,
      toolName: 'llm-task',
      workspaceDir,
      // Pass provider+model EXPLICITLY so llm-task resolves the model without reaching any other
      // `runtime.agent.*` path (no `thinking` ⇒ resolveThinkingPolicy/normalizeThinkingLevel untouched).
      params: { prompt: 'Echo the marker.', provider: 'mmgw', model: 'MiniMax-M3', timeoutMs: 12_345 },
      runPiCommand: fakePi,
    })) as { content?: Array<{ text?: string }>; details?: { json?: { marker?: string } } };

    // (a) The pi command/args were built correctly from RunEmbeddedAgentParams.
    expect(seenCommand, 'adapter must build a pi command').toBeDefined();
    expect(seenCommand!).toMatch(/(^|\s)pi\s/); //   the `pi` binary
    expect(seenCommand!).toContain('--mode json'); //   headless JSON event stream
    expect(seenCommand!).toContain('--provider mmgw'); //   provider from params
    expect(seenCommand!).toContain('--model MiniMax-M3'); //   model from params
    expect(seenCommand!).toMatch(/@'?\/.*prompt/i); //   the staged prompt file, referenced as @<file>
    // disableTools:true (llm-task always passes it) ⇒ NO --tools flag.
    expect(seenCommand!).not.toContain('--tools');
    // timeoutMs from params is honored on the runner call.
    expect(seenTimeout).toBe(12_345);
    // cwd is the agent workspace (llm-task derives workspaceDir from config → our host's args.workspaceDir).
    expect(seenCwd).toBe(workspaceDir);

    // (b) THE LOAD-BEARING ASSERTION: the text carried in the recorded tape's assistant `text` block flowed
    // through the adapter (events → final text → payloads[].text) into llm-task's execute, which JSON.parsed
    // it. If the adapter built the wrong command OR parsed the wrong event field, this is RED.
    expect(result.details?.json?.marker).toBe(TAPE_MARKER);
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain(TAPE_MARKER);
    // The thinking block in the tape must NOT leak into the answer (else JSON.parse would fail on prose).
    expect(text).not.toContain('I will return just the JSON');
  });

  it('ERROR: a non-zero/garbage pi run ⇒ adapter returns payloads with isError:true, not a host crash', async () => {
    // We assert the SEAM's behavior directly (the adapter returns an error payload rather than throwing),
    // because llm-task's own execute then throws "LLM returned empty output" on an all-error payload set
    // (collectText filters isError). The seam contract is: error → `{ payloads:[{isError:true}], meta }`.
    const { runEmbeddedAgentViaPi } = await import('../src/tools/openclaw-host.js');
    const garbagePi: RunPiCommand = async () => ({ stdout: 'not json at all <<<', stderr: 'boom', code: 1 });

    const res = await runEmbeddedAgentViaPi(
      { sessionId: 's', sessionFile: '/tmp/s.json', workspaceDir: '/tmp/oc-s3-err', prompt: 'hi', timeoutMs: 1000, runId: 'r', provider: 'mmgw', model: 'MiniMax-M3', disableTools: true },
      garbagePi,
    );
    expect(Array.isArray(res.payloads)).toBe(true);
    expect(res.payloads!.length).toBeGreaterThan(0);
    expect(res.payloads!.every((p) => p.isError === true)).toBe(true);
    // meta is populated (the required `durationMs` field of EmbeddedAgentRunMeta).
    expect(typeof res.meta.durationMs).toBe('number');
  });

  it('the loud-throw still guards the rest of runtime.agent.* (only runEmbeddedAgent is wired)', async () => {
    // Reaching `runtime.agent.subagent` (or any un-wired runtime.agent.* path) must still throw loudly with
    // its path — S3 wired exactly ONE method, not the whole namespace.
    const { makeRuntimeAgentForTest } = await import('../src/tools/openclaw-host.js');
    const agent = makeRuntimeAgentForTest(async () => ({ stdout: '', stderr: '', code: 0 }));
    expect(() => (agent as unknown as { subagent: { run: () => void } }).subagent.run()).toThrow(
      /runtime\.agent\.subagent/,
    );
    // And the one we DID wire is a real function, not the loud stub.
    expect(typeof (agent as unknown as { runEmbeddedAgent: unknown }).runEmbeddedAgent).toBe('function');
  });

  // ── GATED LIVE CASE — runs ONLY when pi + a configured provider/model are usable; never faked/mocked. ──
  // Drives the REAL llm-task → real nested `pi -p --mode json …` and asserts a real, non-empty payload text
  // (the model's actual JSON answer). If pi or the provider isn't usable here, this SKIPS with the reason.
  const probe = piLiveProbe();
  it.skipIf(!probe.runnable)(
    `GATED LIVE: real llm-task → real nested pi (${probe.provider}/${probe.model}) → real payload text`,
    async () => {
      const mod = await import(LLM_TASK_ENTRY);
      const result = (await hostOpenClawTool({
        mod,
        toolName: 'llm-task',
        workspaceDir: '/tmp/oc-s3-llm-task-live',
        params: {
          prompt: 'Return a JSON object with a single key "ok" whose value is the boolean true.',
          provider: probe.provider,
          model: probe.model,
          timeoutMs: 120_000,
        },
        // No runPiCommand ⇒ the DEFAULT real spawn runs a genuine nested pi.
      })) as { content?: Array<{ text?: string }>; details?: { json?: unknown } };

      const text = result.content?.[0]?.text ?? '';
      expect(text.length, 'real nested pi must produce non-empty payload text').toBeGreaterThan(0);
      // It parsed to a JSON object (llm-task only returns when JSON.parse succeeded).
      expect(result.details?.json).toBeTypeOf('object');
    },
    180_000,
  );
});
