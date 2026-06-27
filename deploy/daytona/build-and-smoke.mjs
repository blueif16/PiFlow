// Build the piflow node-runtime image via Daytona's DECLARATIVE Image builder, boot ONE VM
// from it, prove `pi` is present + runnable, then TEAR THE VM DOWN (cost-safe).
//
// WHY the declarative builder (not a registry push): `daytona.create({ image: Image })`
// ships the Dockerfile to Daytona, which builds it SERVER-SIDE and caches it (24h for
// on-the-fly, permanent if promoted to a snapshot). No local `docker build`, no registry
// credentials, no push — the cheapest mechanism the SDK supports. The Image below is the
// byte-equivalent of deploy/daytona/Dockerfile.
//
// Run from the repo root (where @daytona/sdk is installed):
//   DAYTONA_API_KEY=… node deploy/daytona/build-and-smoke.mjs
// Optional: PI_VERSION (default 0.80.2), KEEP=1 to skip teardown (debug only — bills).

import { Daytona, Image } from '@daytona/sdk';

const PI_VERSION = process.env.PI_VERSION ?? '0.80.2';
const KEEP = process.env.KEEP === '1';

// The piflow node-runtime image — MINIMAL+ tier (see Dockerfile header for the rationale).
const image = Image.base('node:22-trixie-slim')
  .runCommands(
    // one chained RUN so the apt cache is never persisted in a layer
    'apt-get update' +
      ' && apt-get install -y --no-install-recommends git ca-certificates' +
      ' && rm -rf /var/lib/apt/lists/*' +
      ` && npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${PI_VERSION}` +
      ' && pi --version',
  )
  .workdir('/home/daytona');

const daytona = new Daytona(); // reads DAYTONA_API_KEY / DAYTONA_API_URL from env

let sandbox;
try {
  console.log(`[1/4] creating VM from declarative image (pi@${PI_VERSION})…`);
  sandbox = await daytona.create(
    {
      image,
      // guard rails so a crash can't leak a billed VM
      autoStopInterval: 5, // idle stop after 5 min
      autoDeleteInterval: 15, // delete 15 min after stop
      resources: { cpu: 1, memory: 2, disk: 5 },
      labels: { purpose: 'piflow-image-smoke' },
    },
    {
      timeout: 600, // image build can take a couple minutes the first time
      onSnapshotCreateLogs: (c) => process.stdout.write(c),
    },
  );
  console.log(`\n[2/4] VM up: ${sandbox.id}`);

  const sh = async (cmd) => {
    const r = await sandbox.process.executeCommand(cmd);
    return { code: r.exitCode, out: (r.result ?? '').trim() };
  };

  console.log('[3/4] proving pi is present + runnable…');
  const which = await sh('command -v pi || true');
  const ver = await sh('pi --version');
  const node = await sh('node --version');
  const help = await sh('pi --help 2>&1 | head -20 || true');

  console.log('  which pi :', which.out || '(not found)');
  console.log('  node     :', node.out, `(exit ${node.code})`);
  console.log('  pi --version:', ver.out, `(exit ${ver.code})`);
  console.log('  pi --help (head):\n' + help.out.split('\n').map((l) => '    ' + l).join('\n'));

  const piOk = ver.code === 0 && /\d+\.\d+\.\d+/.test(ver.out);
  console.log(`\n[4/4] RESULT: pi runnable in VM = ${piOk ? 'YES ✅' : 'NO ❌'}`);
  if (!piOk) process.exitCode = 1;
} catch (err) {
  console.error('SMOKE TEST FAILED:', err?.message ?? err);
  process.exitCode = 1;
} finally {
  if (sandbox && !KEEP) {
    console.log('tearing down VM…');
    await daytona.delete(sandbox).catch((e) => console.error('teardown error (verify in dashboard!):', e?.message));
    console.log('VM deleted.');
  } else if (sandbox) {
    console.log(`KEEP=1 → VM ${sandbox.id} left running (bills). Delete it manually.`);
  }
}
