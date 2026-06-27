// M1b — staging the pi PROVIDER CONFIG (~/.pi/agent/models.json) into the cloud VM.
//
// Design: docs/design/credential-architecture.md §4 + docs/design/daytona-cloud-integration.md. M1 forwards
// the provider KEY into the VM; but a CUSTOM gateway (nebius/mmgw/…) is DEFINED only in the host's
// ~/.pi/agent/models.json (baseUrl/api/models — pi's official `docs/models.md` shape), which the M0 image
// bakes NONE of, so pi in the VM cannot resolve `--provider <gw>` without it. `DaytonaSandboxProvider`'s
// `stageHome` writes that config into the VM home BEFORE any node. The staged config carries `$VAR` apiKey
// REFERENCES, never a literal secret (the key crosses via the runner's cloud cred allowlist, M1).
//
// The fake VM's fs writes to a REAL host temp dir (homeDir = that dir), so a staged in-VM absolute path IS a
// real host path we read back — the same faithful-fs trick as sandbox-cloud-parity.test.ts.

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaytonaSandboxProvider } from '../src/sandbox/daytona.js';

class FakeFs {
  async uploadFile(data: Uint8Array, remotePath: string): Promise<void> {
    await fs.mkdir(path.dirname(remotePath), { recursive: true });
    await fs.writeFile(remotePath, data);
  }
  async createFolder(remotePath: string): Promise<void> {
    await fs.mkdir(remotePath, { recursive: true });
  }
  async downloadFile(p: string): Promise<Uint8Array> {
    return fs.readFile(p);
  }
  async searchFiles(): Promise<{ files: string[] }> {
    return { files: [] };
  }
}
class FakeVm {
  id = 'vm-1';
  fs = new FakeFs();
  process = {} as never;
}
class FakeSdk {
  async create(): Promise<FakeVm> {
    return new FakeVm();
  }
  async delete(): Promise<void> {}
}

// A fake that RECORDS the create params, so a test can assert which boot field (snapshot vs image) the
// provider forwarded.
class RecordingSdk {
  lastCreate?: { snapshot?: string; image?: string };
  async create(params?: { snapshot?: string; image?: string }): Promise<FakeVm> {
    this.lastCreate = { snapshot: params?.snapshot, image: params?.image };
    return new FakeVm();
  }
  async delete(): Promise<void> {}
}

async function tmp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `piflow-${prefix}-`));
}

// The OFFICIAL custom-gateway shape (pi docs/models.md), apiKey as a $VAR ref — NOT a literal.
const MODELS = JSON.stringify({
  providers: {
    nebius: {
      baseUrl: 'https://api.tokenfactory.nebius.com/v1',
      api: 'openai-completions',
      apiKey: '$NEBIUS_API_KEY',
      models: [{ id: 'qwen', name: 'Qwen', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    },
  },
});

describe('DaytonaSandboxProvider — M1b stageHome (the custom-gateway models.json into the VM)', () => {
  it('openRun stages each file at <home>/<relPath> before any node, with the $VAR ref intact (no literal secret)', async () => {
    const home = await tmp('vm-home');
    try {
      const provider = new DaytonaSandboxProvider(new FakeSdk() as never, {
        homeDir: home,
        stageHome: { '.pi/agent/models.json': MODELS },
      });
      await provider.openRun({ run: 'r1', repoRoot: home, outDir: home });

      const staged = await fs.readFile(path.join(home, '.pi', 'agent', 'models.json'), 'utf8');
      const cfg = JSON.parse(staged) as { providers: Record<string, { baseUrl: string; apiKey: string }> };
      // the custom gateway's CONFIG reached the VM (so pi can resolve --provider nebius there)...
      expect(cfg.providers.nebius.baseUrl).toBe('https://api.tokenfactory.nebius.com/v1');
      // ...and the apiKey is the $VAR REFERENCE, never a resolved literal (the key crosses via the cred allowlist).
      expect(cfg.providers.nebius.apiKey).toBe('$NEBIUS_API_KEY');
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('no stageHome ⇒ NO file written (a built-in provider needs no config staged)', async () => {
    const home = await tmp('vm-home');
    try {
      const provider = new DaytonaSandboxProvider(new FakeSdk() as never, { homeDir: home });
      await provider.openRun({ run: 'r2', repoRoot: home, outDir: home });
      await expect(fs.readFile(path.join(home, '.pi', 'agent', 'models.json'), 'utf8')).rejects.toThrow();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('the throwaway create() path stages too (parity with openRun)', async () => {
    const home = await tmp('vm-home');
    try {
      const provider = new DaytonaSandboxProvider(new FakeSdk() as never, {
        homeDir: home,
        stageHome: { '.pi/agent/models.json': MODELS },
      });
      await provider.create({ readScope: [], outputDir: 'out', workdir: 'solo' });
      const staged = await fs.readFile(path.join(home, '.pi', 'agent', 'models.json'), 'utf8');
      expect((JSON.parse(staged) as { providers: Record<string, unknown> }).providers.nebius).toBeDefined();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describe('DaytonaSandboxProvider — M1c boot from a SNAPSHOT (vs a raw image ref)', () => {
  it('openRun forwards the configured snapshot and does NOT stuff its name into the image field', async () => {
    const home = await tmp('vm-home');
    const sdk = new RecordingSdk();
    try {
      const provider = new DaytonaSandboxProvider(sdk as never, { homeDir: home, snapshot: 'piflow-node-runtime-0.80.2' });
      await provider.openRun({ run: 'r1', repoRoot: home, outDir: home });
      // booted FROM the snapshot — a snapshot name is not an image ref, so `image` must stay undefined.
      expect(sdk.lastCreate?.snapshot).toBe('piflow-node-runtime-0.80.2');
      expect(sdk.lastCreate?.image).toBeUndefined();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('falls back to a raw image ref when no snapshot is set', async () => {
    const home = await tmp('vm-home');
    const sdk = new RecordingSdk();
    try {
      const provider = new DaytonaSandboxProvider(sdk as never, { homeDir: home, image: 'ghcr.io/acme/pi:1' });
      await provider.openRun({ run: 'r2', repoRoot: home, outDir: home });
      expect(sdk.lastCreate?.image).toBe('ghcr.io/acme/pi:1');
      expect(sdk.lastCreate?.snapshot).toBeUndefined();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
