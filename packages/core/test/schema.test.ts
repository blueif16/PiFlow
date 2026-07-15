import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compile, persistState, validateArtifactSchemas, defaultSchemaValidator } from '../src/index.js';
import type { NodeIntent, NodeSpec, WorkflowSpec } from '../src/index.js';
import { runWorkflow } from '../src/runner/index.js';

// ── The post-node artifact SCHEMA gate — two diagnosed gaps against `run.mjs schemaCheck` parity ──────
// (1) a `contract.schema` value carrying a `{{...}}` token (the same vocabulary `path`/`owns`/`readScope`
//     already resolve — `resolveAll`'s own doc comment lists `schema` among the marker lists it covers)
//     was NEVER run through `resolveTokens` at either launch site (node-lifecycle.ts / node-lanes.ts), so
//     a per-state-branch schema path reached the gate literally, as `{{state.x}}/…`, and never resolved
//     to a real file — the gate degraded to "schema unreadable" and silently skipped.
// (2) a base+overlay schema pair (an overlay that `$ref`s a shared base via a RELATIVE FILE path) makes
//     `ajv.compile()` throw an uncaught `MissingRefError` — the gate had no try/catch around the compile,
//     so a legitimate multi-file schema set crashed the run instead of gracefully skipping or validating.

function n(label: string, reads: string[], produces: string[], over: Partial<NodeIntent> = {}): NodeIntent {
  return {
    label,
    prompt: `do ${label}`,
    tools: {},
    io: { reads, produces, artifacts: produces.map((p) => ({ path: p })) },
    ...over,
  };
}
const wf = (nodes: NodeIntent[]): WorkflowSpec => ({ meta: { name: 't', description: 'd' }, nodes });
const tmpOut = (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), 'piflow-schemagate-'));

describe('validateArtifactSchemas — multi-file $ref (base + overlay) schemas', () => {
  it('an overlay schema that $refs a shared base FILE compiles and catches a real violation (not a MissingRefError crash)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-schema-ref-'));
    try {
      // base defines a reusable $def; the overlay $refs it by a RELATIVE FILE path (the split-schema shape
      // game-omni's per-archetype blueprint schema uses: an overlay $ref-ing a shared base).
      await fs.writeFile(
        path.join(dir, 'base.schema.json'),
        JSON.stringify({
          $id: 'base.schema.json',
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          $defs: { positive: { type: 'number', minimum: 0 } },
        }),
      );
      await fs.writeFile(
        path.join(dir, 'overlay.schema.json'),
        JSON.stringify({
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          properties: { hp: { $ref: 'base.schema.json#/$defs/positive' } },
          required: ['hp'],
        }),
      );
      // hp:-1 violates the BASE schema's minimum:0 (transitively, through the overlay's $ref) — a real,
      // detectable breach, not a config error.
      await fs.writeFile(path.join(dir, 'data.json'), JSON.stringify({ hp: -1 }));

      const validate = await defaultSchemaValidator();
      expect(validate).not.toBeNull(); // ajv-2020 must resolve for this assertion to be meaningful

      const result = await validateArtifactSchemas([{ path: 'data.json', schema: 'overlay.schema.json' }], {
        outDir: dir,
        roots: [dir],
        validate,
      });

      expect(result.skipped).toBeNull();
      expect(result.invalid.length).toBe(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('validateArtifactSchemas — mixed-dialect (draft-07 overlay → draft-2020-12 base) chain', () => {
  // REGRESSION (run 260714-02): the default validator is an `ajv/dist/2020.js` build that bundles ONLY the
  // draft-2020-12 meta, so an OVERLAY schema that DECLARES `$schema: ".../draft-07/schema#"` (which game-omni's
  // per-archetype blueprint overlays do — e.g. templates/modules/platformer/blueprint.schema.json — while their
  // shared base declares draft-2020-12) made `ajv.compile()` throw `no schema with key or ref
  // "http://json-schema.org/draft-07/schema#"`, so the gate SKIPPED on EVERY game-omni run. The fix registers
  // the draft-07 meta alongside 2020-12 so the ONE compiler accepts BOTH dialects the chain declares.
  it('a draft-07 overlay $ref-ing a draft-2020-12 base COMPILES and catches a real violation (no dialect skip/throw)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-schema-dialect-'));
    try {
      // base: draft-2020-12 (the real blueprint.base.schema.json dialect).
      await fs.writeFile(
        path.join(dir, 'base.schema.json'),
        JSON.stringify({
          $id: 'base.schema.json',
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          $defs: { positive: { type: 'number', minimum: 0 } },
        }),
      );
      // overlay: draft-07 (the real per-archetype blueprint.schema.json dialect), $ref-ing the 2020-12 base.
      await fs.writeFile(
        path.join(dir, 'overlay.schema.json'),
        JSON.stringify({
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          properties: { hp: { $ref: 'base.schema.json#/$defs/positive' } },
          required: ['hp'],
        }),
      );
      // hp:-1 violates the base's minimum:0 through the overlay's $ref — a real, detectable breach.
      await fs.writeFile(path.join(dir, 'data.json'), JSON.stringify({ hp: -1 }));

      const validate = await defaultSchemaValidator();
      expect(validate).not.toBeNull();

      const result = await validateArtifactSchemas([{ path: 'data.json', schema: 'overlay.schema.json' }], {
        outDir: dir,
        roots: [dir],
        validate,
      });

      // Pre-fix: `skipped` carried the draft-07 dialect throw and `checked` was decremented to 0 (never validated).
      expect(result.skipped).toBeNull();
      expect(result.checked).toBe(1);
      expect(result.invalid.length).toBe(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('a valid instance against the SAME draft-07→2020-12 chain passes clean', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piflow-schema-dialect-ok-'));
    try {
      await fs.writeFile(
        path.join(dir, 'base.schema.json'),
        JSON.stringify({
          $id: 'base.schema.json',
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          $defs: { positive: { type: 'number', minimum: 0 } },
        }),
      );
      await fs.writeFile(
        path.join(dir, 'overlay.schema.json'),
        JSON.stringify({
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          properties: { hp: { $ref: 'base.schema.json#/$defs/positive' } },
          required: ['hp'],
        }),
      );
      await fs.writeFile(path.join(dir, 'data.json'), JSON.stringify({ hp: 42 }));

      const validate = await defaultSchemaValidator();
      const result = await validateArtifactSchemas([{ path: 'data.json', schema: 'overlay.schema.json' }], {
        outDir: dir,
        roots: [dir],
        validate,
      });
      expect(result.skipped).toBeNull();
      expect(result.checked).toBe(1);
      expect(result.invalid.length).toBe(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('artifact-resolution map — a {{state.*}}-tokened contract `schema` path', () => {
  it('resolves through the SAME map that resolves `path` (the launch-time clone carries no raw {{ )', async () => {
    const outDir = await tmpOut();
    try {
      await persistState(outDir, { archetype: 'rpg' });

      const node = n('Solo', [], ['out.json'], {
        io: {
          reads: [],
          produces: ['out.json'],
          artifacts: [{ path: 'out.json', schema: 'schemas/{{state.archetype}}/schema.json' }],
        },
      });
      const g = compile(wf([node]));

      let captured: NodeSpec | undefined;
      await runWorkflow(g, {
        run: 'schema-token',
        outDir,
        buildCommand: (resolvedNode) => {
          captured = resolvedNode;
          return 'true';
        },
      });

      expect(captured).toBeDefined();
      expect(captured!.io.artifacts[0].schema).not.toContain('{{');
      expect(captured!.io.artifacts[0].schema).toBe('schemas/rpg/schema.json');
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  });
});
