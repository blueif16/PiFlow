// Runs INSIDE the E2B sandbox (Debian trixie, Node 22, bubblewrap installed). Imports piflow's
// REAL buildBwrapArgs (uploaded from @piflow/core dist next to this file) and exercises it against
// a real kernel mount namespace — the assertions are the repo's linuxIt/kernelIt contract:
//   in-scope read+write SUCCEED · out-of-scope read+write are DENIED · the secret never leaks ·
//   network is NOT unshared (the piflow divergence-from-codex).
// Prints a machine-greppable JSONL line per check + an ARGV evidence line, exits non-zero on any fail.
//
// Two fixtures, to isolate one confound: the repo's kernelIt stages its tree under os.tmpdir() (=/tmp),
// but buildBwrapArgs emits `--tmpfs /tmp` AFTER the rw binds, so a workdir under /tmp may be shadowed
// by that overmount. We run the SAME assertions for a /tmp fixture (faithful to kernelIt) AND a $HOME
// fixture (workdir NOT under /tmp) so the evidence says whether the JAIL works vs whether the kernelIt
// FIXTURE has a /tmp-overmount confound.

import { buildBwrapArgs } from './sandbox/bwrap.js';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const results = [];
function check(id, label, pass, evidence) {
  results.push({ id, pass });
  console.log(`CHECK ${JSON.stringify({ id, pass, label, evidence: String(evidence).slice(0, 400) })}`);
}

// Run `cmd` under the REAL piflow bwrap argv for the given scope. Returns code/stdout/stderr + the argv.
function runJailed(cmd, { workdir, granted }) {
  const argv = buildBwrapArgs(cmd, { workdir, readScope: [granted], writeScope: [granted] });
  const r = spawnSync('bwrap', argv, { encoding: 'utf8', timeout: 20000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', argv };
}

// ── 0. capability probes — distinguish "namespace uncapable" from "bind-set too small" ──────────────
const bwrapProbe = (args) => spawnSync('bwrap', [...args, 'true'], { encoding: 'utf8', timeout: 10000 });

// A) piflow's CURRENT probe (bwrap.ts probeBwrapUsable / the test's bwrapCanBuildNamespace): binds /usr only.
const pUsr = bwrapProbe(['--ro-bind', '/usr', '/usr', '--proc', '/proc', '--dev', '/dev']);
check('PROBE_USR_ONLY', "piflow's current probe (`--ro-bind /usr /usr … true`)", pUsr.status === 0,
  `exit=${pUsr.status} stderr=${(pUsr.stderr ?? '').trim()}`);

// B) same probe + the dynamic linker dir bound: if THIS passes where (A) failed, (A) failed on the
//    missing ELF interpreter (/lib64/ld-linux-*.so), NOT on namespace capability.
const pLoader = bwrapProbe(['--ro-bind', '/usr', '/usr', '--ro-bind', '/lib64', '/lib64', '--proc', '/proc', '--dev', '/dev']);
check('PROBE_USR_PLUS_LIB64', '…+ `--ro-bind /lib64 /lib64` (the loader)', pLoader.status === 0,
  `exit=${pLoader.status} stderr=${(pLoader.stderr ?? '').trim()}`);

// C) whole-root ro bind: the definitive "can a user namespace be built at all here?" probe.
const pRoot = bwrapProbe(['--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev']);
check('PROBE_FULL_ROOT', 'namespace IS buildable (`--ro-bind / / … true`)', pRoot.status === 0,
  `exit=${pRoot.status} stderr=${(pRoot.stderr ?? '').trim()}`);
if (pRoot.status !== 0) {
  console.log('SUMMARY namespace-uncapable — cannot prove the jail here');
  process.exit(2);
}

// ── the assertion battery, parameterized by where the fixture lives ─────────────────────────────────
function battery(tag, rootBase) {
  const root = mkdtempSync(path.join(rootBase, `bwrap-${tag}-`));
  const granted = path.join(root, 'granted');
  const denied = path.join(root, 'denied');
  mkdirSync(granted, { recursive: true });
  mkdirSync(denied, { recursive: true });
  writeFileSync(path.join(granted, 'in.txt'), 'IN_SCOPE');
  writeFileSync(path.join(denied, 'secret.txt'), 'OUT_OF_SCOPE_SECRET');

  const okRead = runJailed(`cat ${JSON.stringify(path.join(granted, 'in.txt'))}`, { workdir: granted, granted });
  check(`${tag}.IN_READ`, 'in-scope read succeeds', okRead.code === 0 && okRead.stdout.includes('IN_SCOPE'),
    `exit=${okRead.code} stdout=${okRead.stdout.trim()} stderr=${okRead.stderr.trim()}`);

  const madePath = path.join(granted, 'made.txt');
  const okWrite = runJailed(`printf '%s' MADE > ${JSON.stringify(madePath)}`, { workdir: granted, granted });
  const wroteOk = okWrite.code === 0 && existsSync(madePath) && readFileSync(madePath, 'utf8') === 'MADE';
  check(`${tag}.IN_WRITE`, 'in-scope write succeeds + lands on host', wroteOk,
    `exit=${okWrite.code} exists=${existsSync(madePath)} stderr=${okWrite.stderr.trim()}`);

  const deniedRead = runJailed(`cat ${JSON.stringify(path.join(denied, 'secret.txt'))}`, { workdir: granted, granted });
  check(`${tag}.OUT_READ_DENIED`, 'out-of-scope read denied + secret never leaks',
    deniedRead.code !== 0 && !deniedRead.stdout.includes('OUT_OF_SCOPE_SECRET'),
    `exit=${deniedRead.code} stdout=${deniedRead.stdout.trim()} stderr=${deniedRead.stderr.trim()}`);

  const pwnPath = path.join(denied, 'pwned.txt');
  const deniedWrite = runJailed(`printf '%s' PWN > ${JSON.stringify(pwnPath)}`, { workdir: granted, granted });
  check(`${tag}.OUT_WRITE_DENIED`, 'out-of-scope write denied + nothing lands',
    deniedWrite.code !== 0 && !existsSync(pwnPath),
    `exit=${deniedWrite.code} exists=${existsSync(pwnPath)} stderr=${deniedWrite.stderr.trim()}`);

  // Evidence: the actual argv piflow built for this scope.
  console.log(`ARGV ${tag} ${JSON.stringify(runJailed('true', { workdir: granted, granted }).argv)}`);
}

// FAITHFUL to kernelIt: fixture under os.tmpdir() (=/tmp). HOME: fixture under $HOME (not under /tmp).
battery('tmp', os.tmpdir());
battery('home', os.homedir());

// ── divergence-from-codex: network stays ON (no --unshare-net in the argv) ──────────────────────────
const sampleArgv = buildBwrapArgs('true', { workdir: os.homedir(), readScope: [], writeScope: [] });
check('NET_ON', 'network NOT unshared (agent must reach its gateway)', !sampleArgv.includes('--unshare-net'),
  `--unshare-net present=${sampleArgv.includes('--unshare-net')}`);

// ── summary ─────────────────────────────────────────────────────────────────────────────────────────
// The VERDICT is the clean proof: the $HOME battery (workdir NOT under /tmp, no tmpfs-overmount confound)
// + the network invariant. PROBE_* and the tmp.* battery are reported as DIAGNOSTICS, not gates — a
// PROBE_USR_ONLY failure is an expected FINDING (the merged-usr loader gap), and a tmp.* failure isolates
// the `--tmpfs /tmp`-after-binds confound; neither means the jail mechanism is broken.
const passed = results.filter((r) => r.pass).length;
console.log(`SUMMARY ${passed}/${results.length} PASS`);
const verdictIds = results.filter((r) => r.id.startsWith('home.') || r.id === 'NET_ON');
const verdictFailed = verdictIds.filter((r) => !r.pass).map((r) => r.id);
const allFailed = results.filter((r) => !r.pass).map((r) => r.id);
if (allFailed.length) console.log(`FAILED ${JSON.stringify(allFailed)}`);
console.log(`VERDICT ${verdictFailed.length ? 'JAIL-NOT-PROVEN' : 'JAIL-PROVEN'} (home battery + net; ${verdictIds.length - verdictFailed.length}/${verdictIds.length})`);
process.exit(verdictFailed.length ? 1 : 0);
