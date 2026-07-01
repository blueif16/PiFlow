// Promote the piflow node-runtime image to a PERMANENT, named Daytona SNAPSHOT.
//
// WHY a snapshot (vs the declarative-image path in build-and-smoke.mjs): a declarative
// image is built server-side and cached only ~24h — fine for iterating, useless as a
// stable default. A SNAPSHOT is permanent + instant (no rebuild), lives in Daytona's OWN
// store (visible in the Daytona Dashboard), and needs NO external container registry
// (Docker Hub/GHCR/GAR/ECR are SUPPORTED but not required for the declarative-builder
// path — see https://www.daytona.io/docs/snapshots). Once promoted, `--sandbox daytona`
// boots from it by default: createDaytonaProvider({ snapshot }) → daytona.create({ snapshot }).
//
// This is the production analogue of M0's build-and-smoke: same image bytes, registered
// once under a stable name the CLI defaults to (run.ts DEFAULT_DAYTONA_SNAPSHOT — keep the
// name in sync). Idempotent-friendly: a name that already exists is reported, not fatal.
//
// Run from the repo root (where @daytona/sdk is installed):
//   DAYTONA_API_KEY=… node deploy/daytona/promote-snapshot.mjs
// Env: PI_VERSION (default 0.80.2) · SNAPSHOT (default piflow-node-runtime-<PI_VERSION>)
//      SMOKE=1 → after promoting, boot ONE VM from the snapshot, prove `pi`+`rg`, tear down.

import { Daytona, Image } from '@daytona/sdk';
import { baseImage, runCommand, backends, piVersion, snapshotName } from '../pi-runtime/runtime.mjs';

const PI_VERSION = process.env.PI_VERSION ?? piVersion;
// snapshotName() MUST match packages/cli/src/run.ts DEFAULT_DAYTONA_SNAPSHOT so `--sandbox daytona`
// finds it (Daytona names are dot-free → the spec sanitizes 0.80.2 → 0-80-2).
const SNAPSHOT = process.env.SNAPSHOT ?? snapshotName(PI_VERSION);
const SMOKE = process.env.SMOKE === '1';

// The piflow node-runtime image, built from the SHARED spec (deploy/pi-runtime/runtime.mjs) —
// same recipe the E2B + local-Docker Dockerfiles render from. Only the workdir is Daytona-specific.
const image = Image.base(baseImage)
  .runCommands(runCommand(PI_VERSION))
  .workdir(backends.daytona.workdir);

const daytona = new Daytona(); // reads DAYTONA_API_KEY / DAYTONA_API_URL from env

console.log(`[1/${SMOKE ? 3 : 2}] promoting snapshot "${SNAPSHOT}" (pi@${PI_VERSION})…`);
try {
  await daytona.snapshot.create(
    {
      name: SNAPSHOT,
      image,
      resources: { cpu: 1, memory: 2, disk: 5 },
    },
    { onLogs: (c) => process.stdout.write(c), timeout: 600 },
  );
  console.log(`\n[2/${SMOKE ? 3 : 2}] snapshot "${SNAPSHOT}" registered (permanent; visible in the Daytona Dashboard).`);
} catch (err) {
  const msg = err?.message ?? String(err);
  // An already-registered name is the idempotent case — report, don't fail the promotion intent.
  if (/exist|already|conflict|duplicate/i.test(msg)) {
    console.log(`\n[2/${SMOKE ? 3 : 2}] snapshot "${SNAPSHOT}" already exists — leaving it as-is (idempotent).`);
  } else {
    console.error('SNAPSHOT PROMOTION FAILED:', msg);
    process.exitCode = 1;
  }
}

if (SMOKE && !process.exitCode) {
  console.log(`[3/3] smoke: booting ONE VM from snapshot "${SNAPSHOT}"…`);
  let sandbox;
  try {
    sandbox = await daytona.create(
      { snapshot: SNAPSHOT, autoStopInterval: 5, autoDeleteInterval: 15, labels: { purpose: 'piflow-snapshot-smoke' } },
      { timeout: 300 },
    );
    const sh = async (cmd) => (await sandbox.process.executeCommand(cmd)).result?.trim() ?? '';
    const ver = await sh('pi --version');
    const rg = await sh('command -v rg || echo MISSING');
    console.log('  pi --version:', ver);
    console.log('  rg          :', rg);
    const ok = /\d+\.\d+\.\d+/.test(ver) && !rg.includes('MISSING');
    console.log(`  RESULT: snapshot usable = ${ok ? 'YES ✅' : 'NO ❌'}`);
    if (!ok) process.exitCode = 1;
  } catch (err) {
    console.error('SNAPSHOT SMOKE FAILED:', err?.message ?? err);
    process.exitCode = 1;
  } finally {
    if (sandbox) {
      await daytona.delete(sandbox).catch((e) => console.error('teardown error (verify in dashboard!):', e?.message));
      console.log('  smoke VM deleted.');
    }
  }
}
