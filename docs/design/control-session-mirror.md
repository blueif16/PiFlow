# Control Session & the SRE/Diagnostician Observer — talking to a pi about a run

> **Status:** DIRECTION / discussion (2026-06-27). Captures the "talk to a pi about a run" idea: the one
> two-way channel we add on top of the one-way `observe` substrate, the observer tiering, and the
> SRE/diagnostician agent as the canonical observer identity. Not a committed build. Cross-ref:
> `docs/design/detached-run-control-vm.md` (the cloud control-VM this rides on),
> `docs/design/observability-pipeline.md` (the one-way `observe` feed), `docs/design/node-action-protocol.md`
> (node actions/tools), `docs/design/credential-architecture.md` (scoped creds in the cloud).

## The idea
Today the GUI is **one-way**: everything it shows flows through `@piflow/core/observe` from the `.pi` run
tree (`watchRun`/`buildRunView`). **Local is ground truth; the GUI reflects it.** There are no GUI↔pi
sessions and no two-way wiring. That stays — the DAG workflow telemetry should remain one-way forever.

What we add is **exactly one two-way channel**: a *control session* — an interactive `pi` you talk to about a
run. "How's it going? Why did W3 fail? Restart it. Edit the plan." The DAG nodes never become interactive;
all bidirectional, stateful behavior lives in this single, well-scoped channel.

## Two channels, different physics
- **DAG telemetry — one-way, forever.** Headless nodes, deterministic, `observe`-reflected. **Unlimited,
  idempotent readers**: `watchRun` re-sends a snapshot then deltas to anyone who taps `.pi`. The run does not
  know or care who is watching; a reader cannot affect it. Never make a node interactive — that breaks
  reproducibility and the one-pi-per-node thesis.
- **Control plane — exactly one two-way channel.** The control session below. Everything bidirectional is here.

## The control-session primitive
A control session collapses the whole idea ("start a pi on the GUI → it roots in the run's folder → connect to
the telemetry stream → ask it to edit / restart") into one primitive:

> **A control session = a real, persistent `pi` with `cwd = runDir`, exposed as {events-out, input-in},
> grounded by `observe`.**

Because it is a *real* pi in the run folder, "ask it to make edits" needs no new machinery — it has the
filesystem and tools, it edits, and the one-way `observe` feed picks the change up and the GUI updates. The
control pi *writing* and the GUI *reflecting* are still the same one-way flow; we have just put an agent on the
write side instead of a human.

```
            ┌── events-out (SSE) ──►  GUI companion (the mirror)
control pi ─┤
 (cwd=run)  ◄── input-in (POST) ───  GUI composer (sendToPi)
     │
     └── reads the run-view via observe  (its grounding / context)

LOCAL:  the bridge spawns pi(cwd=runDir)        → serves SSE+POST on localhost
CLOUD:  the control-VM already runs pi(cwd=run) → serves SSE+POST on a port
The GUI client is byte-identical — only the base URL changes.
```

This is precisely tau's "a mirror of a local pi session in the browser," with two deliberate differences: **we**
own the spawn (so we set `cwd` to the run folder and inject the run-view as context), and it starts from the
GUI, not a terminal. See **Library positioning** below.

## Two classes of "ask it to do stuff" (the key distinction)
Get this right or the runner stops being deterministic.

1. **File / plan edits** — the control pi does them **directly**. Edit an artifact, rewrite the plan/template,
   even bake structure (the GUI already has `save-run`). No new surface; `observe` reflects it.
2. **Run-lifecycle ops** — "restart this node", "resume", "abort", "re-run from here". These mutate the
   **runner's** state, and the runner must stay the **sole authority**. The control pi must **not** poke runner
   internals — it drops a typed *intent* and the runner validates and acts.

We already have the pattern: `POST /__piflow/checkpoint/<run>` writes a file the runner watches
(`.pi/checkpoints/<nodeId>.reply.json`); the runner re-validates the echoed hash and ignores a bad/stale
reply. Generalize that into one **control-intent courier**:

```
control pi (or human) → POST /__piflow/control/<run>/intent  {restart:"W3", ...}
                       → writes .pi/control/<seq>.json
runner polls, validates (it is the authority), acts, emits telemetry → GUI sees it (one-way)
```

So **chat + file edits are free-form; lifecycle changes go through the one door the runner owns.** The
human-in-the-loop touch points (answer a checkpoint, restart a stuck node) become "direct the control pi, who
writes the intent" — replacing the human without handing an LLM the keys to the engine.

## Readers vs writers — the concurrency model
This is the precise answer to "what if two sessions catch the same stream at once?"

- **Readers are unlimited, idempotent, and harmless.** Two agents (or ten) subscribing cannot affect or corrupt
  the run. The only cost is each one *thinking* (its own tokens). Attach/detach any time, mid-run — each picks up
  from the current snapshot.
- **Writers go through the runner's one door**, which **serializes and arbitrates** (hash-validated,
  reject-stale, like the checkpoint reply). Even if two agents both submit "restart W3", the runner orders them.

So the worst case of overlap is **wasted thinking tokens, never a corrupted run.** Mitigations, cheapest first:
- **Dedup the tap, not the stream.** One subscription multiplexed to N consumers (the GUI already does this:
  CanvasInner owns ONE `EventSource` and the Companion reads the shared context — `runStream.ts`). A second
  consumer should not re-poll `.pi`.
- **Lease/registry for *standing* agents** ("this run already has a supervisor") to prevent accidental doubling.
  Not required for correctness; purely a cost guard.
- **Advisory vs acting.** Two read-only advisors = harmless noise. Two actors = the runner serialization covers
  you. (The field names "conflicting decisions in multi-agent systems" as a top risk — this is the mitigation.)

## Observer tiering — observation is optional, not mandated
There is **no mandated observer agent** today, and that is correct. The run advances on its own. We tier the
control loop so the cheap one is the default floor:

- **Tier 0 — declarative policies (always on, free, deterministic).** The node tags — timeout, retry,
  on-error/fallback. This *is* the default "agent": it moves the flow forward with zero tokens and no LLM. No
  background watcher needed.
- **Tier 1 — on-demand agent attach (pay when you ask).** "How's it going / should we re-run W3 / edit the
  plan." Wire in, ask, detach. This is the control session.
- **Tier 2 — a standing supervisor (opt-in, expensive).** A pi continuously watching + intervening. The
  "mandated observe agent" we do **not** want as default.

"Both modes later" = **Tier 0 always; Tier 1/2 opt-in.** The default floor stays free.

Two rules that fall out:
- **Facts → `observe` (free); judgment/action → an agent (paid).** `whereAreWe()` and the run-view already
  answer "3/9 done, W2 running, this node failed" deterministically. Don't spend LLM tokens to read a gauge. An
  agent earns its tokens for *judgment* ("is this output good? retry with a different model?") and *action*.
- **The observer is polymorphic.** Its identity (model, tools, skill, prompt) is a free parameter, so we build
  **one attach mechanism + a library of observer identities**, and those identities are just `agentType`s from
  the agent-preset (G6) / capability catalog. We don't build N observers.

## The SRE / diagnostician observer (the canonical Tier-1/2 identity)
The most useful observer identity is an **SRE/diagnostician for the run itself** — it surfaces what a
deterministic read cannot, the things only an LLM can summarize by analyzing the data.

**What it adds over a deterministic read:**
- **Semantic quality judgment:** "W3 is `status=ok` but its output contradicts W2's spec / fails the acceptance
  criteria" (LLM-as-judge over artifacts).
- **Cross-signal correlation:** "cache hit collapsed + tokens 6× + duration 3× all started when the node routed
  to model X → the swap, not the prompt."
- **Failure-pattern classification:** "3 retries, identical error string → deterministic config bug, not
  transient; the retry policy is burning money."
- **Cost / regression narrative vs the prior-run baseline.**
- **Blast-radius reasoning:** "W3's output is suspect, and W5/W7 read it → they're suspect too" (walk the
  writer→reader file edges).
- **Recommendations** with evidence and confidence.

**The 2026 AI-SRE capability pipeline (the functionality set we're emulating):** signal ingestion →
correlation/noise-reduction → investigation → root-cause reasoning (hypotheses, 5-whys, timeline, candidate
causes w/ confidence) → **summarization/narrative** → remediation (gated) → verification → learning/memory.
The closest analog to piflow is the *agent-observability* lineage (MLflow/Braintrust/AgentOps), whose core
requirement is **hierarchical tracing** — "a root cause in one sub-agent propagates downstream; without the
span hierarchy, debugging a multi-agent pipeline is guesswork."

### Why piflow's run tree is a *better* substrate than the vendors' data
Production AI-SRE tools fight data quality ("only as good as integration coverage; gaps in traces limit RCA");
Traversal uses causal ML just to *reconstruct* a dependency graph from log soup. We don't have that problem:
- The DAG's explicit **writer→reader file edges** *are* the causal graph — what Traversal infers, we have
  structurally.
- Per-node provenance is already captured: tokens, tools, reads/writes, status, duration, retries, model.
- We already compute a **prior-run baseline** (`historyDirs` → `expectedMs` in the run-view) → "what changed vs
  last run," the single highest-value RCA signal, built in.
- **Local-first** → no data-residency / SaaS-trace-exfil blocker (the top enterprise objection to every vendor).

So the SRE agent *traverses a clean graph*; it does not dig through a haystack.

### Read-only vs. tools — the ladder
The 2026 consensus is unanimous: **start read-only, graduate to tools through a governance door you build
first.** "Maximum autonomy is the wrong target; measurable value at minimum risk is the right one." Value peaks
*early* (investigation); governance must be strongest at the *remediation boundary*. The piflow kicker: **we
already built the governance door — the runner-intent courier is the blast-radius limit + approval gate + audit
log + policy-verification in one.** The ladder:

- **Tier A — read-only diagnostician (build this first).** Reads everything (run-view via `observe`, artifacts
  via the file bridge, the baseline, the codebase); its only "write" is an **advisory artifact** — a diagnosis
  report + ranked recommendations written into the run. Fits the model perfectly: the SRE agent is just another
  *one-way writer*, the GUI reflects its report like any other file. ~80% of the value, ~0 new risk.
- **Tier B — advise + propose typed intents (human approves).** It proposes remediations — "restart W3", "bump
  the retry budget", "re-route to deep tier", "the W2→W3 contract is underspecified, here's the edit" — as
  **courier intents the runner validates**, surfaced in the approval UI we already have (the checkpoint-reply
  seam). Human clicks yes.
- **Tier C — auto-remediate well-understood patterns only**, under a cost/blast budget the runner owns (e.g.
  auto-restart on a known-transient error class). **Graduate by evidence/SLO, not by calendar.**

**Non-negotiable:** even though it is a real pi, the SRE agent gets **read-everything + a small set of typed
remediation intents through the courier — never raw write/exec on the run.** The courier is the least-privilege
boundary; raw fs/exec is how you get the cautionary 2026 failure mode (an agent that hijacked GPUs for
crypto-mining, uninstructed). It can freely *think* and *write its report*; it can only *change the run* through
the one validated door.

### Memory loop
Persist diagnoses as per-run reports **and** a cross-run pattern store, so the agent learns *our* workflows'
recurring failure modes (Cleric's "operational memory" thesis). Tie into the existing `file_bug` /
`search_past_bugs` habit and `learning-records/` — the SRE agent searches past bugs before re-diagnosing and
files new ones it confirms.

## Local == cloud
The same primitive, two hosts:
- **Local:** the bridge spawns `pi(cwd=runDir)`, holds the process, and serves SSE+POST — Vite middleware in
  dev, `piflowctl` in prod (the spawn is server-side; the GUI is a static viewer).
- **Cloud:** the control pi already lives in the **control-VM** (`detached-run-control-vm.md` architecture B);
  it serves the same SSE+POST on a port; the GUI reattaches via a base URL + bearer token.

This is literally the detached-VM doc's "reconnectable observability — bind the companion bridge to a port,"
**extended from the run-view feed to also carry the control-pi mirror.** For the reattach handle, copy pi-web's
*pattern* — `machines.json` + bearer token over an authenticated reverse proxy — not its code.

## What's genuinely new (be honest)
Most of this is **reuse**: the SSE seam (`/__piflow/stream`), the courier pattern
(`/__piflow/checkpoint`), the shared subscription (`runStream.ts`), the node context (`expandedId` already on
the companion), the `sendToPi` stub (`gui/src/components/Companion.tsx:55`), `observe` grounding, the
`historyDirs` baseline, and the checkpoint **approval UI**. The net-new engine work, unavoidable under any
library choice:
1. **Runner-side interactive-pi host** — spawn a persistent pi at `cwd=runDir`, hold it, re-expose its event
   stream + accept input.
2. **The control-intent courier + the runner honoring intents** (restart / resume / abort).
3. **The SRE identity** (a skill / `agentType`) + its report artifact + the cross-run memory store.

## Minimal seams (concrete endpoints)
- `POST /__piflow/control/<run>/start` — spawn (local) or open a connection to the control-VM (cloud); returns
  a session handle.
- `GET  /__piflow/control/<run>/stream` — SSE of the control pi's messages/tool-calls/thinking. **Separate**
  from the DAG telemetry stream, to keep that channel pure one-way and this one clearly two-way.
- `POST /__piflow/control/<run>/message` — forward the user's text to the pi (mirrors the checkpoint courier).
- `POST /__piflow/control/<run>/intent` — write `.pi/control/<seq>.json`; the **runner** validates and acts.
- **GUI:** wire `Companion` `sendToPi` → `message`; render `stream` in the companion log; the "start a pi
  session" button → `start`; node context is already carried as `expandedId`.

## The one decision to make: who hosts the mirror?
| | (i) pi self-serves (tau-style extension) | (ii) the bridge pipes it |
|---|---|---|
| Effort for the mirror | lowest — spawn pi with a mirror extension | more — subscribe + re-expose |
| Transport | tau's WS, inside the pi process | our existing SSE + a POST |
| Runner-as-authority / cloud reattach | weaker (mirror dies with pi; separate transport) | stronger (unifies with the courier + cloud reattach) |
| Best for | a fast prototype | the real local==cloud architecture |

**Recommendation:** prototype with (i) to feel it, then land (ii) because it unifies with the courier and the
cloud reattach.

## Library positioning
- **Do not import pi-web.** `@jmfederico/pi-web` is an *application*, not a component library — three daemonized
  processes (CLI + Fastify gateway + `sessiond`) with its own Lit frontend; its only stable surface is a
  browser *plugin* API ("cannot extend the session daemon"). Its unit is an interactive chat *Session in a git
  worktree* (Machine→Project→Workspace→Session) — **orthogonal to our DAG**: it has no concept of a run-view,
  node, stage, fusion, or checkpoint. We have already built the harder, DAG-specific 80% (the bridge, the SSE
  feed, the courier). MIT, but the wrong dependency.
- **tau is the mirror reference.** `tau-mirror` (`deflating/tau`) is a tiny pi *extension*
  (`extensions/mirror-server.ts`, deps `ws`+`qrcode`) that does exactly "subscribe to all pi events → forward
  to browser → execute commands back via the extension API" — our missing talk-back loop in ~one file. Study or
  port it for option (i); it is MIT (declared in `package.json`/README, though there is no `LICENSE` file —
  weaker footing than pi-web's). Attribute `deflating/tau`.
- **Same underlying pi.** Both wrap the same agent — `badlogic/pi-mono` was transferred/renamed to
  `earendil-works/pi` (the one piflow already builds on via `@earendil-works/pi-coding-agent`).
- pi-web's **federation** (`~/.pi-web/machines.json` + bearer token + authenticated reverse proxy) is a *pattern*
  worth copying for the cloud reattach handle — not its code.

## Non-goals
- Making DAG nodes interactive (breaks reproducibility / the one-pi-per-node thesis).
- A two-way protocol for the telemetry feed (it stays one-way; readers are pure consumers).
- A mandated, always-on observer (Tier 0 policies are the default; agents are opt-in).
- Giving any observer raw write/exec on the run (read-everything + typed courier intents only).

## References (AI-SRE, 2026)
- Rootly — *What is an AI SRE?* <https://rootly.com/ai-sre-guide>
- Augment Code — *AI SRE: The 2026 Guide* <https://www.augmentcode.com/guides/ai-sre-ai-powered-site-reliability-engineering>
- Arvo/Aurora — *AI SRE in 2026: Complete Guide* <https://www.arvoai.ca/blog/ai-sre-complete-guide>
- Anyshift — *Top 10 AI SRE Tools 2026 (architecture camps)* <https://www.anyshift.io/blog/top-10-ai-sre-tools-2026-comparison>
- *Cleric vs Resolve.ai vs Traversal (2026)* <https://wetheflywheel.com/en/guides/cleric-vs-resolve-ai-vs-traversal/>
- MLflow — *What Is Agent Observability? (2026)* <https://mlflow.org/articles/what-is-agent-observability-a-2026-developer-guide/>
- *Cloud Infrastructure Management in the Age of AI Agents* (autonomy levels + policy verification) <https://arxiv.org/pdf/2506.12270>
