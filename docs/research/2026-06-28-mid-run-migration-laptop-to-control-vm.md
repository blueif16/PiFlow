# Mid-run migration — moving a running workflow from the laptop to a cloud control-VM

**Date:** 2026-06-28 · **Status:** research

> Research + design-direction for the **A→B mid-run migration** feature: a run starts on the laptop
> (Architecture A — laptop orchestrator) and, at a node boundary, both the control plane *and* all
> not-yet-run nodes are pushed to a cloud control-VM (Architecture B), where the run finishes while the
> laptop disconnects and can re-attach as an observer. Grounded in the piflow docs cited inline; every
> external claim carries a source URL (§7). Companion: `docs/design/detached-run-control-vm.md` (the A/B/C
> decision this extends — that doc covers *starting* detached; this one covers *migrating* a live run),
> `docs/specs/wiring-g4-resume-journal.md` (the durable-state machinery reused), and
> `docs/research/2026-06-27-per-node-capability-isolation.md` (the per-node thesis the migration must preserve).
>
> **Scope fence.** This is *run-level* migration (whole control plane + remaining DAG moves once, at a node
> boundary). It is explicitly **NOT** per-node simultaneous mixed-backend execution (a per-node provider map),
> which is deferred. No code, schema, or other file is touched by this doc.

---

## 1. The feature in one paragraph

You launch `piflowctl run` on your laptop and watch the first few nodes execute — interactive, cheap, fully
observed. Then you decide to close the laptop. With **mid-run migration**, piflow snapshots the durable run
directory (`${RUN}/.pi/` — `run.json`, `state.json`, `journal.json`, plus the on-disk artifacts), boots a
cloud **control-VM** from the piflow-CLI image, stages that snapshot into it, and resumes `piflowctl run`
*inside the VM* from the **frontier** — the set of completed-node outputs already on disk. The control plane
moves from "laptop orchestrator" (Architecture A) to "detached control-VM" (Architecture B) **at a node
boundary**; the laptop then disconnects and may later re-attach purely as an **observer** over the existing
`observe`/`watchRun` SSE feed. The thesis: because piflow's run state is fully durable on disk and any
control plane can resume it via `--from`, this is structurally the same move durable-execution engines make
when a workflow is resurrected on a different worker — only one level up, where the unit being migrated is the
*orchestrator process itself*, not a single node.

---

## 2. Why piflow is already 80% there

Durable-execution theory has one load-bearing idea: **the log/journal is the source of truth, so any worker
can rebuild state and resume** — the worker is fungible, the log is not (Temporal: "Workers are stateless, so
any Workflow Execution in a blocked state can be safely removed from a Worker… resurrected on the same or
different Worker" [T-workers]). Map that onto piflow:

| Durable-execution concept | piflow mechanism (verified in the cited docs) | exists vs net-new |
| --- | --- | --- |
| The durable log/event history | The **run directory** `${RUN}/.pi/` — `run.json` rewritten atomically on every node transition (`status.ts:129` `writeStatus`, `wiring-g4-resume-journal.md` §2a), `state.json` persisted at each stage barrier (`state.ts:76`), and the **G4 journal** `${RUN}/.pi/journal.json` recording each completed node's envelope hash + input/output content hashes (`journal.ts`, `wiring-g4-resume-journal.md` §4b). | **EXISTS** (journal is designed/specced; `run.json`+`state.json` shipped). |
| "Skip completed steps, re-run from the last checkpoint" | G4 `decideResume(wf, journal, runDir)` (`wiring-g4-resume-journal.md` §4c): a node with a matching envelope + matching input-content-hashes is `REUSE`d; anything changed (or its DAG descendants) is `RUN`. With **no flags this is fully automatic** — the human is removed from the resume-point decision. | **EXISTS** (the precise analogue of DBOS "skip completed, run from last checkpoint" and Flyte `RecoverExecution`). |
| The manual resume cursor | `--from`/`--until` → `selectWindow(wf, from, until)` slices stages into `skipped`/`selected` (`runner.ts:276,938`); layered *on top of* the journal as a manual override (`wiring-g4-resume-journal.md` §4e). The **frontier** for a migration is exactly "`--from` the first not-yet-complete stage." | **EXISTS.** |
| Content-addressed correctness across the boundary | G4 hashes the **realized prompt + tools + model + contract** (envelope) and the **content hash of every consumed file** (`wiring-g4-resume-journal.md` §4a). A torn/half-written artifact is never journaled (write only on a terminal-good verdict, `finishNode` `runner.ts:830`, §4d). So resuming on a *fresh* VM cannot silently reuse a stale or partial output — the hashes won't match. | **EXISTS** (this is what makes a cross-machine resume *safe*, not just possible). |
| "The control plane is fungible / runs anywhere" | The runner is provider-agnostic over `SandboxProvider`/`RunScope`; **the control VM is just another staged sandbox running a different command** — node sandbox runs `pi …`, control VM runs `piflowctl run <template>` (`detached-run-control-vm.md` §"Why B is cheap"). The same staging seam (putFiles, env allowlist, `downloadDir`) works one level up. | **EXISTS as the architecture B insight**; the *trigger-mid-run* path is net-new (§4). |
| Reconnectable observability | `observe`/`watchRun` re-sends a snapshot then deltas to **unlimited idempotent readers** off the `.pi` tree; the companion bridge already serves SSE-down + POST-up (`control-session-mirror.md`, `control-session-streaming-spec.md` §4). Cloud is "bind the bridge to a port + base-URL swap." | **EXISTS for local;** the cloud-reattach handle (bearer token + reverse proxy) is net-new — `detached-run-control-vm.md` calls this "the main net-new surface." |
| Scoped credentials for the new control plane | `SecretResolver` receives `{nodeId, isCloud}` and mints a per-node, cloud-only scoped token; `cloudCredEnvAdditions` forwards exactly the referenced allowlist; `stageHome` writes the scoped `models.json` (`$VAR` refs only) into the VM (`credential-architecture.md` §3–§4). | **EXISTS one level down (per node); reusing it for the control-VM's own provider key is net-new** (`detached-run-control-vm.md` §"nested credentials"). |

**The honest 20% that is net-new** (none of it an engine rewrite):
1. **A migration *trigger* at a node boundary** — "stop accepting new nodes, flush the journal, hand off." Today
   the run only *ends*; there is no "freeze + emit a handoff bundle" verb. piflow's own
   `ARCHITECTURE.md` §5 rule — **hot-edits/structure changes happen at seams, not mid-run** — is exactly the
   discipline this trigger must obey: migration fires at a node boundary, never mid-node.
2. **A handoff bundle + boot/stage of the control-VM** from an in-progress run dir (vs. `detached-run-control-vm.md`'s
   v1 which only covers launching detached *from the start*).
3. **The cloud-reattach observability handle** (bearer token + reverse proxy in front of the bridge port).
4. **The control-VM's own provider credential** (the long-lived infra key that lets it spawn child sandboxes),
   minted scoped rather than forwarded raw.
5. **Detach-time orphan/teardown safety + a "$spent / still-alive" heartbeat** so an abandoned detached run
   self-destructs (`detached-run-control-vm.md` §3–§4).

Everything in the left column above is the *reason* migration is cheap; items 1–5 are the only genuinely new
surfaces.

---

## 3. Prior-art survey

Each row: the system · its durable state + what triggers a handoff + how an in-flight unit behaves across the
boundary · the piflow mapping · source.

| System (category) | Mechanism: durable state · handoff trigger · in-flight unit across the boundary | Maps to piflow | Source |
| --- | --- | --- | --- |
| **Temporal** (durable-exec) | Durable **Event History** (append-only log in the Temporal Service). Handoff trigger: worker crash/removal, or stickiness loss → task rescheduled to the original Task Queue. In-flight: workers are **stateless**; a blocked execution is **resurrected on the same or a different worker**, which **replays the history** to rebuild state, then continues. | The run dir + G4 journal = piflow's Event History; the laptop and the control-VM are two fungible "workers." Replay ↔ G4 `decideResume` rebuilding the skip/run plan from `journal.json`. piflow's run already records the analogue of `TaskCompleted` (a journaled node) so a fresh control plane resumes *only* the unfinished frontier. | [T-workers], [T-history] |
| **Restate** (durable-exec) | Per-invocation **journal** (runtime + SDK both hold a view). Handoff trigger: `restate invocations pause` / retry-pause, then **`resume --deployment <id>`**; also **"restart from prefix"** (retain part of the journal, replay it, continue with new code). In-flight: the invocation pauses *wherever it is*, then resumes on a **different deployment**, replaying the retained journal without re-doing completed work (warns on non-determinism if the code path diverges). | "Resume on a different deployment" is *exactly* "resume the same run on a different control plane (the VM)." "Restart from prefix" ↔ piflow `--from <frontier>` retaining the completed-node outputs. Restate's non-determinism warning ↔ piflow's envelope-hash guard catching a changed prompt/tool across the move. | [R-manage], [R-protocol], [R-blog] |
| **DBOS** (durable-exec) | Workflow + step outputs **checkpointed to Postgres**. Handoff trigger: crash/restart; **Conductor** detects an interrupted workflow (closed websocket + grace period) and **recovers it to another healthy executor**. In-flight: re-execute from the start, **skip checkpointed steps** (return stored output), the **in-progress step is retried** (at-least-once), not-yet-started steps run normally. | DBOS "recover to another healthy executor" = move the orchestrator to the control-VM. "Skip checkpointed / retry the in-progress step" ↔ piflow's choice for the node executing at the migration instant (§4: abort+re-run that one node, reuse the rest). The grace-period websocket detection ↔ piflow's detach heartbeat (§5). | [D-arch], [D-durability] |
| **Azure Durable Functions** (durable-exec) | **Event-sourced history** in an append-only store. Handoff trigger: the orchestrator is **unloaded from memory** while awaiting (to stop billing) or after a crash. In-flight: on resume the **orchestrator re-executes from the start**, consulting the history to replay already-completed activity results instead of re-running them; must be deterministic. | The "unload from memory, rehydrate elsewhere by replaying the log" pattern is the migration in miniature. piflow doesn't replay *code* (each node is a real `pi`); it replays the *decision* (which nodes to skip) from the journal — a coarser but crash-safe equivalent. DF's determinism constraint ↔ piflow's §5 non-deterministic-node caveat. | [ADF-constraints], [ADF-overview], [DF-paper] |
| **Inngest** (durable-exec) | **Step memoization** in a managed state store; the engine drives your code over **HTTP**, on *your own compute*, in any runtime. Handoff trigger: each step boundary (the engine re-invokes your endpoint). In-flight: the function **re-runs from the top but skips memoized steps**, injecting their stored results; steps run once and cache. | Inngest's "engine orchestrates, your compute executes, over a thin protocol" mirrors piflow's "control plane (VM) orchestrates, per-node `pi` sandboxes execute." A migration is swapping which compute the engine talks to — for piflow, which machine hosts the control plane. Step memoization ↔ journaled node reuse. | [I-exec], [I-durable] |
| **Apache Airflow** (orchestrator) | **Task-instance state in the metadata DB**; executors are **pluggable** (Local/Celery/Kubernetes). Handoff trigger: scheduler/worker restart or pod reschedule; HA schedulers coordinate **purely via the DB** (`SELECT … FOR UPDATE` row locks, no Raft/ZK). In-flight: a worker that dies leaves a **zombie** `running` TI; the scheduler detects the **heartbeat timeout** and fails/retries it. | The DB-as-single-source-of-truth (no consensus protocol) is piflow's model: the **run dir is the DB**, both control planes coordinate through it. Pluggable executor ↔ `SandboxProvider`. The zombie/heartbeat-timeout reaper is the direct template for piflow's §5 orphan detection when the laptop dies before the handoff completes. | [AF-tasks], [AF-scheduler] |
| **Prefect** (orchestrator) | **Flow/task run state in the API/Cloud backend**; **work pools + workers** poll for runs. Handoff trigger: worker/agent crash. Key property: once a worker spawns the flow-run process, **the worker is not required for the flow to keep running**; if the process itself dies it is left `Running` until **zombie detection** (heartbeats + automations) marks it `Crashed`. | "The orchestrator that launched the work is not required for the work to continue" is the *enabling* property of detach: the laptop can drop once the control-VM owns the run. Prefect's hard-won lesson — a dead launcher leaves a stuck `Running` and burns a concurrency slot unless heartbeats catch it — is precisely piflow's §5 detach hazard, with the same mitigation (heartbeat → mark crashed/teardown). | [P-7116], [P-16746] |
| **Argo Workflows** (orchestrator) | Workflow **status persisted in the CRD object (etcd)**, archived to SQL. Handoff trigger: controller pod failure/rollout. In-flight: **a replacement controller continues running workflows**; **leader election** ensures exactly one active controller, because two reconciling the same workflow **duplicate pod creations and clobber status**. | Argo's failover = control-plane migration with the durable state in etcd instead of a run dir. Its explicit warning — *two controllers on one workflow = duplicate work + clobbered status* — is the canonical statement of piflow's §5 **split-brain** hazard (laptop + VM both driving the run); Argo's fix (a single-writer lease) is exactly the mitigation piflow should adopt (the G4 `run.lock` lease). | [Argo-HA], [Argo-ctl] |
| **Flyte** (orchestrator) | **Node executions + cached task outputs** in the control plane / DataCatalog. Handoff trigger: explicit **`RecoverExecution`** (or `flytectl … --recover`) after a failure, incl. **loss of the K8s cluster**. In-flight: a **new execution copies all SUCCEEDED node executions and runs only failed/unreached nodes**; **inputs and workflow version cannot change** in recover mode. | Almost a 1:1 spec for piflow migration: "copy completed nodes, run only the unreached frontier, on a *new* cluster." piflow's equivalent of "inputs/version frozen" is the journal's `source` guard (refuse a journal whose `wf.meta.name` ≠ template) + the envelope hashes detecting any drift. Sub-task `@flyte.trace` recovery ↔ piflow's per-node granularity. | [Flyte-exec], [Flyte-recover] |
| **LangGraph** (agent runtime) | **Checkpointer** persists thread state per superstep + **pending writes** at the node level, keyed by `thread_id` (+ optional `checkpoint_id`); pluggable backend (memory/SQLite/Postgres). Handoff trigger: interrupt or crash; resume by re-invoking with the same `thread_id`. In-flight: completed nodes in a superstep have durable pending writes and **are not re-run**; the node that was interrupted **restarts from its beginning** (durability mode `sync` vs `exit` trades performance for crash-safety). | A different control plane re-attaches to the same run by pointing at the same durable state — `thread_id` ↔ piflow's run id / run dir; pluggable checkpointer ↔ the run dir being the only state any control plane needs. "Interrupted node restarts from the beginning" ↔ piflow's §4 abort-and-re-run of the boundary node; `sync` vs `exit` ↔ piflow journaling only at a terminal-good verdict. | [LG-persist], [LG-ckpt] |
| **CRIU** (process C/R migration) | A frozen process's **full memory + state dumped to image files**. Handoff trigger: explicit dump (leave stopped), copy images, restore on the destination. In-flight: requires **the same files available on both nodes** (shared FS or rsync) and the IPs/sockets to rebind, else restore fails; freeze time grows with memory. | The *anti-pattern* that clarifies piflow's choice: piflow does **NOT** migrate the live `pi` process's memory (CRIU-style). It migrates **durable artifacts + the journal** and re-spawns fresh `pi` processes on the VM — far simpler and robust to a heterogeneous host. CRIU's "files must exist on both sides" ↔ piflow's "snapshot the run dir into the VM"; CRIU's socket-rebind fragility is exactly what artifact-level handoff avoids. | [CRIU-live], [CRIU-repo] |
| **tmux + mosh** (detach UX analogy) | Server-side **session persists** independent of the client; the process tree keeps running after disconnect. Handoff trigger: client detach / network drop; mosh roams across IP changes. In-flight: nothing stops — you **re-attach later from any new connection** and pick up where you left off. | The exact **UX contract** of detach-and-reattach the migration delivers to the user ("close the laptop, re-attach as observer"). The difference: tmux keeps the *same* process on the *same* host; piflow moves the control plane to a *new* host while preserving the same re-attach feel via `observe`. The control-session mirror is piflow's "tmux for a run." | [Moshi-tmux], [Hoop-ssh] |
| **Devin Cloud `/handoff`** (detached agent product) | A local CLI session; handoff **packages the conversation context + git branch + uncommitted diff** and creates a **cloud session in a fresh VM** that "picks up where you left off"; track from the terminal or web app. Tagline: *"Close your laptop. Come back to finished PRs."* | The closest *product* analogue to this feature's UX and the literal mechanism: bundle the in-progress state (for piflow: run dir + journal + template + scoped creds), boot a fresh cloud VM, continue, re-attach to observe. Validates the "package the WIP, hand to a cloud VM, detach" shape — piflow's advantage is a *deterministic frontier* (the journal) rather than re-seeding an LLM with prose context. | [Devin-cloud], [Devin-handoff] |

Coverage: 13 systems across all three categories (5 durable-exec, 4 orchestrators, 4 process/agent-runtime
migration & detach) — exceeds the ≥8 / three-category bar.

---

## 4. The cleanest handoff mechanism for piflow

The cleanest mechanism reuses piflow's own primitives end-to-end: **freeze at a node boundary → snapshot the
run dir → boot + stage the control-VM → resume `--from <frontier>` inside it → laptop re-attaches as an
observer.** Executable-grade sequence:

**Phase 0 — arm (laptop, while the run is live).**
- User issues the migration intent (`piflowctl run … --migrate-to control-vm`, or a control-session `/intent
  {migrate:"control-vm"}` written to `.pi/control/<seq>.json` — the existing courier the runner already owns,
  `control-session-mirror.md` §"two classes"). The **runner is the sole authority**; the control-pi never
  pokes runner internals.
- The runner sets a "migrating" flag and **stops scheduling new nodes**, finishing only what's already
  dispatched. This obeys `ARCHITECTURE.md` §5: structural transitions happen **at a seam (node boundary),
  never mid-node**.

**Phase 1 — the node-boundary freeze (the load-bearing decision).** At the migration instant either zero or
some nodes are mid-flight. **Decision: finish-the-current-stage-then-migrate for clean cut, with abort+resume
as the fallback** — concretely:
- **Default — drain to the next barrier (finish-then-migrate).** Let the in-flight node(s) of the current
  stage run to a terminal verdict and journal normally (`finishNode` writes the entry only on a good verdict,
  `wiring-g4-resume-journal.md` §4d). The migration cut is the **stage barrier** — the same point
  `state.json` is already persisted (`state.ts:76`). This is the cleanest boundary and matches LangGraph's
  superstep-boundary checkpoint [LG-ckpt] and DF's await-boundary checkpoint [ADF-overview].
- **Fallback — abort-and-re-run the boundary node.** If draining is too slow or a node is wedged, **kill the
  in-flight node and DO NOT journal it** (a non-terminal verdict writes nothing, §4d.1). On the VM, G4
  `decideResume` sees "no journal entry" for that node → it (and its descendants) `RUN`. This is exactly DBOS's
  "in-progress step is retried" [D-durability] and LangGraph's "interrupted node restarts from the beginning"
  [LG-ckpt]. **Never** finish-on-the-VM a node that *started* on the laptop — re-run it, because piflow does
  not migrate live `pi` memory (the CRIU anti-pattern, [CRIU-live]). The frontier is therefore always a clean
  set of *completed* node outputs.
- **Node-boundary semantics (name them):** the migration cut = a **stage barrier**; the **frontier** = the
  first stage with any non-`reused`/non-`ok` node; the boundary node = the first incomplete node, which is
  **re-run on the VM, never resumed mid-execution**. "Exactly-once" across the boundary means: a node is
  journaled (and thus skipped) **iff** it reached a terminal-good verdict *before* the cut — the journal write
  is the commit point.

**Phase 2 — snapshot the handoff bundle (laptop).** Collect the durable state that *is* the run:
- `${RUN}/.pi/` — `run.json`, `state.json`, **`journal.json`** (the skip/run oracle), `.pi/control/` (so the
  VM honors pending intents). These are atomic-written (`status.ts`, §4d) so a snapshot is never torn.
- All on-disk **artifacts** the completed nodes produced (the inputs the frontier will consume).
- The **template** (`.piflow/<wf>/template/`) + resolved run args (so the VM can recompile the identical DAG;
  the journal `source` field guards a mismatch, `wiring-g4-resume-journal.md` §3,§5.7).
- A **scoped credential set** for the VM (Phase 3).
This bundle is exactly what the provider seam already stages for a node (`putFiles` + env), one level up
(`detached-run-control-vm.md` §"Why B is cheap").

**Phase 3 — boot + stage the control-VM.** Reuse `@piflow/e2b`/`@piflow/daytona` *at the control level*:
- Boot a control-VM from the piflow-CLI image (`deploy/<provider>/`, MINIMAL+ tier:
  node22 + pi + git, `multi-provider-sandbox-portability.md` §2B).
- `putFiles` the handoff bundle into the VM run dir; `stageHome` the scoped `models.json` (`$VAR` refs only,
  `credential-architecture.md` §4.4).
- Mint the VM's **own provider credential** scoped + TTL-bounded via `SecretResolver({isCloud:true})` rather
  than forwarding the raw long-lived E2B/Daytona key (`detached-run-control-vm.md` §3.1,
  `credential-architecture.md` §3). v1 may forward; v2 mints.

**Phase 4 — resume inside the VM (the frontier resume).**
- The VM runs `piflowctl run <template> --sandbox <e2b|local> --from <frontier-stage>` (or, once G4 is wired,
  *no* `--from` — the **journal makes resume fully automatic and safe**, `wiring-g4-resume-journal.md` §4e).
- G4 `decideResume` consults `journal.json`: completed nodes whose envelope + input-content-hashes match are
  `REUSE`d (their artifacts came in the bundle); the frontier and anything tainted by an upstream change
  `RUN`. **Per-node capability isolation is preserved** — each frontier node still spawns its own `pi` with
  exactly its `--tools` + sandbox profile (`per-node-capability-isolation.md`); migration moves the
  *orchestrator*, not the per-node boundaries.
- The control-VM owns a **run-level TTL/budget** so an abandoned run self-destructs
  (`detached-run-control-vm.md` §3).

**Phase 5 — laptop detaches → re-attaches as observer.**
- Once the VM reports "resumed at <frontier>," the laptop's local runner exits cleanly (it is no longer the
  authority; the run dir's `run.lock` lease, §5, transfers to the VM).
- The VM exposes the run-view + control-session over the existing bridge bound to a port; the laptop
  re-attaches via a **base-URL swap + bearer token over an authenticated reverse proxy**
  (`control-session-mirror.md` §"Local==cloud", `control-session-streaming-spec.md` §4). The GUI client is
  **byte-identical** local vs cloud. Observation is one-way and idempotent — re-attach any time, get a
  snapshot-then-deltas (`control-session-mirror.md` §readers). This is the tmux/mosh re-attach contract
  [Moshi-tmux] realized over `observe`.

---

## 5. Failure modes & mitigations

Each = the hazard + a concrete mitigation tied to a piflow seam.

1. **Split-brain (two control planes drive one run).** The laptop's runner and the VM's runner both schedule
   nodes against the same run dir → duplicate node spawns + clobbered `run.json` (Argo's exact warning,
   [Argo-HA]). **Mitigation:** a **single-writer lease** — adopt G4's optional `${RUN}/.pi/run.lock` (PID
   liveness + stale reclaim, `wiring-g4-resume-journal.md` §4d.4). Migration is a **lease handoff**: the
   laptop releases the lease only after the VM acquires it; the laptop runner exits before the VM starts
   scheduling (§4 Phase 5). No node runs without holding the lease.

2. **Exactly-once on the boundary node** (the node mid-flight at the cut runs on *both* sides, or on neither).
   **Mitigation:** the journal write *is* the commit point (§4 Phase 1): a node is skipped on the VM **iff** it
   reached a terminal-good verdict and was journaled before the cut (`finishNode` gated on `status==='ok'`,
   §4d.1). A node aborted on the laptop is **not** journaled → re-runs on the VM (at-least-once for that one
   node, never-both-finish). Idempotency for downstream is protected by G4's input-content-hash check — a
   re-run that produces byte-identical output lets descendants reuse (`wiring-g4-resume-journal.md` §5.6).

3. **Partial / torn artifacts in the snapshot.** A node was writing an artifact when the cut fired → the VM
   stages half a file and a frontier node consumes garbage. **Mitigation:** `outputHashes` are computed only
   **after** `downloadDir` + the verify gate (`wiring-g4-resume-journal.md` §4d.3), and a node is journaled
   only on a terminal-good verdict — so a half-produced artifact is never recorded as good; on the VM its
   content hash won't match (or there's no entry) → the producing node re-runs. `run.json`/`journal.json`
   themselves are atomic `tmp`+`rename` with a `.bak` fallback (`status.ts:129`), so the snapshot is never a
   torn control file.

4. **Orphaned child sandboxes / a leaked detached run.** If the **control-VM** dies after migration, its
   child node-VMs leak (`RunScope.dispose` only fires from a live control plane,
   `detached-run-control-vm.md` §3). And if the **laptop** dies *during* Phase 1–4 (before the VM owns the
   run), the run is stuck `running` with nobody driving it — Prefect/Airflow's "zombie eats a concurrency
   slot" failure [P-16746][AF-tasks]. **Mitigation:** `autoStopInterval` guards at **both** levels + a
   run-level **TTL/budget the control-VM owns** so an abandoned run self-destructs
   (`detached-run-control-vm.md` §3–§4); a **heartbeat** (Airflow/Prefect zombie-reaper pattern,
   [AF-tasks][P-16746]) — if the VM stops heartbeating, a reaper tears its `RunScope`; if the laptop dies
   mid-handoff before the lease transfers, the lease's PID-liveness reclaim (mitigation 1) lets a re-launched
   laptop runner re-acquire and continue locally.

5. **Nested-credential exposure on the control-VM.** The VM needs the long-lived provider key (E2B/DAYTONA)
   to spawn child sandboxes — a high-value infra secret now living in a cloud VM (`detached-run-control-vm.md`
   §3.1). **Mitigation:** mint a **short-lived, scoped, TTL-bounded** provider token via
   `SecretResolver({isCloud:true})` instead of forwarding the raw key (`credential-architecture.md` §3); the
   VM never inherits host `process.env` (only the explicit allowlist via `cloudCredEnvAdditions`,
   `daytona.ts:261`); staged `models.json` carries `$VAR` references only, never a resolved secret
   (`credential-architecture.md` §4.4). v1 forward-with-TTL, v2 mint-scoped — and **never** the trifecta on
   one node (`per-node-capability-isolation.md` §1).

6. **Observe re-attach gap / dropped client.** The laptop disconnects and a late re-attach (or a flaky cloud
   link) misses deltas, or two observers double-poll the cloud `.pi` tree. **Mitigation:** `watchRun` is
   **snapshot-then-delta** and readers are **unlimited + idempotent** (`control-session-mirror.md` §readers),
   so any re-attach re-bases from a fresh snapshot; the bridge **fans one upstream to N SSE subscribers**
   (dedup-the-tap, `control-session-streaming-spec.md` §5.1) so a second observer never re-polls; EventSource
   auto-reconnect + backoff + the bridge's existing `:ping` heartbeat
   (`control-session-streaming-spec.md` §5.3). Cloud adds the bearer-token reverse proxy as the only auth
   boundary (`control-session-mirror.md` §"Local==cloud").

7. **Non-determinism / drift across the move.** A node legitimately varies run-to-run, or the template/env on
   the VM differs from the laptop, so a "reused" decision is wrong — the failure mode Restate, DF, and Flyte
   all warn about ([R-manage] non-determinism error; [ADF-constraints]; [Flyte-recover] "inputs/version cannot
   change"). **Mitigation:** the **envelope hash** (realized prompt + tools + **model** + contract) and
   input-content-hashes make drift *visible* — a changed prompt/tool/model on the VM flips the hash → re-run,
   not silent stale reuse (`wiring-g4-resume-journal.md` §4a, §5.3); the journal `source` field refuses a
   wholesale template swap (§5.7). **Caveat (open):** until G1 lands, the hash uses run-level `ctx.model`, so
   a *per-node* model swap between hosts is invisible — pin the run-level model identical across the move, or
   gate migration on G1 (§6 open questions).

8. **Cost runs invisible after detach.** You can't watch spend live once the laptop is closed, so a runaway
   loop burns money unnoticed (`detached-run-control-vm.md` §4). **Mitigation:** the control-VM emits a
   **run budget + a "still-alive / $spent" heartbeat** to `~/.piflow/` or a bucket the laptop polls on
   re-attach; the run-level TTL/budget (mitigation 4) is the hard backstop.

(8 failure modes; exceeds the ≥6 bar. Mitigations 1, 2, 3, 5, 6, 7 each name a specific piflow seam by file or
mechanism.)

---

## 6. Recommendation

**Build a thin migration layer on top of architecture B; do not invent new durability.** The run dir + G4
journal already give cross-machine resume — migration is *packaging + a node-boundary trigger + a lease
handoff + the cloud-reattach handle*, in that priority order.

**Minimal v1 (ship first):**
1. **Node-boundary freeze + handoff bundle.** A `--migrate-to <control>` intent (via the existing courier) that
   sets the migrating flag, **drains to the next stage barrier** (§4 Phase 1 default), and snapshots
   `${RUN}/.pi/` + artifacts + template into a bundle. Reuse `finishNode`'s journal-on-good-verdict; abort+re-run
   is the wedged-node fallback. *(net-new item 1+2 from §2.)*
2. **Boot + stage + resume on the control-VM**, degrading to `--sandbox local` inside the VM (cheap, no nested
   VMs — `detached-run-control-vm.md` §C-degrade) so the **whole feature is demonstrable without nested-VM
   credentials**: snapshot → boot → `piflowctl run --from <frontier>` → it finishes. This is the headline
   "close the laptop, it runs."
3. **Single-writer lease handoff** (`run.lock`) so the laptop and VM never both drive — the one correctness
   non-negotiable (Argo split-brain, §5.1). Adopt G4's lease verbatim.
4. **Re-attach as observer over the existing SSE feed**, local-first; v1 can poll a synced run dir if the
   reverse-proxy handle isn't ready.

**Later (v2+), by sequence:**
- **Scoped provider credential for the control-VM** (mint, not forward) — required before the VM spawns *child
   cloud* sandboxes (§5.5); until then, degrade-to-local sidesteps it.
- **The cloud-reattach handle** (bearer token + authenticated reverse proxy in front of the bridge port) — the
  "main net-new surface" per `detached-run-control-vm.md`; promote from run-dir-polling to live SSE.
- **Detach heartbeat + run-level TTL/budget + orphan reaper** at both levels (§5.4, §5.8).
- **Live-node drain vs. abort policy** as a per-run flag once measured.

**Explicit open questions for the team:**
- **Drain vs. abort default at the cut** — finish-the-stage (cleaner, possibly slow) vs. abort-and-re-run the
  boundary node (faster, re-runs one node). §4 recommends drain-default; confirm against typical node
  durations.
- **G1 dependency for model fidelity** — should migration be *gated* on G1 (per-node model in the envelope
  hash, §5.7) or ship now with a "model must be identical across hosts" precondition?
- **Where the observability handle lives** — control-VM self-serves the bridge port vs. a run-dir sync to a
  bucket/`~/.piflow/` the laptop polls (`detached-run-control-vm.md` §2 lists both); which is v1?
- **Can you migrate *back* (VM → laptop)?** The mechanism is symmetric (it's just a lease handoff + bundle), but
  is it a real use case or scope creep?
- **Template/credential drift detection** — beyond the journal `source` guard, do we hard-fail if the VM's
  resolved env differs from the laptop's (Flyte's "version cannot change" stance) or warn-and-proceed (Restate's)?
- **Mid-fusion-stage migration** — fusion clusters expand a stage into a sub-DAG; is a fusion expansion a safe
  cut boundary, or must migration wait until the whole fusion stage completes? (Verify against the
  fusion-expansion semantics; not covered by the docs read here — **flagged, not invented**.)

> Note: `docs/design/detached-run-control-vm.md` covers *launching* detached from the start; it does **not**
> specify a *mid-run* trigger, the freeze/drain semantics, or the lease handoff. Those (§4 Phases 0–1, §5.1)
> are the genuine net-new design this doc contributes and are recorded as such, not assumed present.

---

## 7. Sources

piflow (local, read while writing): `docs/design/detached-run-control-vm.md`;
`docs/specs/wiring-g4-resume-journal.md`; `docs/design/multi-provider-sandbox-portability.md`;
`docs/design/credential-architecture.md`; `docs/design/control-session-mirror.md`;
`docs/design/control-session-streaming-spec.md`; `docs/research/2026-06-27-per-node-capability-isolation.md`;
`docs/ARCHITECTURE.md`.

External:
- [T-workers] Temporal — What is a Worker? (stateless, resurrect on same/different worker) <https://docs.temporal.io/workers>
- [T-history] Temporal — Event History / replay <https://docs.temporal.io/encyclopedia/event-history> · <https://docs.temporal.io/workflows>
- [R-manage] Restate — Managing Invocations (pause / resume on a different deployment / restart from prefix) <https://docs.restate.dev/services/invocation/managing-invocations>
- [R-protocol] Restate — Service Invocation Protocol (the invocation journal) <https://github.com/restatedev/service-protocol/blob/main/service-invocation-protocol.md>
- [R-blog] Restate — A remote control for your agents (pause/restart-from-step) <https://www.restate.dev/blog/a-remote-control-for-your-agents>
- [D-arch] DBOS — Architecture / Workflow Recovery <https://docs.dbos.dev/architecture>
- [D-durability] DBOS — Durability (skip completed, retry in-progress; distributed recovery via Conductor) <https://dbos-inc-dbos-transact-py.mintlify.app/concepts/durability>
- [ADF-constraints] Azure Durable Functions — orchestrator code constraints (event sourcing / replay determinism) <https://learn.microsoft.com/en-us/azure/azure-functions/durable/durable-functions-code-constraints>
- [ADF-overview] Azure Durable Task — orchestrations overview (unload-from-memory + replay) <https://learn.microsoft.com/en-us/azure/durable-task/common/durable-task-orchestrations>
- [DF-paper] Burckhardt et al. — Durable Functions: Semantics for Stateful Serverless (record-replay model) <https://www.microsoft.com/en-us/research/wp-content/uploads/2021/10/DF-Semantics-Final.pdf>
- [I-exec] Inngest — How Functions Execute (step memoization; runs on your compute over HTTP) <https://www.inngest.com/docs/learn/how-functions-are-executed>
- [I-durable] Inngest — Durable Workflows (step.run checkpoints; replay) <https://www.inngest.com/uses/durable-workflows>
- [AF-tasks] Airflow — Tasks (task-instance states; heartbeat-timeout / zombie cleanup; executor_config) <https://airflow.apache.org/docs/apache-airflow/stable/core-concepts/tasks.html>
- [AF-scheduler] Airflow — Scheduler (HA via the metadata DB + row-level locks) <https://airflow.apache.org/docs/apache-airflow/2.5.1/administration-and-deployment/scheduler.html>
- [P-7116] Prefect — Handle flow run restarts caused by infrastructure events (agent not required to resume) <https://github.com/PrefectHQ/prefect/issues/7116>
- [P-16746] Prefect — Mark running flows "Crashed" when a worker goes down (zombie + heartbeat detection) <https://github.com/PrefectHQ/prefect/issues/16746>
- [Argo-HA] Argo Workflows — High Availability (controller failover; leader election; double-reconcile clobber) <https://argo-workflows.readthedocs.io/en/latest/high-availability/>
- [Argo-ctl] Argo Workflows — controller.go (per-workflow key lock; reconcile) <https://github.com/argoproj/argo-workflows/blob/main/workflow/controller/controller.go>
- [Flyte-exec] Flyte — Execution API (NodeExecution phases incl. RECOVERED; RecoverExecution) <https://mintlify.wiki/flyteorg/flyte/api/execution>
- [Flyte-recover] Union.ai — Build Indestructible Pipelines with Flyte (recovery mode: copy SUCCEEDED nodes, run from failure; inputs/version frozen) <https://www.union.ai/blog-post/build-indestructible-pipelines-with-flyte>
- [LG-persist] LangGraph — Persistence (checkpointers; thread_id; resume after interruption) <https://docs.langchain.com/oss/python/langgraph/persistence>
- [LG-ckpt] LangGraph — Checkpointers (pending writes per node; sync vs exit durability; node restarts from beginning) <https://docs.langchain.com/oss/javascript/langgraph/checkpointers>
- [CRIU-live] CRIU — Live migration (files must exist on both nodes; freeze + dump + restore) <https://criu.org/Live_migration>
- [CRIU-repo] CRIU — project overview / P.Haul <https://github.com/checkpoint-restore/criu/>
- [Moshi-tmux] Moshi — tmux as the persistent host workspace (detach/reattach across SSH/mosh) <https://getmoshi.app/docs/tmux>
- [Hoop-ssh] hoop.dev — The SSH session died, but the code kept running (mosh + tmux detach/roam) <https://hoop.dev/blog/the-ssh-session-died-but-the-code-kept-running/>
- [Devin-cloud] Devin Cloud — "Close your laptop. Come back to finished PRs." <https://devin.ai/cloud/>
- [Devin-handoff] Devin CLI — Hand off to cloud Devins (`/handoff`: packages context + branch + diff → fresh cloud VM) <https://docs.devin.ai/cli/handoff>

---

## Self-check (Required bar)

| Bar item | Verdict | Evidence |
| --- | --- | --- |
| (1) every surveyed system has a source URL + a piflow-specific mapping | PASS | §3 table: 13 rows, each with a "Maps to piflow" cell (not generic) and a `[ref]` resolved in §7. |
| (2) §2 cites SPECIFIC piflow mechanisms by name | PASS | §2 names `${RUN}/.pi/run.json` (`writeStatus` `status.ts:129`), `state.json` (`state.ts:76`), G4 `journal.json` + `decideResume` (`wiring-g4-resume-journal.md` §4b/§4c), `--from`/`selectWindow` (`runner.ts:276,938`), `SandboxProvider`/`RunScope`, `cloudCredEnvAdditions`, `stageHome`, `SecretResolver`, drawn from the docs read. |
| (3) §4 is executable-grade incl. the in-flight node decision | PASS | §4 Phases 0–5; Phase 1 names drain-default vs abort+re-run fallback, the stage-barrier cut, the frontier, and "never finish-on-VM a node that started on the laptop" with the CRIU rationale. |
| (4) ≥6 failure modes, each mitigation tied to a piflow seam | PASS | §5 lists 8: split-brain→`run.lock` lease; exactly-once→journal-as-commit; torn artifacts→`outputHashes` after collect; orphan/heartbeat→`autoStopInterval`+TTL+reaper; nested creds→`SecretResolver` scoped+`cloudCredEnvAdditions`; observe re-attach→snapshot-then-delta+dedup-the-tap; drift→envelope hash+`source` guard; cost→heartbeat. |
| (5) extracts the cleanest mechanism FOR piflow + honest about net-new | PASS | §2 right column marks EXISTS vs net-new; §2 lists the 20% net-new; §6 v1 vs later; §6 note flags that the *mid-run trigger / freeze / lease handoff* is genuinely new vs the existing detached-from-start doc. |
| ≥8 systems across 3 categories | PASS | §3: 5 durable-exec + 4 orchestrators + 4 process/agent-migration = 13. |
| Must NOT design per-node simultaneous mixed-backend | PASS | Scope fence in the header + §1; the doc treats migration as a single run-level move at a node boundary. |
| Must NOT write/modify code or fabricate citations / piflow contents | PASS | Only this markdown written; every piflow claim cites a doc read this session; the fusion-stage cut and the mid-run trigger are flagged as open/net-new, not invented. |
