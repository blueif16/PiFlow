import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  piDir,
  stateFile,
  runJsonFile,
  nodeDir,
  nodeIoFile,
  nodePromptFile,
  nodeToolsFile,
  nodeMcpFile,
  nodeEventsFile,
  writeNodeIo,
} from '../src/index.js';
import type { NodeIo } from '../src/index.js';

const RUN = '/runs/abc';

describe('layout path helpers (pure joins, no I/O)', () => {
  it('roots the .pi/ namespace under the opaque run dir', () => {
    expect(piDir(RUN)).toBe('/runs/abc/.pi');
    expect(stateFile(RUN)).toBe('/runs/abc/.pi/state.json');
    expect(runJsonFile(RUN)).toBe('/runs/abc/.pi/run.json');
  });

  it('homes each node under .pi/nodes/<id>/ with the canonical filenames', () => {
    expect(nodeDir(RUN, 'w1')).toBe('/runs/abc/.pi/nodes/w1');
    expect(nodeIoFile(RUN, 'w1')).toBe('/runs/abc/.pi/nodes/w1/io.json');
    expect(nodePromptFile(RUN, 'w1')).toBe('/runs/abc/.pi/nodes/w1/prompt.md');
    expect(nodeToolsFile(RUN, 'w1')).toBe('/runs/abc/.pi/nodes/w1/tools.ts');
    expect(nodeMcpFile(RUN, 'w1')).toBe('/runs/abc/.pi/nodes/w1/mcp.json');
    expect(nodeEventsFile(RUN, 'w1')).toBe('/runs/abc/.pi/nodes/w1/events.jsonl');
  });

  it('does NOT hardcode the .piflow/<wf>/runs convention — the base is opaque', () => {
    // Core treats `run` as any base dir; a totally different root must still join cleanly.
    expect(nodeIoFile('/tmp/x', 'n')).toBe('/tmp/x/.pi/nodes/n/io.json');
  });
});

describe('writeNodeIo', () => {
  it('mkdir -p the node dir and writes a readable io.json with the record', async () => {
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-layout-'));
    try {
      const record: NodeIo = {
        id: 'w1',
        label: 'Design',
        phase: 'design',
        reads: [{ path: 'spec/classification.json', via: 'state' }],
        writes: [{ path: 'spec/gdd.md', verified: true, bytes: 42 }],
        promotes: [{ to: 'archetype', merge: 'set', value: 'platformer' }],
        status: 'ok',
        startedAt: '2026-06-23T00:00:00.000Z',
        endedAt: '2026-06-23T00:00:01.000Z',
        durationMs: 1000,
      };
      const written = await writeNodeIo(base, record);
      expect(written).toBe(nodeIoFile(base, 'w1'));
      const back = JSON.parse(await fs.readFile(nodeIoFile(base, 'w1'), 'utf8')) as NodeIo;
      expect(back).toEqual(record);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});
