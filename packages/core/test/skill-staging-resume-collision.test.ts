// REGRESSION — skill-staging destination collision on a `--from` resume (test-discipline §0, integration
// gate). Reproduces the real game-omni failure: `piflowctl run --from <node>` resumes a whole STAGE
// (window.ts `stageMatches` matches the STAGE containing the named node, so every sibling in that parallel
// stage re-runs together — not just the named node). When ≥2 of those siblings declare `skill` as a
// `.../<skill-dir>/SKILL.md` FILE ref (node.schema.ts: "Optional SKILL.md pointer inlined into the realized
// prompt" — a sanctioned authoring form, not a misuse), `resolveSkillStage` basenamed the FILE directly
// (skill.ts pre-fix), so every sibling's staged name collapsed to the literal "SKILL.md" — all racing
// `fs.cp` onto the SAME `<run>/.pi/skills/SKILL.md` destination concurrently.
//
// Observed live (game-omni run p08, `--from guidance`): `skill staging failed: ENOENT: no such file or
// directory, chmod '<run>/.pi/skills/SKILL.md'` — Node's `fs.cp` internally copies then chmods the dest; a
// concurrent sibling's own copy/unlink of the SAME path can remove it in that window (also observed as
// `unlink`/`open` ENOENT on the same path — the syscall varies with interleaving, the destination never
// does). The race is probabilistic per run (a fresh run can get lucky; empirically ~1/3 of trials failed
// pre-fix), so this test STRESS-LOOPS many resume trials — pre-fix that made a failure to reproduce
// overwhelmingly likely; post-fix every trial is deterministically collision-free (no shared destination
// exists to race on), so the loop is not flaky going forward.

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile } from '../src/index.js';
import type { NodeIntent, WorkflowSpec } from '../src/index.js';
import { runWorkflow } from '../src/runner/index.js';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** A `<root>/<name>/SKILL.md` file with unique content — the FILE-ref authoring form node.schema.ts sanctions. */
async function makeSkillFile(root: string, name: string): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  const md = path.join(dir, 'SKILL.md');
  await fs.writeFile(md, `---\nname: ${name}\n---\nskill body for ${name}\n`.repeat(20));
  return md;
}

/** Writes each declared artifact + a parseable return block — no live pi, mirrors runner.test's stubBuilder. */
function stubBuilder() {
  return (node: { id: string; io: { artifacts: { path: string }[] }; sandbox: { output: string } }): string => {
    const writes = node.io.artifacts
      .map((a) => {
        const dest = `${node.sandbox.output}/${a.path}`;
        const dir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '.';
        return `mkdir -p ${dir} && printf '%s' ${node.id} > ${dest}`;
      })
      .join(' && ');
    const ret = `printf '%s' '\`\`\`json\n{"status":"ok","summary":"${node.id} done"}\n\`\`\`'`;
    return writes ? `${writes} && ${ret}` : ret;
  };
}

// Mirrors game-omni's "producers" stage: 5 siblings, same deps, each with a DIFFERENT skill but the SAME
// Agent-Skill filename convention (every ref ends in `/SKILL.md`).
const SIBLINGS = ['asset', 'guidance', 'model', 'shell', 'sound'];
const TRIALS = 20; // pre-fix P(at least one trial hits the race) ≈ 1 - (1-1/3)^20 > 0.999

describe('skill staging — concurrent siblings resumed via `--from` never collide on the staged destination', () => {
  it(`stress: ${TRIALS} fresh-run+resume cycles, 5 concurrent skill-bearing siblings each trial — zero staging errors, zero cross-contamination`, async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const skillRoot = await tmpDir('piflow-skillsrc-');
      const skillFiles: Record<string, string> = {};
      for (const id of SIBLINGS) skillFiles[id] = await makeSkillFile(skillRoot, id);

      const nodes: NodeIntent[] = [
        {
          label: 'gameplay',
          prompt: 'do gameplay',
          tools: {},
          io: { reads: [], produces: ['gameplay.json'], artifacts: [{ path: 'gameplay.json' }] },
        },
        ...SIBLINGS.map(
          (id): NodeIntent => ({
            label: id,
            prompt: `do ${id}`,
            tools: {},
            io: { reads: ['gameplay.json'], produces: [`${id}.json`], artifacts: [{ path: `${id}.json` }] },
            skill: skillFiles[id],
          }),
        ),
      ];
      const wfSpec: WorkflowSpec = { meta: { name: 'collision-repro', description: 'd' }, nodes };
      const g = compile(wfSpec);
      const outDir = await tmpDir('piflow-run-');

      // RUN 1 — fresh: every node runs once, staging its own skill.
      const r1 = await runWorkflow(g, { run: 'r', outDir, buildCommand: stubBuilder() });
      expect(r1.status.ok, `trial ${trial} fresh run: ${JSON.stringify(r1.status.nodes)}`).toBe(true);

      // RUN 2 — resume `--from guidance`: window.ts's stageMatches resolves the WHOLE producers stage
      // (asset/guidance/model/shell/sound all share it), so all 5 re-stage their skill CONCURRENTLY —
      // exactly the game-omni p08 shape. `noResume` forces the window's nodes to actually re-execute
      // (mirrors a real `--from` rerun, not a no-op reuse).
      const r2 = await runWorkflow(g, { run: 'r', outDir, from: 'guidance', noResume: true, buildCommand: stubBuilder() });

      for (const id of SIBLINGS) {
        const rec = r2.status.nodes[id];
        expect(rec.status, `trial ${trial} node ${id}: ${JSON.stringify(rec.issues)}`).toBe('ok');
      }

      // No cross-contamination: each node's staged SKILL.md is byte-identical to ITS OWN source, not a
      // sibling's (the failure mode when two nodes' fs.cp race onto the SAME destination and one wins).
      for (const id of SIBLINGS) {
        const ownContent = await fs.readFile(skillFiles[id], 'utf8');
        const staged = await fs.readdir(path.join(outDir, '.pi', 'skills'), { recursive: true } as never).catch(() => [] as string[]);
        // Locate this node's staged SKILL.md by its unique skill name (collision-free naming under the fix).
        const stagedPath = path.join(outDir, '.pi', 'skills', id, 'SKILL.md');
        const stagedContent = await fs.readFile(stagedPath, 'utf8').catch((e) => {
          throw new Error(`trial ${trial}: expected staged skill for ${id} at ${stagedPath}; dir listing: ${JSON.stringify(staged)}; ${e.message}`);
        });
        expect(stagedContent, `trial ${trial}: ${id}'s staged SKILL.md diverged from its own source (cross-contamination)`).toBe(ownContent);
      }

      await fs.rm(outDir, { recursive: true, force: true });
      await fs.rm(skillRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
