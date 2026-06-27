// Regression for the LIVE Daytona streaming-exec hang (feat/daytona-live).
//
// The real `getSessionCommandLogs(id, cmdId, onStdout, onStderr)` streaming overload follows a
// `?follow=true` log socket that the server closes only on SESSION TEARDOWN — it does NOT resolve when
// the runAsync command exits. The original `execSession` AWAITED it as the completion signal, so every
// live node hung (the runner always passes `onStdout` for stall detection → every node takes this path).
// The offline parity fake couldn't catch this: ITS streaming resolves on child-close.
//
// These tests pin the fix by driving the REAL `DaytonaSandboxProvider` against a fake whose streaming
// promise NEVER resolves until teardown — exactly the live shape. They prove completion now comes from
// POLLING `getSessionCommand` (not from awaiting the stream), while the background stream still delivers
// output in real time. A regression to the old `await stream` behavior HANGS → the per-test timeout fails.

import { describe, it, expect } from 'vitest';
import { DaytonaSandboxProvider } from '../src/daytona.js';

// A fake `sandbox.process` mimicking the live `?follow=true` socket: it fires a chunk in real time but
// its log promise RESOLVES only on deleteSession (teardown) — never on command exit. Completion is
// observable ONLY via getSessionCommand, whose exitCode flips undefined → `exitCode` after the first poll
// (the command "finishing"). So a correct execSession MUST learn completion by polling, not by awaiting.
class FollowSocketProcess {
  polls = 0;
  private resolveLogs?: () => void;
  constructor(private readonly exitCode: number, private readonly chunk = 'hi\n') {}

  async createSession(): Promise<void> {}
  async executeSessionCommand(): Promise<{ cmdId?: string }> {
    return { cmdId: 'c1' };
  }

  // Real-time chunk delivered BEFORE the command "finishes"; promise resolves only on teardown.
  getSessionCommandLogs(
    _sessionId: string,
    _cmdId: string,
    onStdout?: (c: string) => void,
    _onStderr?: (c: string) => void,
  ): Promise<void> {
    onStdout?.(this.chunk);
    return new Promise<void>((resolve) => {
      this.resolveLogs = resolve;
    });
  }

  // The only completion signal: undefined while "running", then the real code once "finished".
  async getSessionCommand(): Promise<{ exitCode?: number }> {
    this.polls += 1;
    return { exitCode: this.polls >= 2 ? this.exitCode : undefined };
  }

  async deleteSession(): Promise<void> {
    this.resolveLogs?.(); // socket closes on teardown
  }

  // Present so the fake structurally matches the seam; the streaming path never calls it.
  async executeCommand(): Promise<{ exitCode: number; result: string }> {
    return { exitCode: 0, result: '' };
  }
}

class FollowSocketVm {
  readonly id = 'vm-follow';
  // No-op fs: the streaming exec path only touches process; create()'s mkdir is harmless.
  readonly fs = {
    async uploadFile(): Promise<void> {},
    async downloadFile(): Promise<Uint8Array> {
      return new Uint8Array();
    },
    async createFolder(): Promise<void> {},
    async searchFiles(): Promise<{ files: string[] }> {
      return { files: [] };
    },
  };
  constructor(readonly process: FollowSocketProcess) {}
}

class FollowSocketSdk {
  constructor(private readonly process: FollowSocketProcess) {}
  async create(): Promise<FollowSocketVm> {
    return new FollowSocketVm(this.process);
  }
  async delete(): Promise<void> {}
}

async function execViaStreaming(
  exitCode: number,
): Promise<{ proc: FollowSocketProcess; chunks: string[]; result: { stdout: string; stderr: string; code: number } }> {
  const proc = new FollowSocketProcess(exitCode);
  const provider = new DaytonaSandboxProvider(new FollowSocketSdk(proc), { homeDir: '/home/daytona' });
  const sandbox = await provider.create({ readScope: [], outputDir: 'out', workdir: 'work' });
  const chunks: string[] = [];
  // Passing onStdout forces the SESSION (streaming) path — the one that hung live.
  const result = await sandbox.exec('echo hi', { onStdout: (c) => chunks.push(c) });
  return { proc, chunks, result };
}

describe('DaytonaSandbox.execSession — live follow-socket completion (regression)', () => {
  it('resolves via getSessionCommand poll when the log socket never closes on command exit', async () => {
    const { proc, chunks, result } = await execViaStreaming(0);
    expect(result.code).toBe(0); // completion learned by POLL, not by awaiting the never-closing stream
    expect(result.stdout).toBe('hi\n'); // the background stream still captured the bytes
    expect(chunks).toEqual(['hi\n']); // ...and forwarded them to the caller in real time
    expect(proc.polls).toBeGreaterThanOrEqual(2); // it actually polled for completion
  }, 5000); // a regression to the old `await stream` behavior HANGS → this timeout fails the test

  it('surfaces the polled nonzero exit code', async () => {
    const { result } = await execViaStreaming(3);
    expect(result.code).toBe(3);
  }, 5000);
});
