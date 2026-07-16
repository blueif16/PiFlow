// pi-session.ts — `supersedeStaleSession` (PURE fs logic gate, test-discipline §0).
//
// ROOT-CAUSE (fix/rerun-fresh-session): pi's own `--session-id <id>` is GET-OR-CREATE, not create-only —
// `@earendil-works/pi-coding-agent` dist/main.js `createSessionManager` calls `findLocalSessionByExactId`
// first and `SessionManager.open`s a match rather than minting fresh (dist/cli/args.js:236 documents this
// as "Use exact project session ID, creating it if missing"). So a COLD attempt (a `--rerun`, a cold retry,
// an escalation) that re-emits `--session-id <nodeId>` under the SAME session dir a prior attempt already
// used silently RE-OPENS that prior file instead of starting fresh. `supersedeStaleSession` is the fix's
// primitive: archive any EXISTING file matching the id ASIDE (rename, never delete — the read-path recovery
// in this module + a human still need the history) so pi's own get-or-create lookup finds nothing and truly
// creates a new file.

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { locatePiSessionFile, supersedeStaleSession } from '../src/runner/pi-session.js';

const tmpDir = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'piflow-pi-session-'));

describe('supersedeStaleSession', () => {
  it('archives an EXISTING session file aside (renamed, not deleted) so it no longer matches the id suffix', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, '2026-07-16T06-46-48-983Z_producer.jsonl');
    const content = '{"type":"session","version":3,"id":"producer"}\n{"type":"message","message":{"role":"assistant","content":[]}}\n';
    await fs.writeFile(file, content);

    const archived = supersedeStaleSession(dir, 'producer');

    expect(archived, 'must return the archived path').toBeTruthy();
    // The original path is GONE (so pi's own --session-id lookup, and locatePiSessionFile, find nothing).
    await expect(fs.access(file)).rejects.toThrow();
    // …but the content SURVIVES intact under the archived name (superseded, never deleted).
    const archivedContent = await fs.readFile(archived as string, 'utf8');
    expect(archivedContent).toBe(content);
    // The archived name no longer ends with the `_<id>.jsonl` suffix locatePiSessionFile scans for.
    expect(locatePiSessionFile(dir, 'producer')).toBeNull();

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is a no-op (returns null) when no session file exists for this id — the common first-ever-attempt case', async () => {
    const dir = await tmpDir();
    // dir exists but is empty — nothing to archive.
    await fs.mkdir(dir, { recursive: true });

    expect(supersedeStaleSession(dir, 'producer')).toBeNull();

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is a no-op (returns null) when the session dir itself does not exist', () => {
    expect(supersedeStaleSession('/nonexistent/piflow-pi-session-dir-xyz', 'producer')).toBeNull();
  });

  it('only archives the file matching THIS id — a sibling node\'s session is untouched', async () => {
    const dir = await tmpDir();
    const mine = path.join(dir, '2026-07-16T06-46-48-983Z_producer.jsonl');
    const sibling = path.join(dir, '2026-07-16T06-46-48-983Z_reviewer.jsonl');
    await fs.writeFile(mine, 'mine');
    await fs.writeFile(sibling, 'sibling');

    supersedeStaleSession(dir, 'producer');

    await expect(fs.access(mine)).rejects.toThrow();
    // the sibling's file is untouched — same original path, same content.
    expect(await fs.readFile(sibling, 'utf8')).toBe('sibling');

    await fs.rm(dir, { recursive: true, force: true });
  });
});
