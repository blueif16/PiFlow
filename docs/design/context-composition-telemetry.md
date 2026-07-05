# Context-composition telemetry (the "element tree")

**Goal.** For any node run, reconstruct *exactly what reached the model* as one ordered, honest
record — the **force-injected** context (the staged `prompt.md`) and the **agent-read** context
(every `read`/`grep`) unified, each with file · line-range · **coverage** · version(sha) · order —
plus the **blind-spot** signal (files the prompt named but the agent never read). This is the
instrument that lets us edit a file (e.g. `design-rules.md`) and *measure* the variant's effect.

**It is a PROJECTION, not new collection** — with ONE tiny exception (the sha emit, below). All the
range data already exists uncapped in `events.jsonl`; the injected leg is `prompt.md` on disk.
Compute ONCE in `@piflow/core/observe` (our law: data logic in observe, never a view; every surface
projects and re-derives nothing).

**Naming aligns to OTel GenAI semconv where a canonical name exists** (`gen_ai.tool.call.id`,
`code.file.path`); range/coverage are our extension (no standard has them — every serious agent tool
invents the same set: path + range + total-size + coverage + call_id + bounded-content-or-hash).

---

## THE ANTI-FOOTGUN (the whole reason this exists)
`events.jsonl` caps a `tool_execution_end.result` preview at **2048 chars** (`events.ts:27`
`MAX_RESULT`). That `"truncated": true` is a **logging artifact** — the model received the FULL
content (proven: the sibling `turn_end` event carries the untruncated result). NEVER surface that
flag as "the model didn't get it." Read-level "partial" MUST come from **coverage math** (read
ranges ÷ file-on-disk), NOT from the log-preview cap. A `context` op carries `logPreviewCapped` as a
cosmetic note ONLY, kept strictly separate from `covered`.

## pi read semantics (grounds coverage)
pi's `read` returns up to **~2000 lines / 50 KB per call**, pageable via `args.offset`/`args.limit`
(line-based, present on the `tool_execution_start` event, NOT subject to the 2048 cap). Therefore a
single no-offset read of a file **≤ 2000 lines AND ≤ 50 KB → FULL coverage**. `design-rules.md`
(27 KB / ~600 lines) is under the cap → one read = whole file. Coverage math earns its keep on
genuinely large files; for this node the dominant signal is `advertisedUnread`.

---

## Types (`packages/core/src/observe/contextComposition.ts`)

```ts
export interface ContextOp {
  seq: number;                 // chronological index across the node run (0-based)
  tMs: number | null;          // ms since node start (event _t)
  op: 'inject' | 'read' | 'grep' | 'edit' | 'write' | 'list' | 'bash';
  toolCallId: string | null;   // gen_ai.tool.call.id; null for 'inject'
  path: string;                // absolute (inject → the staged prompt.md path)
  displayPath: string;         // via makeDisplayPath
  scope: ScopeKind;            // run|skill|template|package|repo (reuse scopeKind); inject → 'run'
  range: { offset: number; limit: number } | null;  // line-based; null = whole-file / no args
  fileLines: number | null;    // total lines on disk at build time (or from manifest)
  fileBytes: number | null;    // total bytes
  returnedBytes: number | null; // best-effort actual bytes delivered (turn_end if available; else null)
  coverage: number | null;     // 0..1 union(read ranges)/fileLines ; inject = 1 ; null = unknown
  covered: 'full' | 'partial' | 'unknown';
  sha256: string | null;       // file content hash at RUN time (from reads-manifest; else build-time file)
  logPreviewCapped: boolean;   // cosmetic: the events.jsonl 2048 preview was capped — NOT a model truncation
  preview?: string;            // bounded plaintext (reuse existing PREVIEW_CAP); opt-in
  ok: boolean;
  errorType?: string;
}

export interface NodeComposition {
  injectedBytes: number;       // staged prompt.md size
  readFiles: number;           // distinct files read
  advertised: string[];        // display paths the injected prompt + DRIVER-* markers NAME
  advertisedUnread: string[];  // advertised but 0 reads  ← THE blind-spot
  partialReads: string[];      // files with coverage < 1 (model saw only a slice)
}

export interface NodeContext { context: ContextOp[]; composition: NodeComposition }
```

### Builder
`export function buildNodeContext(runDir: string, nodeId: string, ctx: ContextBuildCtx): NodeContext`
- Reads `.pi/nodes/<id>/events.jsonl` line-by-line **preserving order** (do NOT reuse the distill
  accumulator — it dedups reads first-seen; this needs every op in order). One `ContextOp` per
  `tool_execution_start` (pair with its `tool_execution_end` by `toolCallId` for `ok`/`returnedBytes`/
  `logPreviewCapped`). Prepend one `op:'inject'` for the staged `prompt.md`.
- `range` from `args.offset`/`args.limit` when present.
- File size/version: prefer `.pi/nodes/<id>/reads-manifest.json` (run-time sha/bytes/lines); fall
  back to stat+read the current on-disk file and set a `stale` note if the manifest is absent.
- **Coverage rule:** per distinct read path, union the covered line-ranges (`[offset, offset+limit)`;
  a no-offset read covers `[0, min(fileLines, 2000))`). `coverage = coveredLines / fileLines`.
  `covered='full'` iff coverage ≥ 0.999 (and for a no-offset read of a ≤2000-line/≤50KB file → full).
- **advertised:** extract path-like tokens from the injected prompt text + the `DRIVER-ARTIFACTS`/
  `DRIVER-READ-SCOPE` marker paths (product-agnostic: tokens containing `/` or ending in a file
  extension; basenames too). `advertisedUnread` = advertised whose basename matches no read op path.
- `ctx` supplies `displayPath`, `scopeOf`, `promptText` (read `.pi/nodes/<id>/prompt.md`), and the
  manifest. Reuse `makeDisplayPath`/`scopeKind` from `runView.ts`.

## Wiring (`packages/core/src/observe/runView.ts`)
- Add optional `context?: ContextOp[]` and `composition?: NodeComposition` to `RunViewNode`.
- In `buildRunView`'s per-node loop, call `buildNodeContext(runDir, id, ...)` and attach. Keep it
  ADDITIVE — do not perturb the parity-critical `assembleNode`/shadow-diff field set semantics
  (new optional fields only). It reads events.jsonl a second time (post-hoc, fine).

## The ONE new collection — reads-manifest sha emit (`packages/core/src/runner/node-lifecycle.ts`)
At/near `finishNode` (after the node's events are recorded, files still reflect the run), write
`.pi/nodes/<id>/reads-manifest.json`: `{ "<abs path>": { sha256, bytes, lines, mtime } }` for every
path seen in the node's read events (source the path set from the accumulator's reads or the events).
Skip paths that no longer exist. This makes variant/version correlation reliable across edits between
runs. Keep it best-effort (never fail the node on a hash error).

## CLI verb (`packages/cli/src/trace.ts` + register in `packages/cli/src/cli.ts`)
`piflowctl trace <run> [node] [--json]` — SHIPPED as `trace`, not `context` (`context` is already the
control-plane host/worker endpoint switch; reusing it would overload one verb across two unrelated concerns).
- Resolve run dir via the existing `resolveNodeRunDir`; `buildRunView` (single data path); read the
  attached `node.context`/`node.composition`.
- Table per node: `seq · op · displayPath · range · coverage(covered) · sha(short) · via` then a
  `composition` block (`injectedBytes`, `advertised`, **`advertisedUnread`**, `partialReads`).
  `--json` emits the raw `{context, composition}`.
- Follow the `status.ts`/`telemetry.ts` CLI pattern (argv parse → resolve → load → render).

---

## Tests (TEST-FIRST — a test must FAIL when the code is wrong)
- `contextComposition.test.ts`: drive the builder off a **fixture derived from gm10's real
  `events.jsonl`** (copy a trimmed slice into the test fixtures). Assert:
  1. the injected `prompt.md` appears as `seq 0, op:'inject'`.
  2. `design-rules.md` is in `advertised` (the prompt names it) and in `advertisedUnread` (0 reads in gm10).
  3. a `SKILL.md` read whose event carried `truncated:true` yields `covered:'full'` (under the cap) with
     `logPreviewCapped:true` — the anti-footgun assertion (mutate: if the code maps the log cap to
     `covered:'partial'`, this test must fail).
  4. coverage math: a synthetic large file read with `offset/limit` covering half → `coverage≈0.5`,
     `covered:'partial'`.
- reads-manifest emit test: a node run (or a unit around the emit) writes a manifest with a correct
  sha for a known file.
- CLI: a smoke test that `context <gm10> gameplay` renders `advertisedUnread` including `design-rules.md`.

## Acceptance
INSTRUMENT (proven on gm10, no rerun): `piflowctl trace gm10 gameplay` prints the ordered op list with
seq-0 `inject`; `SKILL.md` full-coverage (its `truncated` flags are log-preview only — the anti-footgun);
a genuinely partial read (`genres.json` 95%); a FAILED read shown `✗ EPERM` (NOT full); and an
`advertisedUnread` blind-spot free of prose/glob/decimal noise.
NOTE on gm10 + `design-rules.md`: gm10's STAGED prompt is the OLD (pre-`bcb0798`) version that never named
`design-rules.md`, so it correctly does NOT appear — the instrument only sees files the injected prompt
names. The `design-rules.md` blind-spot (or its resolution) is proven on a FRESH rerun of the CURRENT node,
whose `prompt.md:16` names it. (Prompt-only scan is intentional; transitive read-chain detection is a known
non-goal — the current node's prompt names `design-rules.md` directly, so prompt-scan suffices.)

## Build discipline
- Test-first. Typecheck + the new tests GREEN before done. Do NOT `git commit` — leave the diff in
  the working tree for review. Report the actual `git diff --stat` + test output (not a claim).
- Reuse `makeDisplayPath`, `scopeKind`, `PREVIEW_CAP`, `resolveNodeRunDir`, `buildRunView`. No new
  data logic in any view.
