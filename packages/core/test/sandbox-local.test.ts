import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalSandbox, LocalSandboxProvider } from '../src/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// LocalSandboxProvider — the IN-PLACE sandbox: the node runs directly in a REAL
// existing directory (the user's working tree), the semantic OPPOSITE of
// InMemorySandbox (which mkdtemps a throwaway workspace and wipes it on dispose).
//
// Every fixture roots the sandbox at a THROWAWAY OS temp dir it creates and nukes
// in a finally — never the real cwd. The point of the provider is that it does NOT
// delete its root, so the TEST owns cleanup of the dir it hands in.
// ─────────────────────────────────────────────────────────────────────────────

async function tmpWork(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'piflow-local-fixture-'));
}

// ── 1. GAP-1: root IS resolve(workdir), NOT a mkdtemp child (the load-bearing assertion) ─────────────

describe('LocalSandbox — roots in-place at workdir (the GAP-1 regression guard)', () => {
  it('create({workdir}) sets root === resolve(workdir) and is NOT a tmpdir child', async () => {
    // The whole point of the in-place provider: the sandbox root IS the directory the caller named, so
    // the node runs in the user's real tree — NOT a fresh mkdtemp under os.tmpdir() the way InMemory does.
    // If create() regressed to mkdtemp-ing a child (the GAP-1 bug), root would live under os.tmpdir() and
    // would NOT equal resolve(workdir) — both assertions below would then fail.
    const work = await tmpWork();
    try {
      const sb = await LocalSandbox.create({ readScope: [], outputDir: 'out', workdir: work });
      expect(sb.root).toBe(path.resolve(work));
      // It is NOT a mkdtemp child: the root is exactly `work`, not some `os.tmpdir()/piflow-*` dir nested
      // under it (a mkdtemp child would be a DIFFERENT, deeper path that merely starts with tmpdir()).
      const realTmp = await fs.realpath(os.tmpdir());
      const realRoot = await fs.realpath(sb.root);
      const realWork = await fs.realpath(work);
      expect(realRoot).toBe(realWork);
      // The mkdtemp regression would nest root strictly BELOW work (work/piflow-xxxx); assert it doesn't.
      expect(path.dirname(realRoot)).not.toBe(realWork);
      // (realTmp referenced so the intent — "lives at work, not under a tmpdir child" — is explicit.)
      expect(realRoot.startsWith(realTmp)).toBe(true); // work itself is under tmpdir; root === work, not deeper
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  });
});

// ── 2. writeFile → readFile round-trips on the REAL tree ─────────────────────────────────────────────

describe('LocalSandbox — operates on the real tree at root', () => {
  it('writeFile then readFile round-trips, and the bytes land on disk at root/<path>', async () => {
    // write/read resolve under the REAL root, so a file written through the sandbox is the same file on
    // disk at <root>/<path> — assert BOTH the sandbox read-back AND the raw on-disk path agree.
    const work = await tmpWork();
    try {
      const sb = await LocalSandbox.create({ readScope: [], outputDir: 'out', workdir: work });
      await sb.writeFile('sub/in.txt', 'hello-real-tree');
      expect(await sb.readFile('sub/in.txt', { encoding: 'utf8' })).toBe('hello-real-tree');
      // It is the REAL tree: the byte file exists at the host path, readable WITHOUT the sandbox.
      expect(await fs.readFile(path.join(work, 'sub', 'in.txt'), 'utf8')).toBe('hello-real-tree');
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  });
});

// ── 3. dispose PRESERVES the tree (the never-delete-the-user's-tree invariant) ───────────────────────

describe('LocalSandbox — dispose preserves the tree (NEVER deletes the root)', () => {
  it('a file written before dispose is STILL readable on disk after dispose', async () => {
    // The load-bearing OPPOSITE of InMemory: dispose must be a NO-OP that leaves the real workspace
    // intact. Write a file, dispose, then read it straight off disk — it must still be there. If dispose
    // regressed to `fs.rm(root, {recursive:true})` (the InMemory behavior), the file — and the dir —
    // would be gone and the on-disk read below would reject.
    const work = await tmpWork();
    try {
      const sb = await LocalSandbox.create({ readScope: [], outputDir: 'out', workdir: work });
      await sb.writeFile('keep.txt', 'survives-dispose');
      await sb.dispose();
      // The root dir still exists AND the file is still readable on disk (dispose preserved the tree).
      expect((await fs.stat(work)).isDirectory()).toBe(true);
      expect(await fs.readFile(path.join(work, 'keep.txt'), 'utf8')).toBe('survives-dispose');
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  });
});

// ── 4. downloadDir is GUARDED IDENTITY: no-op when same realpath, THROW on a real mismatch ───────────

describe('LocalSandbox — downloadDir is guarded identity (no-op same path, throw on mismatch)', () => {
  it('is a no-op when remote and local resolve to the SAME real path (output already on disk)', async () => {
    // In-place: the output already lives at the host location, so collecting it to ITSELF is a no-op
    // (NOT a copy — a self-copy would error or clone a dir into itself). Point remote and local at the
    // same real dir and assert it resolves WITHOUT throwing and WITHOUT altering the tree.
    const work = await tmpWork();
    try {
      const sb = await LocalSandbox.create({ readScope: [], outputDir: 'out', workdir: work });
      await sb.writeFile('out/done.txt', 'collected');
      // remote 'out' resolves under root; local = the SAME absolute dir → identity no-op.
      await expect(sb.downloadDir('out', path.join(work, 'out'))).resolves.toBeUndefined();
      // The file is untouched (no clone-into-itself corruption).
      expect(await fs.readFile(path.join(work, 'out', 'done.txt'), 'utf8')).toBe('collected');
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  });

  it('THROWS on a real mismatch (a non-identity collection target is a misuse, not a silent no-op)', async () => {
    // A real mismatch means the caller asked to collect the output somewhere it does NOT already live —
    // for an in-place sandbox that is a MISUSE, and a silent no-op would drop the deliverable. So it must
    // THROW. If downloadDir were an unconditional no-op (the run.mjs reference behavior we DROPPED), this
    // would resolve and the assertion would fail.
    const work = await tmpWork();
    const other = await tmpWork(); // a DIFFERENT real dir
    try {
      const sb = await LocalSandbox.create({ readScope: [], outputDir: 'out', workdir: work });
      await sb.writeFile('out/done.txt', 'collected');
      await expect(sb.downloadDir('out', path.join(other, 'out'))).rejects.toThrow(/identity|mismatch/i);
    } finally {
      await fs.rm(work, { recursive: true, force: true });
      await fs.rm(other, { recursive: true, force: true });
    }
  });
});

// ── 5. exec: nonzero exit surfaced; a signal reaps the whole process group ───────────────────────────

describe('LocalSandbox — exec contract (nonzero exit, process-group kill on signal)', () => {
  it('surfaces a nonzero exit code', async () => {
    const work = await tmpWork();
    try {
      const sb = await LocalSandbox.create({ readScope: [], outputDir: 'out', workdir: work });
      expect((await sb.exec('exit 3')).code).toBe(3);
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  });

  it('aborting the signal reaps the whole group: a grandchild deferred write never lands', async () => {
    // Mirror of the SeatbeltSandbox signal-kill test. A HOST marker OUTSIDE the sandbox root: the command
    // sleeps then would `touch` it — but we abort mid-sleep, which SIGTERMs the process GROUP (`-pid`,
    // sh → sleep). With detached:true the whole group dies → `sleep` is reaped → the deferred `touch`
    // never runs → the marker never appears, and exec resolves PROMPTLY (124) rather than blocking the
    // full sleep. If exec did NOT make the child a group leader (detached:false), kill(-pid) is a no-op,
    // the orphaned sleep runs to completion, the marker appears, AND exec resolves only after the full
    // sleep — both assertions below then fail.
    const work = await tmpWork();
    const marker = path.join(os.tmpdir(), `piflow-local-latekill-${Date.now()}.marker`);
    try {
      const sb = await LocalSandbox.create({ readScope: [], outputDir: 'out', workdir: work });
      const ac = new AbortController();
      const t0 = Date.now();
      const execP = sb.exec(`sleep 2 && touch ${marker}`, { signal: ac.signal });
      setTimeout(() => ac.abort(), 100); // abort well before the 2s sleep ends
      const r = await execP;
      const elapsed = Date.now() - t0;

      // (a) exec resolved PROMPTLY — the group was killed, not waited out (the orphan would take ~2s).
      expect(elapsed).toBeLessThan(1500);
      expect(r.code).not.toBe(0); // signal-killed child surfaces nonzero (124)

      // (b) wait well past the would-be 2s touch; the marker must NOT appear (the grandchild was reaped).
      await new Promise((res) => setTimeout(res, 2200));
      await expect(fs.access(marker)).rejects.toThrow();
    } finally {
      await fs.rm(marker, { force: true }).catch(() => {});
      await fs.rm(work, { recursive: true, force: true });
    }
  }, 15000);
});

// ── 6. READ-SCOPE JAIL: secure by default (darwin), with a danger bypass that actually turns it off ───

// On darwin the in-place LocalSandbox now wraps every exec in the shared sandbox-exec read-scope jail by
// default, so a read outside the declared scope EPERMs. Off darwin there is no kernel boundary (the bwrap
// backend is unwired), so the EPERM assertions are darwin-only — the policy-field test below is universal.
const darwinIt = process.platform === 'darwin' ? it : it.skip;

// Stage scope fixtures under $HOME: the seatbelt template grants only specific ~/. subpaths (~/.pi,
// ~/.piflow, ~/.npm, …), NOT $HOME itself, so a `.pf-localscope-*` sibling is genuinely outside every
// grant and is denied unless it is the declared scope. (Staging under $TMPDIR would be readable via the
// broad /private/var toolchain grant and could never observe a denial — the same discipline the seatbelt
// suite uses.)
async function homeScratch(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.homedir(), `.pf-localscope-${prefix}-`));
}

describe('LocalSandbox — read-scope jail is SECURE BY DEFAULT (darwin)', () => {
  darwinIt(
    'default enforceReadScope: reads an in-scope file but EPERMs an out-of-scope sibling',
    async () => {
      // In-place at `granted` with scope=[granted]; `denied` is a SIBLING outside the workdir + scope.
      // The default (no runtime opts) must jail reads: granted reads, denied EPERMs at the kernel.
      const scratch = await homeScratch('jail');
      const granted = path.join(scratch, 'granted');
      const denied = path.join(scratch, 'denied');
      await fs.mkdir(granted, { recursive: true });
      await fs.mkdir(denied, { recursive: true });
      await fs.writeFile(path.join(granted, 'in.txt'), 'IN_SCOPE_CONTENT');
      await fs.writeFile(path.join(denied, 'secret.txt'), 'OUT_OF_SCOPE_SECRET');
      try {
        const sb = await LocalSandbox.create({ readScope: [granted], outputDir: 'out', workdir: granted });

        const ok = await sb.exec(`cat ${JSON.stringify(path.join(granted, 'in.txt'))}`);
        expect(ok.code).toBe(0);
        expect(ok.stdout).toContain('IN_SCOPE_CONTENT');

        // Out-of-scope read fails with a KERNEL denial — not a missing file, not a profile parse error
        // (`sandbox-exec:` prefix), and the secret never reaches stdout.
        const blocked = await sb.exec(`cat ${JSON.stringify(path.join(denied, 'secret.txt'))}`);
        expect(blocked.code).not.toBe(0);
        expect(blocked.stdout).not.toContain('OUT_OF_SCOPE_SECRET');
        expect(blocked.stderr).not.toMatch(/^sandbox-exec:/m);
        expect(blocked.stderr).toMatch(/Operation not permitted|Permission denied/i);

        // CONTROL: the same path reads fine UNSANDBOXED, so the denial is the jail, not a missing file.
        expect(await fs.readFile(path.join(denied, 'secret.txt'), 'utf8')).toBe('OUT_OF_SCOPE_SECRET');
      } finally {
        await fs.rm(scratch, { recursive: true, force: true });
      }
    },
    20000,
  );

  darwinIt(
    'danger bypass (enforceReadScope:false): the SAME out-of-scope read SUCCEEDS (the hatch really disables the jail)',
    async () => {
      // The negative control that makes the test above meaningful: flip the flag off (the
      // danger-full-access posture) and the identical out-of-scope read must LEAK — proving the jail is
      // gated by the flag, not hard-wired. If enforcement were always-on this fails; if the first test's
      // EPERM is real, this success proves the two postures are genuinely different.
      const scratch = await homeScratch('danger');
      const work = path.join(scratch, 'work');
      const denied = path.join(scratch, 'denied');
      await fs.mkdir(work, { recursive: true });
      await fs.mkdir(denied, { recursive: true });
      await fs.writeFile(path.join(denied, 'secret.txt'), 'BYPASS_LEAK');
      try {
        const sb = await LocalSandbox.create(
          { readScope: [work], outputDir: 'out', workdir: work },
          { enforceReadScope: false },
        );
        const leak = await sb.exec(`cat ${JSON.stringify(path.join(denied, 'secret.txt'))}`);
        expect(leak.code).toBe(0);
        expect(leak.stdout).toContain('BYPASS_LEAK');
      } finally {
        await fs.rm(scratch, { recursive: true, force: true });
      }
    },
    20000,
  );
});

// ── 7. WRITE-SCOPE JAIL: symmetric to reads — writes confined to workdir + owns (darwin) ─────────────
//
// The same `enforceReadScope` posture that bounds READS now bounds WRITES: a node's fs:write / bash can
// only land bytes inside its declared lane (workdir + writeScope/owns + toolchain scratch). A write to a
// sibling node's dir, $HOME-sensitive paths, or the wider repo EPERMs at the kernel. Staged under $HOME
// (same discipline as the read tests) because the seatbelt template grants WRITE only to specific ~/.
// subpaths (~/.npm, ~/.cache, ~/.pi, …), NOT $HOME itself, so a `.pf-localwrite-*` sibling is genuinely
// out of scope. `enforceReadScope:false` (danger-full-access) disables BOTH read and write jails.

describe('LocalSandbox — write-scope jail is SECURE BY DEFAULT (darwin)', () => {
  darwinIt(
    'default jail: writes inside the workdir succeed but an out-of-scope sibling write EPERMs',
    async () => {
      // In-place at `work` with writeScope=[work]; `sibling` is OUTSIDE the workdir + writeScope. The
      // default posture must jail writes: a write under the workdir lands, a write to the sibling EPERMs
      // at the kernel (proving file-write* is the new boundary). This is the RED test: it FAILS today
      // because writes are wide open ((allow default) with only file-read* denied), so the sibling write
      // currently SUCCEEDS.
      const scratch = await homeScratch('write-jail');
      const work = path.join(scratch, 'work');
      const sibling = path.join(scratch, 'sibling');
      await fs.mkdir(work, { recursive: true });
      await fs.mkdir(sibling, { recursive: true });
      try {
        const sb = await LocalSandbox.create({
          readScope: [work],
          writeScope: [work],
          outputDir: 'out',
          workdir: work,
        });

        // In-scope write SUCCEEDS and the bytes land on disk under the workdir.
        const okWrite = await sb.exec(`printf '%s' IN_SCOPE_WRITE > ${JSON.stringify(path.join(work, 'made.txt'))}`);
        expect(okWrite.code).toBe(0);
        expect(await fs.readFile(path.join(work, 'made.txt'), 'utf8')).toBe('IN_SCOPE_WRITE');

        // Out-of-scope write FAILS with a KERNEL denial — not a profile parse error (`sandbox-exec:`),
        // and the file never appears on the host.
        const target = path.join(sibling, 'pwned.txt');
        const blocked = await sb.exec(`printf '%s' OUT_OF_SCOPE_WRITE > ${JSON.stringify(target)}`);
        expect(blocked.code).not.toBe(0);
        expect(blocked.stderr).not.toMatch(/^sandbox-exec:/m);
        expect(blocked.stderr).toMatch(/Operation not permitted|Permission denied/i);
        await expect(fs.access(target)).rejects.toThrow(); // the write never landed on the host
      } finally {
        await fs.rm(scratch, { recursive: true, force: true });
      }
    },
    20000,
  );

  darwinIt(
    'writes into a declared writeScope (owns) root OUTSIDE the workdir succeed',
    async () => {
      // owns can name a root that is NOT the workdir (a node writes a sibling output dir it declared in
      // its contract). writeScope=[ownsDir] (separate from workdir) must let writes land there, proving
      // the boundary is {workdir UNION writeScope}, not workdir-only.
      const scratch = await homeScratch('owns');
      const work = path.join(scratch, 'work');
      const ownsDir = path.join(scratch, 'owns');
      await fs.mkdir(work, { recursive: true });
      await fs.mkdir(ownsDir, { recursive: true });
      try {
        const sb = await LocalSandbox.create({
          readScope: [work],
          writeScope: [ownsDir], // a declared write root that is NOT the workdir
          outputDir: 'out',
          workdir: work,
        });
        const r = await sb.exec(`printf '%s' OWNS_WRITE > ${JSON.stringify(path.join(ownsDir, 'art.txt'))}`);
        expect(r.code).toBe(0);
        expect(await fs.readFile(path.join(ownsDir, 'art.txt'), 'utf8')).toBe('OWNS_WRITE');
      } finally {
        await fs.rm(scratch, { recursive: true, force: true });
      }
    },
    20000,
  );

  darwinIt(
    'NO read regression: with the write jail on, an out-of-scope READ still EPERMs',
    async () => {
      // Adding the write jail must NOT loosen the read jail. Same setup as the read test, but with a
      // writeScope present: the out-of-scope read of a sibling secret must STILL be denied (the deny
      // file-read* block is untouched). Guards against a refactor that accidentally regressed reads.
      const scratch = await homeScratch('noregress');
      const work = path.join(scratch, 'work');
      const denied = path.join(scratch, 'denied');
      await fs.mkdir(work, { recursive: true });
      await fs.mkdir(denied, { recursive: true });
      await fs.writeFile(path.join(denied, 'secret.txt'), 'STILL_SECRET');
      try {
        const sb = await LocalSandbox.create({
          readScope: [work],
          writeScope: [work],
          outputDir: 'out',
          workdir: work,
        });
        const blocked = await sb.exec(`cat ${JSON.stringify(path.join(denied, 'secret.txt'))}`);
        expect(blocked.code).not.toBe(0);
        expect(blocked.stdout).not.toContain('STILL_SECRET');
        expect(blocked.stderr).not.toMatch(/^sandbox-exec:/m);
        expect(blocked.stderr).toMatch(/Operation not permitted|Permission denied/i);
      } finally {
        await fs.rm(scratch, { recursive: true, force: true });
      }
    },
    20000,
  );

  darwinIt(
    'danger bypass (enforceReadScope:false): the SAME out-of-scope write SUCCEEDS (the hatch disables BOTH jails)',
    async () => {
      // The negative control for the write jail: flip the flag off and the identical out-of-scope write
      // must LAND — proving the write boundary is gated by the same posture, not hard-wired. If the
      // write jail were always-on this fails; its success proves the danger hatch disables reads AND writes.
      const scratch = await homeScratch('write-danger');
      const work = path.join(scratch, 'work');
      const sibling = path.join(scratch, 'sibling');
      await fs.mkdir(work, { recursive: true });
      await fs.mkdir(sibling, { recursive: true });
      try {
        const sb = await LocalSandbox.create(
          { readScope: [work], writeScope: [work], outputDir: 'out', workdir: work },
          { enforceReadScope: false },
        );
        const target = path.join(sibling, 'leaked.txt');
        const leak = await sb.exec(`printf '%s' BYPASS_WRITE_LEAK > ${JSON.stringify(target)}`);
        expect(leak.code).toBe(0);
        expect(await fs.readFile(target, 'utf8')).toBe('BYPASS_WRITE_LEAK');
      } finally {
        await fs.rm(scratch, { recursive: true, force: true });
      }
    },
    20000,
  );

  darwinIt(
    'TOOLCHAIN SANITY: node -e can still write to $TMPDIR under the jail (the jail did not break the toolchain)',
    async () => {
      // The whole bar: a too-tight write jail that EPERMs the toolchain's own scratch is WORSE than no
      // jail. `pi` is a node CLI; node + npm write transient state to $TMPDIR. Drive the real `node`
      // binary to write a temp file under os.tmpdir() (granted by the Codex-derived scratch set) — it
      // must SUCCEED with the SAME default-jail posture that EPERMs the sibling write above. If this
      // EPERMs, the writable scratch set is too tight and real `pi`/node runs would break.
      const scratch = await homeScratch('toolchain');
      const work = path.join(scratch, 'work');
      await fs.mkdir(work, { recursive: true });
      const tmpTarget = path.join(os.tmpdir(), `piflow-toolchain-sanity-${Date.now()}.txt`);
      try {
        const sb = await LocalSandbox.create({
          readScope: [work],
          writeScope: [work],
          outputDir: 'out',
          workdir: work,
        });
        // node writes to $TMPDIR via fs — the canonical toolchain scratch path that must NOT be jailed.
        const script = `require('fs').writeFileSync(process.argv[1], 'TOOLCHAIN_OK')`;
        const r = await sb.exec(
          `node -e ${JSON.stringify(script)} ${JSON.stringify(tmpTarget)}`,
        );
        expect(r.stderr).not.toMatch(/Operation not permitted|EPERM/i);
        expect(r.code).toBe(0);
        expect(await fs.readFile(tmpTarget, 'utf8')).toBe('TOOLCHAIN_OK');
      } finally {
        await fs.rm(tmpTarget, { force: true }).catch(() => {});
        await fs.rm(scratch, { recursive: true, force: true });
      }
    },
    20000,
  );

  darwinIt(
    'INHERITANCE: a bash child writing out-of-scope EPERMs (the write jail inherits to exec)',
    async () => {
      // The point of a kernel jail: it inherits to EVERY descendant. The exec already runs under `sh`,
      // but spawn a NESTED `bash -c 'echo > <out-of-scope>'` so the denied write happens in a GRANDCHILD,
      // not the top shell — proving a tool the agent shells out to is bounded too, not just the agent's
      // own redirects. The grandchild's write must EPERM and the file must never appear on the host.
      const scratch = await homeScratch('inherit');
      const work = path.join(scratch, 'work');
      const sibling = path.join(scratch, 'sibling');
      await fs.mkdir(work, { recursive: true });
      await fs.mkdir(sibling, { recursive: true });
      const target = path.join(sibling, 'child-pwned.txt');
      try {
        const sb = await LocalSandbox.create({
          readScope: [work],
          writeScope: [work],
          outputDir: 'out',
          workdir: work,
        });
        // A nested bash grandchild attempts the out-of-scope write.
        const inner = `echo CHILD_WRITE > ${JSON.stringify(target)}`;
        const r = await sb.exec(`bash -c ${JSON.stringify(inner)}`);
        expect(r.code).not.toBe(0);
        expect(r.stderr).not.toMatch(/^sandbox-exec:/m);
        expect(r.stderr).toMatch(/Operation not permitted|Permission denied/i);
        await expect(fs.access(target)).rejects.toThrow(); // grandchild write never landed
      } finally {
        await fs.rm(scratch, { recursive: true, force: true });
      }
    },
    20000,
  );
});

describe('LocalSandboxProvider — enforceReadScope posture (what the CLI flag selects)', () => {
  it('defaults to secure (enforceReadScope === true); the danger option turns it off', () => {
    // Platform-independent: the provider POLICY a CLI flag picks. `--sandbox local` → default (secure);
    // `--sandbox danger-full-access` → { enforceReadScope: false }.
    expect(new LocalSandboxProvider().enforceReadScope).toBe(true);
    expect(new LocalSandboxProvider({ enforceReadScope: false }).enforceReadScope).toBe(false);
  });
});

// ── 8. PER-NODE jail OVERRIDE: CreateOpts.enforceReadScope flows through the provider (fullAccess) ─────
//
// `fullAccess` is a per-NODE posture: a single node may opt OUT of the jail while the rest of the run stays
// jailed. The runner expresses this by passing `enforceReadScope:false` in that node's `CreateOpts`, which
// the provider must honor OVER its own run-level policy (per-node `false` wins; absent ⇒ inherit the
// provider). This is the seam the §5.3/§5.4 wiring depends on — without it a `fullAccess` node would still
// run jailed because the provider would ignore the override and apply only its own `this.enforceReadScope`.
describe('LocalSandboxProvider — per-node CreateOpts.enforceReadScope override (fullAccess)', () => {
  darwinIt(
    'a SECURE provider still UNJAILS the one node whose CreateOpts says enforceReadScope:false (per-node false wins)',
    async () => {
      // The load-bearing per-node assertion: the provider is secure-by-default (jail ON for the run), but a
      // single node's CreateOpts carries `enforceReadScope:false`. That node's exec must run BARE — the
      // identical out-of-scope read that EPERMs under the provider's default posture (asserted below) must
      // LEAK here. If `create` ignored the per-node flag and applied only `this.enforceReadScope`, the read
      // would be denied and this would fail — proving the override genuinely flows CreateOpts → exec.
      const scratch = await homeScratch('pernode-override');
      const work = path.join(scratch, 'work');
      const denied = path.join(scratch, 'denied');
      await fs.mkdir(work, { recursive: true });
      await fs.mkdir(denied, { recursive: true });
      await fs.writeFile(path.join(denied, 'secret.txt'), 'PERNODE_LEAK');
      try {
        const provider = new LocalSandboxProvider(); // secure by default (enforceReadScope === true)
        const sb = await provider.create({
          readScope: [work],
          writeScope: [work],
          outputDir: 'out',
          workdir: work,
          enforceReadScope: false, // the per-node fullAccess override
        });
        const leak = await sb.exec(`cat ${JSON.stringify(path.join(denied, 'secret.txt'))}`);
        expect(leak.code).toBe(0);
        expect(leak.stdout).toContain('PERNODE_LEAK');
      } finally {
        await fs.rm(scratch, { recursive: true, force: true });
      }
    },
    20000,
  );

  darwinIt(
    'ABSENT CreateOpts.enforceReadScope inherits the provider policy: a secure provider STILL jails the node',
    async () => {
      // The complement: when a node does NOT carry the override (the common case — every non-fullAccess
      // node), `create` must fall back to the provider's run-level policy. A secure provider therefore
      // STILL jails this node, so the identical out-of-scope read EPERMs. This proves the override is a
      // genuine `?? this.enforceReadScope` fallthrough, not a blanket `false`.
      const scratch = await homeScratch('pernode-inherit');
      const work = path.join(scratch, 'work');
      const denied = path.join(scratch, 'denied');
      await fs.mkdir(work, { recursive: true });
      await fs.mkdir(denied, { recursive: true });
      await fs.writeFile(path.join(denied, 'secret.txt'), 'STILL_JAILED');
      try {
        const provider = new LocalSandboxProvider(); // secure by default
        const sb = await provider.create({
          readScope: [work],
          writeScope: [work],
          outputDir: 'out',
          workdir: work,
          // NO enforceReadScope → inherit the provider's secure policy.
        });
        const blocked = await sb.exec(`cat ${JSON.stringify(path.join(denied, 'secret.txt'))}`);
        expect(blocked.code).not.toBe(0);
        expect(blocked.stdout).not.toContain('STILL_JAILED');
        expect(blocked.stderr).toMatch(/Operation not permitted|Permission denied/i);
      } finally {
        await fs.rm(scratch, { recursive: true, force: true });
      }
    },
    20000,
  );
});
