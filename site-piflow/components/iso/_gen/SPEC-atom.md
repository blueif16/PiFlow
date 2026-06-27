# SPEC — the atom (one piflow node) hero illustration

> Distilled from `docs/design/node-action-protocol.md` (AS-BUILT / SHIPPED, G11/G12/G13).
> This is a SPEC the human confirms BEFORE anyone draws. It is not a drawing task.
> The whole metaphor, in one line: **an AGENT and its TOOLS, sealed in a SANDBOX.**

> **✅ CONFIRMED & BUILT (2026-06-26)** — `out/atom.mjs` renders this. 5 components, no control cue:
> - `part-sandbox` — translucent glass BOX wrapping everything.
> - `part-agent` — orange cube INSIDE, labeled **AGENT** (the one orange spark).
> - `part-hook-pre` / `part-hook-post` — thin GUARD-BANDS on the sandbox's two front faces (AT the boundary, mirrored, no glyph).
> - `part-tool-openclaw` / `part-tool-mcp` — two chips OUTSIDE, wired in. Only the distinctive tool families are shown — `fs`/`contract` are baseline plumbing, omitted (not features).
> - Resolved open questions: (1) control cue → DROPPED (land on agent+tools+sandbox); (2) tools → OpenClaw·MCP only; (3) hooks → guard-bands on the faces.

---

## 1. Per-node capability overview

A per-node config IS one `node.json` — one **real headless `pi` agent** per node (§0 "one pi per node"), authored as a small set of declarative fields the loader lowers and the runner executes. The distinctive capabilities worth showing:

- **One real `pi` per node** — each node EXECs a genuine headless `pi` (the `runNode` lifecycle, §0; not an in-process function call), so each node gets its OWN tools, sandbox, and model.
- **The `op[]` envelope** — every old grammar lowers into ONE ordered `op[]` of four classes: **DETECT** (`gate`), **DERIVE** (`transform`), **ACT** (`run`), **CONTROL** (`action`) (§2.1, `OpSpec`).
- **PRE / POST hooks at the lifecycle boundary** — `gate`/`run`/`inject` ops fire BEFORE the model (PRE, incl. the now-live `checks.pre` #11) and `transform`/`run`/`promote` ops fire AFTER it (POST, verify), §0 lifecycle + §2.2.
- **Per-node granted tools** — `tools.allow` + `assembleRunTools` seed exactly the granted set: `fs`, `oc.*` (OpenClaw), `mcp.*` servers, and the `contract:submit_result` tool (§4, G11) — finite, granted from outside.
- **Per-node sandbox scope** — an OS-enforcement boundary (`SandboxSpec` read/write), a SEPARATE security axis from data-flow, scoped per node (§2.3, concern #1).
- **Bounded forward reroute / retry / escalate** — on failure the node retries, escalates to a stronger model with evidence, or reroutes upstream — UNROLLED forward at compile time (`expandReroute`), never a runtime back-edge (§3 / §3-control).

---

## 2. The atom illustration COMPONENT SPEC

### COUNT
**6 primary components** (1 agent · 1 sandbox · 2 boundary hooks · 1 tool set · 1 forward on-failure cue).

### TOPOLOGY
- **INSIDE** the sandbox: the AGENT (the running `pi`) — and nothing else.
- **AT the boundary** of the sandbox: PRE hook (entry face) and POST hook (exit face) — guarded on the way in, verified on the way out.
- **OUTSIDE** the sandbox: the granted TOOLS, wired in across the boundary; and a light forward on-failure cue exiting past POST.

Draw order / containment: sandbox shell first → agent nested wholly within it → PRE/POST sitting ON the shell's entry/exit faces → tools floating outside, thin connectors crossing the wall to the agent → the forward cue as the lightest exit hint.

### COMPONENT TABLE

| part-slug | What it IS (real noun) | One-line meaning (grounded) | Where it sits | Label |
|---|---|---|---|---|
| `part-sandbox` | The per-node sandbox container | OS-enforcement boundary that WRAPS the agent; per-node read/write scope (`SandboxSpec`, §2.3, concern #1) | the container (everything else is relative to it) | `SANDBOX` |
| `part-agent` | The running headless `pi` | The one node = a whole agent that EXECs; the `runNode` "EXEC headless pi" step (§0 lifecycle, "one pi per node") | INSIDE the sandbox | `AGENT` |
| `part-pre-hook` | PRE ops at the entry face | Guarded on the way IN — `gate`/`inject` fold + fire BEFORE the model (`when:'pre'`, #11/#10, §2.1–2.2) | AT boundary (entry face) | `PRE` |
| `part-post-hook` | POST ops at the exit face | Verified on the way OUT — `transform`/`run`/`promote` + verify gate AFTER the model (`when:'post'`, §0 verify, §2.2) | AT boundary (exit face) | `POST` |
| `part-tools` | The granted tool set | Exactly the tools you grant — `{fs, oc.* (OpenClaw), mcp.*, contract:submit_result}` seeded by `assembleRunTools` (§4, G11) | OUTSIDE, wired in across the wall | `TOOLS` |
| `part-reroute-cue` | Forward on-failure hint | Bounded forward reroute/retry/escalate, UNROLLED acyclic — the doc REFUSES the back-edge (§3-control) | OUTSIDE, exiting past POST (forward only) | `→ retry / escalate` (optional, see OQ) |

### THE ONE ORANGE
`part-agent` (the AGENT) is the single orange spark. Nothing else is orange — sandbox, hooks, tools, and the forward cue all render in the neutral ink/grey vocabulary; the agent is the lone accent.

### FLOW / CONTROL
Forward task direction reads left→right (or entry→exit): **in → PRE → AGENT → POST → out**. The on-failure cue is a forward-only hint leaving past POST (a short forward tick / chevron labeled retry·escalate·reroute) — NEVER a backward or curved arrow, because the doc unrolls the loop forward into acyclic stages (§3-control).

### OPEN QUESTIONS
1. **Show the control cue at all?** `part-reroute-cue` is the most abstract element (it's a compile-time unroll, not a literal wire). Keep it as a faint forward tick for completeness, or drop to land harder on "agent + tools in a sandbox"?
2. **Exact tool labels.** Show all four (`fs`, `oc.*`, `mcp.*`, `contract`) as distinct wired chips, or a single `TOOLS` cluster with `fs · oc · mcp` as sub-labels? Per-node-distinctive bits are `oc.*` (OpenClaw) and `mcp.*` — worth surfacing those two by name.
3. **PRE/POST rendering.** Two thin guard-bands on the entry and exit faces of the sandbox shell, vs. two small gate glyphs seated on those faces — which reads more clearly as "at the boundary, not inside"?
