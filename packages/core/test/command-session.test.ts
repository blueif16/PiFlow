// defaultPiCommand — per-node SESSION flag emission (PURE LOGIC gate, test-discipline §0).
//
// Warm-resume foundation (docs/research/2026-06-28-warm-resume-pi-surfaces.md §4a): the command builder
// threads an OPTIONAL `opts.session = { dir, id, resume? }`. Mutually exclusive with `--no-session`:
//   - NO session opts        → keep `--no-session` (today's ephemeral default, backward-compatible).
//   - session, create (1st)  → `--session-dir <dir> --session-id <id>`, NO `--no-session`.
//   - session, resume        → `--session-dir <dir> --session <id>`     , NO `--no-session`, NO `--session-id`.
//
// These FAIL before the wiring (the builder always emits `--no-session` and never reads `opts.session`).

import { describe, it, expect } from 'vitest';
import { defaultPiCommand } from '../src/runner/command.js';
import type { NodeSpec, ResolveResult } from '../src/types.js';

// defaultPiCommand reads only ctx/resolved/opts (never `node`), so a bare stub is enough.
const node = {} as NodeSpec;
const resolved: ResolveResult = { piTools: ['read'] };
const ctx = { promptFile: 'p.md' };

describe('defaultPiCommand — session flag emission', () => {
  it('NO session opts → keeps --no-session and emits no --session* / --session-dir (back-compat)', () => {
    const cmd = defaultPiCommand(node, resolved, ctx);
    expect(cmd).toContain('--no-session');
    expect(cmd).not.toContain('--session-dir');
    expect(cmd).not.toMatch(/--session(-id)?\b/);
  });

  it('create-session opts → emits --session-dir <dir> + --session-id <id>, drops --no-session', () => {
    const cmd = defaultPiCommand(node, resolved, ctx, {
      session: { dir: '/run/.pi-sessions', id: 'producer' },
    });
    expect(cmd).toContain("--session-dir '/run/.pi-sessions'");
    expect(cmd).toContain("--session-id 'producer'");
    // create path must NOT use the resume flag …
    expect(cmd).not.toMatch(/--session '/);
    // … and must NOT be ephemeral.
    expect(cmd).not.toContain('--no-session');
  });

  it('resume-session opts → emits --session-dir <dir> + --session <id> (NOT --session-id), drops --no-session', () => {
    const cmd = defaultPiCommand(node, resolved, ctx, {
      session: { dir: '/run/.pi-sessions', id: 'producer', resume: true },
    });
    expect(cmd).toContain("--session-dir '/run/.pi-sessions'");
    expect(cmd).toContain("--session 'producer'");
    // the resume flag is `--session`, NEVER the create-flag `--session-id`.
    expect(cmd).not.toContain('--session-id');
    expect(cmd).not.toContain('--no-session');
  });

  it('resume with a resumeRef → emits --session <resumeRef path> (the RESOLVABLE ref), NOT the bare id', () => {
    // THE WRITE-PATH FIX (run 260715-02/plan). pi resolves `--session <bare-id>` against a custom
    // `--session-dir` by SCANNING; finding the session in a foreign project dir it classifies it a "different
    // project" and prompts to fork — a prompt a headless `pi -p` cannot answer, so the warm attempt no-ops and
    // starves events.jsonl. A FULL PATH hits pi's direct-path branch and opens the exact file. So when the
    // runner has LOCATED the session file, the resume MUST address it by that path, not the bare id.
    const ref = '/run/.pi/sessions/2026-07-15T21-14-54-714Z_producer.jsonl';
    const cmd = defaultPiCommand(node, resolved, ctx, {
      session: { dir: '/run/.pi/sessions', id: 'producer', resume: true, resumeRef: ref },
    });
    expect(cmd).toContain(`--session '${ref}'`);
    // the bare id must NOT be the --session argument (that is exactly what pi cannot resolve here).
    expect(cmd).not.toContain("--session 'producer'");
    expect(cmd).not.toContain('--session-id');
    expect(cmd).not.toContain('--no-session');
  });

  it('create with a (stray) resumeRef → still --session-id <id> (resumeRef is resume-only)', () => {
    // resumeRef only steers the RESUME arm; a create attempt always mints by id (a path would fail pi's
    // assertValidSessionId). Guards against the builder leaking the ref onto the create flag.
    const cmd = defaultPiCommand(node, resolved, ctx, {
      session: { dir: '/run/.pi/sessions', id: 'producer', resumeRef: '/some/path_producer.jsonl' },
    });
    expect(cmd).toContain("--session-id 'producer'");
    expect(cmd).not.toContain('/some/path_producer.jsonl');
  });
});
