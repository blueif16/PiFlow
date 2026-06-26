// Eval #10 — role-prompt bars: for each seed preset, expansion preserves the seed's required-section
// coverage floor (G6 §8 test plan).
//
// DETERMINISTIC (required): load each of the 3 seeds, expand a node via mergePreset, and assert the
// expanded prompt carries the seed's required-section markers. A future edit that deletes a required
// section from a seed MUST turn these RED.
//
// GATED-LIVE (best-effort): one seed's expanded role-prompt+task through a real nested `pi` — a smoke
// that the expansion produces a non-empty answer addressing ≥2 of the seed's required dimensions.
//
// SCOPE: this file does NOT build an LLM-as-judge quality layer. Full quality judging is the
// piflow-enhance Companion-Mode loop's job — explicitly out of scope for these evals.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadAgentPreset,
  mergePreset,
  type PresetMergeable,
} from '../src/workflow/agent-preset.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// The seed preset files ship with the piflow-init skill, under this known path in the repo.
// From packages/core/test/ → ../../.. gets to the repo root.
const SEEDS_DIR = join(HERE, '../../..', '.claude/skills/piflow-init/references/agent-presets');

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

/** Expand a seed preset with a trivial task prompt and return the merged prompt string. */
function expandSeed(id: string, task: string): string {
  const preset = loadAgentPreset(id, SEEDS_DIR);
  if (!preset) throw new Error(`Seed '${id}' not found at ${SEEDS_DIR}`);
  const node: PresetMergeable = { prompt: task };
  return mergePreset(preset, node).prompt;
}

// ── live probe (verbatim from openclaw-host-llm-task.test.ts) ────────────────────────────────────

function piLiveProbe(): { runnable: boolean; provider: string; model: string; reason: string } {
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

// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('eval #10 — deterministic role-prompt bars: each seed keeps its required-section coverage floor', () => {
  // ── market-research seed ────────────────────────────────────────────────────────────────────────
  // Required sections per the seed file: market sizing, competitive landscape, demand signals + dated
  // source, target segments, risks/unknowns.
  it('market-research expanded prompt contains all required section markers', () => {
    const prompt = expandSeed('market-research', 'Size the EV-charging market in the US for 2025.');

    // Role body survived
    expect(prompt).toContain('senior market-research analyst');
    // Required sections (from the seed's own section labels)
    expect(prompt).toMatch(/market sizing/i);
    expect(prompt).toMatch(/competit/i);          // competitive landscape
    expect(prompt).toMatch(/dated source/i);       // demand signals & trends — each with a DATED source
    expect(prompt).toMatch(/target segment/i);     // target segments & the buyer
    expect(prompt).toMatch(/risk/i);               // risks/unknowns
    // No-fabrication MUST-NOT survived
    expect(prompt).toMatch(/must not fabricate/i);
    // Self-check/audit survived
    expect(prompt).toMatch(/audit|self-check|re-audit/i);
    // Task appended (role before task)
    expect(prompt).toContain('Size the EV-charging market');
    const roleIdx = prompt.indexOf('senior market-research analyst');
    const taskIdx = prompt.indexOf('Size the EV-charging market');
    expect(roleIdx).toBeLessThan(taskIdx);
  });

  // ── paper-analyzer seed ─────────────────────────────────────────────────────────────────────────
  // Required sections: problem & contribution, method, key results (actual numbers), experimental
  // setup & datasets, limitations, threats to validity, relation to prior work.
  it('paper-analyzer expanded prompt contains all required section markers', () => {
    const prompt = expandSeed('paper-analyzer', 'Analyze "Attention Is All You Need" (Vaswani et al., 2017).');

    // Role body survived
    expect(prompt).toContain('rigorous research-paper analyst');
    // Required sections (from the seed's own section labels)
    expect(prompt).toMatch(/problem.*contribution|contribution.*claim/i);  // problem & contribution claim
    expect(prompt).toMatch(/method/i);                                      // method
    expect(prompt).toMatch(/actual numbers|metrics/i);                     // key results with ACTUAL numbers
    expect(prompt).toMatch(/experimental setup|datasets/i);                // experimental setup & datasets
    expect(prompt).toMatch(/limitation/i);                                  // limitations
    expect(prompt).toMatch(/threat/i);                                      // threats to validity
    expect(prompt).toMatch(/prior work/i);                                  // relation to prior work
    // No-fabrication MUST-NOT survived
    expect(prompt).toMatch(/must not invent/i);
    // Self-check survived
    expect(prompt).toMatch(/check|verify/i);
    // Task appended (role before task)
    expect(prompt).toContain('Attention Is All You Need');
    const roleIdx = prompt.indexOf('rigorous research-paper analyst');
    const taskIdx = prompt.indexOf('Attention Is All You Need');
    expect(roleIdx).toBeLessThan(taskIdx);
  });

  // ── interview seed ───────────────────────────────────────────────────────────────────────────────
  // Required sections: CONDUCT mode (objective, warm-up, core questions by theme, probes/follow-ups,
  // wrap-up) and SYNTHESIZE mode (themes + verbatim quotes, saliency/frequency, contradictions,
  // actionable findings).
  it('interview expanded prompt contains all required section markers', () => {
    const prompt = expandSeed('interview', 'CONDUCT mode: explore user pain-points in enterprise expense reporting.');

    // Role body survived
    expect(prompt).toContain('qualitative interviewer');
    // CONDUCT mode markers
    expect(prompt).toMatch(/conduct mode/i);
    expect(prompt).toMatch(/warm.?up/i);           // warm-up
    expect(prompt).toMatch(/core questions/i);      // core questions grouped by theme
    expect(prompt).toMatch(/probe|follow.?up/i);   // probes / follow-ups
    expect(prompt).toMatch(/wrap.?up|wrap-up/i);   // wrap-up
    // SYNTHESIZE mode markers
    expect(prompt).toMatch(/synthesize mode/i);
    expect(prompt).toMatch(/verbatim quote/i);      // themes backed by VERBATIM quotes
    expect(prompt).toMatch(/saliency|frequency/i);  // saliency / frequency
    expect(prompt).toMatch(/contradiction/i);        // contradictions
    expect(prompt).toMatch(/actionable finding/i);  // actionable findings
    // No-fabrication MUST-NOT survived
    expect(prompt).toMatch(/must not fabricate/i);
    // Self-check survived
    expect(prompt).toMatch(/verify|quote-backed/i);
    // Task appended (role before task)
    expect(prompt).toContain('CONDUCT mode: explore');
    const roleIdx = prompt.indexOf('qualitative interviewer');
    const taskIdx = prompt.indexOf('CONDUCT mode: explore');
    expect(roleIdx).toBeLessThan(taskIdx);
  });
});

// ── GATED-LIVE smoke ─────────────────────────────────────────────────────────────────────────────
// Runs only when `pi --list-models` finds the configured provider/model. Drives a real nested pi with
// the market-research seed's expanded role-prompt+task, and asserts a LENIENT coverage floor:
// non-empty output addressing ≥2 of the seed's required dimensions (market sizing, competitive
// landscape, demand signals/trends, target segments, risks/unknowns). A terse-but-valid answer must
// PASS; this does NOT assert exact wording or quality — that is the piflow-enhance Companion loop's job.

const probe = piLiveProbe();

describe('eval #10 — gated-live smoke: market-research seed produces non-empty output covering ≥2 dimensions', () => {
  it.skipIf(!probe.runnable)(
    `GATED LIVE: market-research seed → real nested pi (${probe.provider}/${probe.model}) → ≥2 required dimensions present`,
    () => {
      // Build the expanded prompt
      const task = 'Briefly size the global SaaS-monitoring tools market. Keep your answer concise.';
      const expandedPrompt = expandSeed('market-research', task);

      // Write the expanded prompt to a temp file so we can pass it to pi as @<file>
      const workDir = mkdtempSync(join(tmpdir(), 'piflow-g6-live-'));
      const promptFile = join(workDir, 'prompt.md');
      writeFileSync(promptFile, expandedPrompt, 'utf8');

      // Run nested pi with the expanded role-prompt+task (same invocation shape as openclaw live test)
      let output = '';
      try {
        output = execFileSync(
          'pi',
          [
            '-p',
            '--mode', 'json',
            '-a',
            '--no-session',
            '--offline',           // no context files, offline mode
            '--no-extensions',
            '--no-context-files',
            '--provider', probe.provider,
            '--model', probe.model,
            `@${promptFile}`,
          ],
          { encoding: 'utf8', timeout: 120_000 },
        );
      } catch (err: any) {
        // A transient model/env error is NOT a test-authoring failure — report it and skip.
        // Per scope: "If the live model errors transiently, REPORT it, do not fight it or hard-fail."
        console.warn(`[GATED-LIVE] pi run failed (transient model/env issue): ${(err as Error).message}`);
        // Re-throw so the test is marked as failed (the error is surfaced, not silently swallowed).
        throw err;
      }

      // Extract final assistant text from the pi --mode json event stream;
      // also collect any errorMessage so we can detect a transient model error.
      let finalText = '';
      let transientError = '';
      for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const evt = JSON.parse(trimmed);
          if (evt.type === 'agent_end' && Array.isArray(evt.messages)) {
            for (const msg of evt.messages) {
              if (msg.role === 'assistant') {
                // Detect a rate-limit / model error carried in stopReason or errorMessage
                if (msg.stopReason === 'error' && msg.errorMessage && !transientError) {
                  transientError = msg.errorMessage;
                }
                if (Array.isArray(msg.content)) {
                  for (const block of msg.content) {
                    if (block.type === 'text' && typeof block.text === 'string') {
                      finalText += block.text;
                    }
                  }
                }
              }
            }
          }
        } catch {
          // non-JSON line (e.g. delta lines) — skip
        }
      }

      // If the model errored transiently (rate limit, quota, etc.) — report and skip the coverage check.
      // Per scope: "If the live model errors transiently, REPORT it, do not fight it or hard-fail."
      if (transientError && !finalText) {
        console.warn(`[GATED-LIVE] transient model/env error (skipping coverage check): ${transientError}`);
        // Mark as skipped by returning early — the test is structurally correct, the env is not ready.
        return;
      }

      // Lenient coverage floor: non-empty output addressing ≥2 of the seed's required dimensions
      expect(finalText.length, 'real nested pi must produce non-empty output').toBeGreaterThan(0);

      const dimensions = [
        /market siz|TAM|SAM|SOM/i,     // market sizing
        /competit/i,                      // competitive landscape
        /trend|demand/i,                  // demand signals & trends
        /segment|buyer/i,                // target segments & buyer
        /risk|unknown/i,                  // risks/unknowns
      ];
      const hit = dimensions.filter((re) => re.test(finalText)).length;
      expect(
        hit,
        `expected ≥2 required dimensions addressed; got ${hit}. Output (first 500 chars): ${finalText.slice(0, 500)}`,
      ).toBeGreaterThanOrEqual(2);
    },
    180_000,
  );
});
