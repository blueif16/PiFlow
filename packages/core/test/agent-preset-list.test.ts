// listAgentPresets — the catalog ENUMERATION the server used to inline (readdir + loadAgentPreset per .md).
// Contract: every parseable `.md` preset is returned; non-.md files are skipped; a MALFORMED preset file
// never sinks the whole listing (skipped, with an error note naming the file); a missing catalog dir ⇒
// an empty listing (mirrors loadAgentPreset's never-throw READ-ONLY posture).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listAgentPresets } from '../src/workflow/agent-preset.js';

let DIR: string;
beforeEach(async () => {
  DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-agents-'));
});
afterEach(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
});

const preset = (id: string): string => `---\nid: ${id}\ndisplay:\n  label: ${id}\n---\nRole prompt for ${id}.\n`;

describe('listAgentPresets — enumerate the preset catalog dir', () => {
  it('returns every .md preset and skips non-.md files', async () => {
    await fs.writeFile(path.join(DIR, 'researcher.md'), preset('researcher'));
    await fs.writeFile(path.join(DIR, 'coder.md'), preset('coder'));
    await fs.writeFile(path.join(DIR, 'notes.txt'), 'not a preset');

    const { presets, errors } = listAgentPresets(DIR);
    expect(presets.map((p) => p.id).sort()).toEqual(['coder', 'researcher']);
    expect(errors).toEqual([]);
  });

  it('a MALFORMED preset file is skipped with an error note — the valid ones still list', async () => {
    await fs.writeFile(path.join(DIR, 'good.md'), preset('good'));
    await fs.writeFile(path.join(DIR, 'broken.md'), 'no frontmatter here at all\n');

    const { presets, errors } = listAgentPresets(DIR);
    expect(presets.map((p) => p.id)).toEqual(['good']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('broken.md');
  });

  it('a missing catalog dir ⇒ an empty listing, never a throw', async () => {
    const { presets, errors } = listAgentPresets(path.join(DIR, 'no-such-dir'));
    expect(presets).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('defaults to defaultAgentsDir() (PIFLOW_HOME-honoring) when no dir is given', async () => {
    const saved = process.env.PIFLOW_HOME;
    process.env.PIFLOW_HOME = DIR; // hermetic: defaultAgentsDir() = <DIR>/agents (never the real home)
    try {
      await fs.mkdir(path.join(DIR, 'agents'), { recursive: true });
      await fs.writeFile(path.join(DIR, 'agents', 'solo.md'), preset('solo'));
      const { presets } = listAgentPresets();
      expect(presets.map((p) => p.id)).toEqual(['solo']);
    } finally {
      if (saved === undefined) delete process.env.PIFLOW_HOME;
      else process.env.PIFLOW_HOME = saved;
    }
  });
});
