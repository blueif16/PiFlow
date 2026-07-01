import { describe, it, expect } from "vitest";
import { buildStartRunArgv, type StartBody } from "../src/start-run.js";

// The `piflowctl run` argv that POST /api/runs/start spawns is built from the request body. A wrong flag
// mapping (missing per-node executor override, dropped arg, mislabelled sandbox) would silently launch the
// WRONG run — so pin the mapping here. These assert the exact tokens, in order, that the CLI parser reads.

const TPL = "/repo/.piflow/wf/template";
const RUN = "brave-pie";

describe("buildStartRunArgv — request body → piflowctl run flags", () => {
  it("a bare start is just `run <templateDir> --run <id>` (no stray flags)", () => {
    expect(buildStartRunArgv(TPL, RUN, {})).toEqual(["run", TPL, "--run", RUN]);
  });

  it("run-level executor → `--executor <v>`; per-node override → `--executor <nodeId>=<v>` (both forms, the runner's resolveExecutor honors precedence)", () => {
    const body: StartBody = { executor: "claude-code", executorOverride: { build: "pi", ship: "claude-code" } };
    const argv = buildStartRunArgv(TPL, RUN, body);
    // run-level default present exactly once as a bare value
    expect(argv).toContain("--executor");
    expect(argv.join(" ")).toContain("--executor claude-code");
    // per-node overrides present as node=value (this is what a plain executor:'x' body would MISS)
    expect(argv.join(" ")).toContain("--executor build=pi");
    expect(argv.join(" ")).toContain("--executor ship=claude-code");
  });

  it("args map → repeated `--arg k=v`; sandbox/dry-run/detach/profile flags map through", () => {
    const body: StartBody = {
      sandbox: "local", dryRun: true, detach: true, profile: "fast",
      args: { topic: "space", seed: "7" },
    };
    const argv = buildStartRunArgv(TPL, RUN, body);
    const s = argv.join(" ");
    expect(s).toContain("--sandbox local");
    expect(s).toContain("--dry-run");
    expect(s).toContain("--detach");
    expect(s).toContain("--profile fast");
    expect(s).toContain("--arg topic=space");
    expect(s).toContain("--arg seed=7");
  });

  it("omitted options add NO flags (a run with no options is a clean bare invocation)", () => {
    const argv = buildStartRunArgv(TPL, RUN, { sandbox: undefined, args: {} });
    expect(argv).toEqual(["run", TPL, "--run", RUN]);
    expect(argv).not.toContain("--sandbox");
    expect(argv).not.toContain("--dry-run");
    expect(argv).not.toContain("--executor");
  });
});
