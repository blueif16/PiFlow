// LIVE E2B verification of the bwrap filesystem jail (the Linux peer of seatbelt). Boots ONE sandbox
// from the piflow-node-runtime template (Debian trixie, Node 22 — NO Ubuntu-24.04 AppArmor userns
// clamp), installs bubblewrap, uploads @piflow/core's REAL bwrap.js + scope.js + the proof driver, then
// runs the driver as the UNPRIVILEGED default `user` (exactly how `pi` runs) to prove the kernel
// boundary GitHub's hosted runners can't (they can't build a namespace). Kills the sandbox in finally.
//
//   pnpm --filter @piflow/core build            # dist must be current — the proof runs the BUILT argv
//   set -a; source ~/.zshenv; set +a; node deploy/e2b/bwrap-jail-live.mjs
//
// Env: E2B_API_KEY (boot). E2B_TEMPLATE (default: the built piflow-node-runtime id). KEEP=1 skips teardown.

import { Sandbox } from 'e2b';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEMPLATE = process.env.E2B_TEMPLATE ?? 'riwrtwrfanz3tewd5pw6';
const KEEP = process.env.KEEP === '1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '../../packages/core/dist/sandbox');
const REMOTE = '/home/user/proof';

const bwrapJs = readFileSync(path.join(DIST, 'bwrap.js'), 'utf8');
const scopeJs = readFileSync(path.join(DIST, 'scope.js'), 'utf8');
const driverJs = readFileSync(path.join(HERE, 'bwrap-proof-driver.mjs'), 'utf8');

let sandbox;
let exitCode = 1;
try {
  console.log(`Booting ONE sandbox from template "${TEMPLATE}" (timeout 5m)…`);
  sandbox = await Sandbox.create(TEMPLATE, { timeoutMs: 5 * 60 * 1000 });
  console.log(`Sandbox up: ${sandbox.sandboxId}`);

  const sh = async (cmd, opts = {}) => {
    try {
      const r = await sandbox.commands.run(cmd, { timeoutMs: 180000, ...opts });
      return { code: r.exitCode, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
    } catch (e) {
      return { code: e.exitCode ?? -1, out: (e.stdout ?? '').trim(), err: (e.stderr ?? String(e)).trim() };
    }
  };

  // ── distro identity (evidence: WHY this works where GH ubuntu runners don't) ──
  const osrel = await sh('. /etc/os-release && echo "$ID $VERSION_ID ($VERSION_CODENAME)"');
  const nodev = await sh('node --version');
  console.log(`\nVM: ${osrel.out} | node ${nodev.out}`);

  // ── install bubblewrap (template omits it; root, since runtime user is unprivileged `user`) ──
  console.log('\nInstalling bubblewrap (apt, as root)…');
  const apt = await sh('apt-get update -qq && apt-get install -y -qq bubblewrap', { user: 'root' });
  if (apt.code !== 0) throw new Error(`apt install bubblewrap failed (exit ${apt.code}): ${apt.err.slice(0, 500)}`);
  const bwv = await sh('bwrap --version');
  console.log(`bubblewrap: ${bwv.out || bwv.err}`);

  // ── stage the REAL @piflow/core argv builder + the proof driver ──
  await sandbox.files.write(`${REMOTE}/sandbox/bwrap.js`, bwrapJs);
  await sandbox.files.write(`${REMOTE}/sandbox/scope.js`, scopeJs);
  await sandbox.files.write(`${REMOTE}/driver.mjs`, driverJs);

  // ── run the proof as the UNPRIVILEGED default user (how pi actually runs) ──
  console.log('\nRunning the jail proof as the unprivileged `user`…\n');
  const proof = await sh(`node ${REMOTE}/driver.mjs`, { cwd: REMOTE, timeoutMs: 120000 });
  if (proof.out) console.log(proof.out);
  if (proof.err) console.log('[driver stderr]\n' + proof.err);

  const summary = (proof.out.match(/^SUMMARY .*/m) || [''])[0];
  console.log(`\n================ ${summary || 'NO SUMMARY (driver crashed)'} ================`);
  exitCode = proof.code === 0 ? 0 : 1;
} catch (err) {
  console.error('HARNESS ERROR:', err?.message ?? err);
  exitCode = 1;
} finally {
  if (sandbox && !KEEP) {
    console.log('\nTearing down sandbox…');
    await sandbox.kill().catch((e) => console.error('teardown error (VERIFY in dashboard!):', e?.message));
    console.log(`Sandbox ${sandbox.sandboxId} killed.`);
  } else if (sandbox) {
    console.log(`KEEP=1 → sandbox ${sandbox.sandboxId} left running (bills). Kill manually.`);
  }
  process.exitCode = exitCode;
}
