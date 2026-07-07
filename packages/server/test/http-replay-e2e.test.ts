import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  runFromTemplate,
  buildRunView,
  assessRunView,
  LocalSandboxProvider,
} from "@piflow/core";
import type { SandboxProvider } from "@piflow/core";

// L2 HTTP REPLAY (Target 6) — the FREE, no-model, no-network replay tier that must gate every PR to `main`.
//
// The honest seam (RB): `POST /api/runs/start` spawns an INDEPENDENT `piflowctl run` OS process that
// re-resolves its provider from `--sandbox` + env — there is NO cross-spawn provider/buildCommand channel to
// inject through. So this tier BYPASSES the spawn and drives the run IN-PROCESS: a real `runFromTemplate`
// with a real `LocalSandboxProvider` (kind 'local', NON-inmemory) and an offline in-place builder that writes
// `REPLAY-OK` to the node's declared artifact on the host run dir. The runner stamps `.pi/run.json`
// HONESTLY (`sandbox: provider.kind`), so the run-view + the byte-probe read GENUINE state — never a forged
// fixture (this replaces run-digest-endpoint.test's hand-written `writeRun(okRun())`).
//
// Then the REAL HTTP handlers run over that run dir:
//   • assertion 1 builds the view the SAME way `piflowRunView` does (`buildRunView(runDir, …)`,
//     handlers.ts:132-134) and runs the falsifiable `assessRunView` rubric (default `forbidSandbox:['inmemory']`);
//   • assertion 2 drives the REAL `piflowFile` handler (handlers.ts:284, which resolves via `resolveRunDir`)
//     to prove the artifact reads back byte-for-byte off host disk — a different code path than the runner's stat.
//
// SCOPING WAIVER (RB): this in-process tier does NOT prove cross-spawn env-reach (Target 2), the real e2b
// flatten (Target 3 + the live L3 tier), nor a real pi/model executor (live tier). Named explicitly.

// ── the real template fixture (a known-good, ajv-valid template that already round-trips through
// `runFromTemplate` in core's entry.test) — COPIED into a tmp dir per test so instantiate's workflow.json
// rewrite never dirties the source. Its single node `greet` declares the artifact `out/greeting.txt`. ──
const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_TEMPLATE = join(HERE, "..", "..", "core", "test", "fixtures", "template-arg");
const DECLARED_ARTIFACT = "out/greeting.txt";
const NODE = "greet";

// The `resolveRunDir` the file handler shares with run-view/digest — settable per test (reuse the
// run-digest-endpoint harness verbatim; the ONLY change is the fixture is a REAL run, not a forged one).
let runDirStub: { runDir: string; workspaceRoot: string | null; historyDirs: string[] } | null = null;
vi.mock("../src/resolve.js", async () => {
  const actual = await vi.importActual<typeof import("../src/resolve.js")>("../src/resolve.js");
  return { ...actual, resolveRunDir: vi.fn(async () => runDirStub) };
});

const { piflowFile } = await import("../src/handlers.js");

// HERMETIC (M3 — the confirmed offender): this suite drives a REAL `runFromTemplate` without ever setting
// PIFLOW_HOME, so every run self-registered its `piflow-l2-*` scratch dir into the REAL
// `~/.piflow/products.json` (~290 such corpses accumulated over time). `registerProductRoot` now also
// no-ops for any root under `os.tmpdir()` (belt), but pointing PIFLOW_HOME at its own scratch dir here
// (suspenders) keeps this suite fully hermetic against the REAL global home for anything else it might read
// or write there (model-tiers, catalog, skills).
let scratch: string;
let piflowHome: string;
let savedPiflowHome: string | undefined;
beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), "piflow-l2-"));
  piflowHome = await fs.mkdtemp(join(tmpdir(), "piflow-home-l2-"));
  savedPiflowHome = process.env.PIFLOW_HOME;
  process.env.PIFLOW_HOME = piflowHome;
  runDirStub = null;
});
afterEach(async () => {
  if (savedPiflowHome === undefined) delete process.env.PIFLOW_HOME;
  else process.env.PIFLOW_HOME = savedPiflowHome;
  await fs.rm(scratch, { recursive: true, force: true });
  await fs.rm(piflowHome, { recursive: true, force: true });
});

/** Copy the known-good template into `scratch/template` so its workflow.json lock can be (re)written freely. */
async function stageTemplate(): Promise<string> {
  const dst = join(scratch, "template");
  await fs.cp(SRC_TEMPLATE, dst, { recursive: true });
  return dst;
}

/**
 * The offline IN-PLACE builder — the LocalSandbox roots at the workspace, so the node writes its declared
 * artifact DIRECTLY to its host location (`<runDir>/<artifact>`), the exact path the artifact gate stats
 * (the code-accurate local-run shape from runner.test:2382). `content` is the exact bytes; a clean ok-return
 * fence on stdout. When `content` is null the builder writes NOTHING (the no-op litmus, injected fault B).
 */
function inPlaceBuilder(runDir: string, artifact: string, content: string | null) {
  return (node: { id: string }): string => {
    const ret = `printf '%s' '\`\`\`json\\n{"status":"ok","summary":"${node.id} done"}\\n\`\`\`'`;
    if (content === null) return ret; // writes nothing → the declared artifact never appears on disk
    const dest = join(runDir, artifact);
    const dir = dirname(dest);
    return `mkdir -p ${JSON.stringify(dir)} && printf '%s' '${content}' > ${JSON.stringify(dest)} && ${ret}`;
  };
}

/** Drive the piflowFile middleware with a fake req/res; resolves {status, contentType, body}. */
function callFile(url: string): Promise<{ status: number; contentType?: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = { url, method: "GET", headers: {}, on: () => req, destroy() {} } as unknown as IncomingMessage;
    const headers: Record<string, string> = {};
    const chunks: Buffer[] = [];
    let ended = false;
    const res = {
      statusCode: 200,
      setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; },
      end(payload?: string | Buffer) {
        if (ended) return;
        ended = true;
        if (payload != null) chunks.push(Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)));
        resolve({ status: this.statusCode, contentType: headers["content-type"], body: Buffer.concat(chunks) });
      },
    } as unknown as ServerResponse;
    Promise.resolve(piflowFile(req, res, () => reject(new Error("route did not match")))).catch(reject);
  });
}

/** Run the template in-process → a real run dir with a genuine `.pi/run.json`. `provider:undefined` ⇒ the
 *  runner defaults to InMemorySandboxProvider (the N-inmemory / Railway false-green reproduction). */
async function driveRun(opts: { content: string | null; provider?: SandboxProvider }): Promise<string> {
  const templateDir = await stageTemplate();
  const runDir = join(scratch, "run");
  await fs.mkdir(runDir, { recursive: true });
  await runFromTemplate(templateDir, {
    run: "l2-replay",
    runDir,
    workspace: scratch,
    repoRoot: scratch,
    args: { greeting: "hello" }, // template-arg's node resolves {{arg.greeting}}
    provider: opts.provider,
    buildCommand: inPlaceBuilder(runDir, DECLARED_ARTIFACT, opts.content),
  });
  return runDir;
}

describe("L2a — HTTP replay over a real local run (Target 6)", () => {
  it("assessRunView(view, {expectNodes:['greet']}).pass === true — a real 'local' run with the artifact on disk", async () => {
    const runDir = await driveRun({ content: "REPLAY-OK", provider: new LocalSandboxProvider({ enforceReadScope: false }) });

    // Build the view EXACTLY as piflowRunView does (handlers.ts:132-134), then run the falsifiable rubric.
    const { view } = buildRunView(runDir, { historyDirs: [], workspaceRoot: scratch });
    const assessment = assessRunView(view, { expectNodes: [NODE] });

    // The run genuinely executed a NON-inmemory backend (this is the whole point of the tier).
    expect(view.sandbox).toBe("local");
    // pass === true simultaneously asserts sandbox≠inmemory, run.ok, node ok, artifact exists && bytes>0.
    expect(assessment.pass, assessment.failures.join(" | ")).toBe(true);
  });

  it("INDEPENDENT PROBE: the REAL piflowFile handler reads the declared artifact back as 'REPLAY-OK' off host disk", async () => {
    const runDir = await driveRun({ content: "REPLAY-OK", provider: new LocalSandboxProvider({ enforceReadScope: false }) });
    runDirStub = { runDir, workspaceRoot: scratch, historyDirs: [] };

    const { status, body } = await callFile(`/__piflow/file/l2-replay?path=${encodeURIComponent(DECLARED_ARTIFACT)}`);

    expect(status).toBe(200);
    // A fresh host-disk readFile (handlers.ts:316), a different code path than the runner's artifact stat.
    expect(body.toString("utf8").trim()).toBe("REPLAY-OK");
  });
});

describe("L2a — injected fault A (N-inmemory, the exact Railway false-green)", () => {
  it("the SAME run with the provider OMITTED → view.sandbox==='inmemory' → assess.pass===false naming inmemory", async () => {
    // provider undefined ⇒ runner defaults to InMemorySandboxProvider (kind 'inmemory'). This runs the REAL
    // pipeline with a real inmemory backend — deleting assess.ts:43's forbid check also reds the standing L2a positive.
    const runDir = await driveRun({ content: "REPLAY-OK", provider: undefined });

    const { view } = buildRunView(runDir, { historyDirs: [], workspaceRoot: scratch });
    const assessment = assessRunView(view, { expectNodes: [NODE] });

    expect(view.sandbox).toBe("inmemory");
    expect(assessment.pass).toBe(false);
    expect(assessment.failures.join(" | ")).toMatch(/inmemory/);
  });
});

describe("L2a — injected fault B (no-op litmus: a builder that writes nothing)", () => {
  it("no bytes written → assessRunView.pass===false (exists:false) AND piflowFile 404", async () => {
    const runDir = await driveRun({ content: null, provider: new LocalSandboxProvider({ enforceReadScope: false }) });
    runDirStub = { runDir, workspaceRoot: scratch, historyDirs: [] };

    // (a) the rubric reds because the declared artifact is absent on disk.
    const { view } = buildRunView(runDir, { historyDirs: [], workspaceRoot: scratch });
    const assessment = assessRunView(view, { expectNodes: [NODE] });
    expect(assessment.pass).toBe(false);
    expect(assessment.failures.join(" | ")).toMatch(/greeting\.txt|missing on disk|declared no artifacts/);

    // (b) the independent host-disk probe 404s (the file genuinely is not there).
    const { status } = await callFile(`/__piflow/file/l2-replay?path=${encodeURIComponent(DECLARED_ARTIFACT)}`);
    expect(status).toBe(404);

    // (c) fresh, code-independent confirmation the artifact really does not exist on disk.
    await expect(fs.access(join(runDir, DECLARED_ARTIFACT))).rejects.toBeTruthy();
  });
});

// ── L2b — the argv discriminator (the N-inmemory MECHANISM, pure). A `POST /api/runs/start` that OMITS
// `sandbox` appends NO `--sandbox` flag → the spawned `piflowctl run` child parses `sandbox:'inmemory'` at
// run.ts:242 → the exact Railway false-green. Extends start-run.test:42-48. ──
import { buildStartRunArgv, type StartBody } from "../src/start-run.js";

const TPL = "/repo/.piflow/wf/template";
const RUN = "l2b";

describe("L2b — buildStartRunArgv: an omitted `sandbox` yields NO --sandbox (⇒ inmemory default downstream)", () => {
  it("{ sandbox:'e2b' } CONTAINS `--sandbox e2b`", () => {
    const argv = buildStartRunArgv(TPL, RUN, { sandbox: "e2b" } as StartBody);
    expect(argv).toContain("--sandbox");
    expect(argv.join(" ")).toContain("--sandbox e2b");
  });

  it("{} (no sandbox) does NOT contain `--sandbox` — the omitted-sandbox → inmemory-default mechanism", () => {
    const argv = buildStartRunArgv(TPL, RUN, {});
    expect(argv).not.toContain("--sandbox");
  });
});
