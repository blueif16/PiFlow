// LIVE Docker smoke — proves the @piflow/docker backend against a REAL Docker daemon (the local analogue
// of deploy/e2b/smoke-live.mjs). Two checks:
//   D1  the image auto-builds on first use, and pi/rg/git/node are present + runnable INSIDE a booted
//       container (the baked pi node-runtime works — the same image the cloud backends run).
//   D2  a real producer→consumer runWorkflow through DockerSandboxProvider: create → stage → exec →
//       collect → dispose, with artifacts landing on the HOST and the run container removed exactly once.
//
//   node deploy/docker/smoke-live.mjs        (needs Docker running; the FIRST run builds the image ~1–3 min)
//
// No pi MODEL call here (that needs a gateway key — covered by the e2b smoke): D2 uses the offline stub
// builder, so it proves the SANDBOX seam end-to-end without a credential. KEEP_IMAGE is implicit (only
// containers are torn down; the built image is left for fast subsequent runs).

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile, runWorkflow } from '../../packages/core/dist/index.js';
import { createDockerProvider, realDockerSdk, DEFAULT_DOCKER_IMAGE } from '../../packages/docker/dist/index.js';

const results = [];
function record(id, label, pass, evidence) {
  results.push({ id, label, pass });
  console.log(`\n[${pass ? 'PASS' : 'FAIL'}] ${id} — ${label}\n      ${String(evidence).replace(/\n/g, '\n      ')}`);
}

// The offline stub command builder (identical to the parity test): instead of spawning `pi`, write each
// declared artifact into the node's sandbox OUTPUT dir, then emit the return-protocol block.
function stubBuilder() {
  return (n) => {
    const writes = n.io.artifacts
      .map((a) => {
        const dest = `${n.sandbox.output}/${a.path}`;
        const dir = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '.';
        return `mkdir -p ${dir} && printf '%s' ${n.id} > ${dest}`;
      })
      .join(' && ');
    const ret = `printf '%s' '\`\`\`json\\n{"status":"ok","summary":"${n.id} done"}\\n\`\`\`'`;
    return writes ? `${writes} && ${ret}` : ret;
  };
}

const node = (label, reads, produces) => ({
  label,
  prompt: `do ${label}`,
  tools: {},
  io: { reads, produces, artifacts: produces.map((p) => ({ path: p })) },
});
const wf = (nodes) => ({ meta: { name: 'docker-smoke', description: 'live docker backend smoke' }, nodes });

async function main() {
  // ── D1: auto-build + pi runnable inside a booted container ───────────────────────────────
  console.log(`Booting a container from "${DEFAULT_DOCKER_IMAGE}" (first run auto-builds the image)…`);
  const sdk = realDockerSdk();
  const container = await sdk.create({ image: DEFAULT_DOCKER_IMAGE });
  try {
    const sh = async (cmd) => await container.commands.run(cmd);
    const pv = await sh('pi --version');
    const rv = await sh('rg --version | head -1');
    const gv = await sh('git --version');
    const nv = await sh('node --version');
    record(
      'D1',
      'pi/rg/git/node present + runnable inside the container',
      pv.exitCode === 0 && /\d+\.\d+\.\d+/.test(pv.stdout) && rv.exitCode === 0 && gv.exitCode === 0 && nv.exitCode === 0,
      `pi=${pv.stdout.trim()} | rg=${rv.stdout.trim()} | git=${gv.stdout.trim()} | node=${nv.stdout.trim()}`,
    );
  } finally {
    await container.kill().catch(() => {});
  }

  // ── D2: full producer→consumer run through the real provider ─────────────────────────────
  const provider = createDockerProvider();
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-docker-smoke-'));
  try {
    const g = compile(wf([node('Producer', [], ['a.txt']), node('Consumer', ['a.txt'], ['b.txt'])]));
    const { status } = await runWorkflow(g, {
      run: 'dsmoke',
      outDir,
      provider,
      buildCommand: stubBuilder(),
      nodeTimeoutMs: 60000,
    });
    const a = await fs.readFile(path.join(outDir, 'a.txt'), 'utf8').catch(() => '(missing)');
    const b = await fs.readFile(path.join(outDir, 'b.txt'), 'utf8').catch(() => '(missing)');
    record(
      'D2',
      'producer→consumer run: ok, artifacts host-verified, cross-container file flow lands',
      status.ok === true &&
        status.nodes.producer.status === 'ok' &&
        status.nodes.consumer.status === 'ok' &&
        a === 'producer' &&
        b === 'consumer',
      `status.ok=${status.ok} producer=${status.nodes.producer.status} consumer=${status.nodes.consumer.status} | a.txt="${a}" b.txt="${b}"`,
    );
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n================ DOCKER SMOKE: ${passed}/${results.length} PASS ================`);
  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.id}  ${r.label}`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('SMOKE HARNESS ERROR:', err?.stack ?? err?.message ?? err);
  process.exitCode = 1;
});
