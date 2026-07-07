# piflow-fixer skill refresh — plan

Read-only research doc. No skill/code edits. Canonical editable copy of the skill:
`.claude/skills/piflow-fixer/` (SKILL.md + `references/{triage,demand-levers,verification,orchestrator,
playbook-maintenance}.md`). Confirmed byte-identical to the global install (`~/.claude/skills/piflow-fixer`,
`diff -rq` clean) — no divergence to reconcile.

**The single biggest finding, read before anything below:** the repo has grown a fully-built, code-level
**optimize-substrate pipeline** (`packages/cli/src/{optimize-substrate,issues,runs}.ts` +
`packages/core/src/optimize/substrate/{issues,fix,judge,measure,agent,child-run}.ts`,
docs/specs/optimize-substrate-plan.md) since this skill was last written. It already implements — in CODE,
not prose — most of the corrected lifecycle: a durable per-issue ledger with a real status machine, a
candidate-copy fixer turn, a strict-improvement gate, and a staged-manifest adopt step. `fix.ts:391,399`
literally names **`FIXER_SKILL = 'piflow-fixer'`** and stages it as the fixer's playbook for every automated
turn — so this skill is not describing a hypothetical process, it is the prompt riding inside a real driver.
The corrected-model directive ("mature the skill for companion-mode / human-gated use, NOT the automated
pipeline") reads, against this code, as: **the automated single-turn path is fine as a fast path; the skill's
prose currently only describes that path (or an even older by-hand one) and needs a second front door for a
full agentic companion session that owns retry/escalation itself.**

---

## 1 · LIFECYCLE SPEC — the corrected open→closed contract

**One sentence:** the fixer is handed ONE open issue (by companion-mode context today, by an
`optimize fix --issue <name>` dispatch tomorrow) and drives it to `resolved` or an honest `blocked`/
`escalated` terminal state; it does not mint issues, does not re-triage severity, and does not run the
node's own runtime lifecycle — only the issue's.

### 1.1 The two front doors (both must exist; only one exists in prose today)

| Front door | Trigger | Current skill coverage |
|---|---|---|
| **A — issue-packet** (the future/automated path) | Handed `nodes/<node>/issues/<name>.md` — literally `fixIssue()`'s single candidate-copy turn (`fix.ts:481-602`), OR a human pointing at one issue by name (`piflowctl issues show <name>`) | SKILL.md:16 ("You are handed ONE issue…") — **this is the ONLY door written today** |
| **B — companion context** (today's reality, per directive) | Handed a run/node + performance data and told "solve the problems here" — no issue file exists yet | **MISSING.** Nothing in SKILL.md or references/ names this entry point. |

Door B's FIRST step, before any fix, is self-triage the situation (not the four-way LAPSE/SKILL kind of
triage — a plain "what am I even looking at" pass): run the performance-forensics ladder
(`piflow-inspect` skill) over the handed run/node, THEN decide whether an issue already exists
(`piflowctl issues list --node <id>`) or must be drafted informally in the companion session's own working
notes (never minted as a ledger file — minting is triage's job, see §4). Concretely this is
`piflowctl telemetry` → `piflowctl trace` (on a stall/anomaly) → `piflowctl issues list --node <id>`
(recurrence check) → `piflowctl understand <subsystem>` / `piflowctl memory find` (grounding) — see §2 for the
exact verbs and where each line of the skill should name them instead of "consult memory"/"the practices
library" as bare nouns.

### 1.2 Issue-dependent rerun (currently always-on in prose; already a real code knob, but node-agnostic)

- **Code reality:** `FixIssueOpts.prove` (`fix.ts:423-424`) is a boolean, default `true`; the CLI surfaces it
  as a **pass-wide** flag, `--no-prove` (`optimize-substrate.ts:205`, `parseSubstrateFixArgs`) — it turns
  proving off for every issue selected in that invocation, not per-issue.
- **Gap vs. the directive:** "some issues force a frozen rerun … some (e.g. a routing-only fix) do not" wants
  this read OFF THE ISSUE, not off a CLI flag applied to a whole batch. Today's `Issue` frontmatter
  (`issues.ts:67-88`, the fixed `FRONTMATTER_KEYS` at `issues.ts:95`) has NO field for it — there is no
  `requiresRerun`/`proveDefault` key, and adding one is a schema change to a system already reconciled and
  merged (out of THIS plan's scope to author, but it is the concrete missing piece — see §5 GAP-1).
- **Skill-level fix, without a schema change:** the fixer can still make this issue-DEPENDENT in prose today
  by reading the issue's OWN evidence: a fix whose demand lever is pure ROUTING (tier/model/provider bump —
  the LAPSE case, `references/triage.md:24-26`) or a wiring-only change with no behavior-affecting write
  inside the node's read/exec closure does not need a rerun to prove it; anything touching a demand lever
  that changes what the node reads/does DOES. Replace the current blanket "Leave the edits on disk; the
  harness re-runs the node" (SKILL.md:127) with a branch naming this test, and cite `--no-prove` as the
  companion-mode override for the no-rerun-needed case.

### 1.3 Fixing limit (circuit breaker / edit-budget cap)

- **Code reality:** `--cap N` (`optimize-substrate.ts:172-173, 204`, `DEFAULT_FIX_CAP = 5`) caps how many
  ISSUES one `optimize fix` pass selects — it is a per-PASS worklist cap, not a per-ISSUE retry ceiling.
  Nothing in `fixIssue()` counts prior attempts at THIS issue; the only per-issue history is `attempts[]`
  (`issues.ts:59-64, 84-85`), which is **append-only and written ONLY on a landed (adopted) fix**
  (`issues.ts:281-286`, `fix.ts:663`) — a discarded/rejected attempt leaves no ledger trace at all beyond the
  status walking `verifying → open` (`fix.ts:566-570`). **There is no visible "attempted and failed N times"
  signal anywhere the fixer can read.** This is GAP-2 (§5) — a real capability hole, not a prose fix.
- **Skill-level mitigation today:** the fixer must keep its OWN count within the single session/turn it
  occupies (companion mode is one continuous agentic session, so an in-session counter is sufficient there);
  the existing `references/orchestrator.md:60-62` "Circuit breaker … a hard ceiling on total rounds/spend per
  issue" already states the LAW, it is just scoped as an "across cycles" property of a separate orchestrator
  role (§6 below) rather than something the single-issue fixer enforces on itself when there is no
  orchestrator wrapping it (companion mode). Pull this rule forward into the fixer's OWN lifecycle section
  (a new Step in SKILL.md, not just orchestrator.md).

### 1.4 Escalation ladder (retry → research sub-agents → honest fail)

**This already exists almost verbatim** — it is currently written as the fixer's OWN conduct rule, not (yet)
wired to the fixing-limit-on-the-goal:
> `SKILL.md:146-151` "## The fixer's own conduct — retries and tripwires … NEVER resubmit a failed call
> byte-identical; each retry changes exactly ONE variable … ≤3 retries per failure, then climb the ladder:
> steer → research → alternative route → escalate WITH evidence."
>
> `references/orchestrator.md:48-58` (§Tripwires) — the fuller version, with the ladder IN ORDER: "steer
> (adjust the approach) → research (docs/library/memory) → alternative route → escalate WITH evidence.
> Never skip to escalation without the evidence."

**The gap is narrower than it looks:** today's ladder is written for a **tool call** failing (a bad edit, a
bad read) — "retry" there means "retry the mechanical action." The directive's ladder is one order of
magnitude UP: "retry" means **re-attempt the WHOLE fix** when the post-verify signal doesn't fire (the
promised optimization is not observed), THEN escalate to research sub-agents, THEN report honest failure as
an explicit terminal state. `references/orchestrator.md:69-72` ("Stuck ⇒ diversify, never deepen: fan out
2–3 genuinely DIFFERENT candidate fixes…") is the closest existing analogue, but it is written for the
ORCHESTRATOR fanning out multiple SUBAGENTS across a cycle, not for the single fixer inside a companion
session escalating to ITS OWN spawned research sub-agents mid-turn. Both ladders should end up cross-
referenced (mechanical retry vs. goal-level retry), and the goal-level one needs the explicit "report the
optimization/quality as NOT achieved" terminal — today's closest line is `SKILL.md:124`: "the fixer
'understood deeply' but committed no edit → a failed attempt — judge fixers by edits landed + gates passed,
never diagnosis eloquence," which names the SYMPTOM (no edit) but not the AGENT-FACING obligation to say so
out loud as a first-class outcome (it's implicit in the facade table, not a directive).

### 1.5 What the fixer does NOT do (confirms, does not change, current scope)

- **No triage/issue-naming.** Confirmed: `judge.ts` (the M4 soft-judge stage) already owns minting/reopening
  issues with severity/sig/status (`judge.ts:9-14`, "an agent-authored DRAFT … is identity-stamped into a
  full Issue"). The skill's Step 0/Step 1 (SKILL.md:36-54, "naming a defect," the LAPSE gate) DUPLICATES
  work the separate `optimize triage --node <id>` verb (`optimize-substrate.ts:318-363`) already performs
  before the fixer is ever invoked. See §4 (SCOPE EVICTIONS) — this is the single biggest prose cut.
- **No node lifecycle management.** Confirmed nowhere in the skill does it touch `piflowctl node --rerun`'s
  status bookkeeping or a node's own runtime contract — it edits candidate FILES only. No change needed here.

---

## 2 · CLI TOUCHPOINTS

### 2.1 The authoritative current verb list (verified against `packages/cli/src/cli.ts`, the live HELP text)

| Verb | Answers | Invocation | Source |
|---|---|---|---|
| Run health | which node/stage failed, verified on disk | `piflowctl status <rundir> [--every <s>]` | `cli.ts:77` |
| Finish/die sentinel | one line on done/fail/dead-stall | `piflowctl watch <rundir> [--notify]` | `cli.ts:78` |
| Cost/loop/anomaly digest | verdicts · tokens in/out · ctx% · calls · retry loops · anomalies · per-turn table | `piflowctl telemetry <rundir> [nodeId] [--watch] [--verbose] [--json]` | `cli.ts:79-81` |
| Context composition | the exact element tree reaching the model: injected prompt + every read/edit, coverage, blind spots, re-reads | `piflowctl trace <rundir> [nodeId] [--json]` | `cli.ts:82-85` |
| Classic read-only score+triage | folds telemetry × verify outcome → the four-way (LAPSE/SKILL/FUNCTIONALITY/ARCH) worklist (the OLDER, whole-run system — distinct from substrate) | `piflowctl optimize <rundir> [--json] [--archetype <n>]` | `cli.ts:86-88` |
| **Substrate: mint/reopen issues** (measure THEN judge) | scores ONE node's finished run(s) → issue files under `nodes/<id>/issues/*.md` | `piflowctl optimize triage --node <id> [--run <id> \| --topk K]` | `cli.ts:98-101`, `optimize-substrate.ts:318-363` |
| **Substrate: fix a node's issues** | candidate copy → ONE fixer turn per issue → (issue-dependent-in-spirit, currently pass-wide) prove → strict-improvement gate → STAGE a manifest | `piflowctl optimize fix --node <id> [--issue <name> \| --status open,regressed] [--watch] [--cap N] [--no-prove]` | `cli.ts:102-105`, `optimize-substrate.ts:399-464` |
| **Substrate: full loop** | triage THEN fix, default selector | `piflowctl optimize --node <id> [--run <id> \| --topk K]` | `cli.ts:106`, `optimize-substrate.ts:473-476` |
| **Substrate: land** | backup-then-overwrite the live file(s) from a candidate, commit, stamp attempt, resolve the issue | `piflowctl optimize adopt --manifest <path> [--template <d>] [--backup-dir <d>]` | `cli.ts:107-108`, `optimize-substrate.ts:501-545` |
| **Issue ledger query (READ-ONLY)** | list/show the per-node issue ledger, severity-desc/firstSeen-asc | `piflowctl issues <list \| show <name>> [--node <id>] [--status <csv>] [--json]` | `cli.ts:150-151`, `issues.ts:69-115` |
| **Cross-run summary** | which node ran fresh, ok/error, since when — child (replay) runs indented under parent | `piflowctl runs [--node <id>] [--status ok\|error] [--since <days\|ISO>] [--json]` | `cli.ts:152-153`, `runs.ts:1-40` |
| Per-node standing lessons | recurrence count, root/prevention, `[[okf-slice]]` pointer — the LAPSE-vs-SKILL signal | `piflowctl memory find <templateDir> [--node <id>] [symptom…]` (+ `memory-slices` skill) | `cli.ts:236-238` |
| Lesson freshness | flags code-shifted/dangling `[[okf-slice]]` links | `piflowctl memory check <templateDir> [node…] [--strict]` | `cli.ts:239-241` |
| Code-slice understanding | how a subsystem works / where to change it | `piflowctl understand [subsystem] [--check\|--rebuild]` (+ `okf-slices` skill) | `cli.ts:147, 312-319` |
| Frozen-input comparison rerun | pin upstream artifacts, execute only the node under test | `piflowctl run <templateDir> --baseline <id\|path> --from <node> [--stage-only]` | `cli.ts:182-187` |
| Single-node cold re-exec | force ONE node to re-run in an EXISTING run dir on frozen upstream | `piflowctl node <run> <nodeId> --rerun` | `cli.ts:198-202` |
| Raw event replay | the exact payload of one anomalous turn (last resort) | `piflowctl logs <rundir\|run> [options]` | `cli.ts:109, 321-322` |

**Two DIFFERENT "optimize" systems are live side by side** — the classic whole-run `optimize <rundir>` (the
LAPSE/SKILL/FUNCTIONALITY/ARCH worklist `piflow-enhance` documents at length) and the substrate per-node
`optimize triage/fix/adopt` (the actual issue-file lifecycle this skill is staged into). The fixer skill
today cites neither by name. It should cite the SUBSTRATE row explicitly (that's its literal home,
`fix.ts:391,399`) and mention the classic one only to disambiguate ("if `optimize <rundir>` is what produced
your context instead of an issue file, its worklist ≠ this skill's issue ledger").

### 2.2 Every line in the fixer skill that names a bare file/source instead of a verb

| Current line (quoted) | Replace with |
|---|---|
| `SKILL.md:16` "You are handed ONE issue (`nodes/<node>/issues/<name>.md`)" | Keep for door A; add door B: "…OR handed a run/node context with no issue file yet — see the companion front door below, which starts by finding one: `piflowctl issues list --node <id>`." |
| `SKILL.md:164-166` "Consult first (mandatory): node memory for recurrence (LAPSE vs SKILL) + the rejected/dead-lever record (never re-propose a lever this issue already proved inert), then the practices library" | "`piflowctl memory find <templateDir> --node <id>` (memory-slices skill) for recurrence + the dead-lever record; then the method-library FIND (`cd ~/Desktop/best-designs-for-agentic-system/cards && node _generate.mjs --find "<symptom>"`, piflow-enhance §Library)." |
| `references/orchestrator.md:23` "`MEMORY: <node>/memory.md#<lesson-anchor>` (recurrence state, prior levers tried)" in the dispatch packet | "`MEMORY: piflowctl memory find <templateDir> --node <id>` output (recurrence + dead-lever record), resolved via memory-slices — never a bare `memory.md` path." |
| `references/orchestrator.md:26` "`CODE: <the code-map/okf slice key for the harness region>`" | "`CODE: piflowctl understand <subsystem>` slice key (okf-slices skill) — cite the returned anchor, never re-derive the region by grep." |
| `references/orchestrator.md:52` "≤3 retries per failure, then the ladder IN ORDER: steer (adjust the approach) → research (docs/library/memory)" | "…research: `piflowctl memory find` (has this failed before) + the method-library FIND (a portable pattern) + `piflowctl understand <subsystem>` (how the code actually works) — never re-derive any of the three from scratch." |
| `SKILL.md:127-128` "the harness re-runs the node `--from` this node on FROZEN upstream (upstream reports `reused`, not re-run)" (no verb named) | "`piflowctl run <templateDir> --baseline <run> --from <node>` (frozen-input comparison rerun) OR `piflowctl node <run> <nodeId> --rerun` (single-node cold re-exec) — name which, per §1.2's issue-dependent test." |
| `references/verification.md:20-24` "Copy the baseline run's upstream artifacts … Launch `--from <node-under-test>`" (describes the mechanism by hand instead of citing the shipped primitive) | Cite `--baseline <id\|path> [--stage-only]` directly (`cli.ts:182-187`) — this is now a first-class run primitive (memory: `run --baseline/--stage-only windowed reruns`), not a manual copy recipe. |
| Nowhere today: the companion "check performance + understand" step has NO citation at all | New content (door B, §1.1): `piflowctl telemetry <rundir> [nodeId]` → `piflowctl trace <rundir> [nodeId]` (on anomaly) → `piflowctl status <rundir>` (overall health) → `piflowctl issues list --node <id>` (does an issue already exist) → `piflowctl understand <subsystem>` + `piflowctl memory find` (grounding) — this is exactly the `piflow-inspect` skill's routing table + ladder; the fixer should LOAD `piflow-inspect` for door B, not re-describe the ladder inline. |

### 2.3 A drift worth flagging, not fixing here
`piflow-inspect`'s own routing table (`~/.claude/skills/piflow-inspect/SKILL.md:28-41`) does not mention
`optimize triage --node`, `optimize fix --node`, `issues list/show`, or `runs` at all — it only names the
classic `optimize <rundir>`. If the fixer's companion door routes "has this failed before" partly through
`piflow-inspect`, that skill is itself one step behind the substrate verbs. Flagging for a follow-up, not
folding into this plan (out of the fixer's own file).

---

## 3 · LIBRARY OWNERSHIP (Leg C — consult before, write-back after)

### 3.1 What currently lives where
- **`piflow-enhance/SKILL.md:50-84`** owns the FULL by-hand protocol today: CONSULT (FIND via the cards repo's
  own `_generate.mjs --find`, blocking at the route step) → GAP (research agent + a new card) → WRITE-BACK
  (after a VERIFIED land, one dated Applications line, win OR under-delivery). It also names the "Seam status"
  TODO explicitly: `piflow-enhance/SKILL.md:81-84` — "Autonomous seam TO-BUILD at the CLI only … matched card
  → fixer `DefectScope` beside the Leg-A recurrence + Leg-B code-map … a `[[card:<key>]]` backref in MEMORIZE
  blocks, and the Applications write-back at `optimize --adopt`." **This seam is unbuilt in code** — the
  substrate `fixIssue`/`adoptSubstrateManifest` (`fix.ts`) has NO card-pointer field anywhere in
  `SubstrateManifestRecord` (`fix.ts:336-354`) or `Issue` (`issues.ts:67-88`).
- **`piflow-fixer/references/playbook-maintenance.md:48-55`** (§5, "Library + memory write-back") already
  states the RULE — card Applications line + node `memory.md` by pointer — but frames it as something the
  ORCHESTRATOR does at cycle close (§6, SKILL.md:159-180, step 7), not something the single-issue fixer does
  itself as the LAST step of ITS OWN lifecycle.
- **`piflow-fixer/SKILL.md:153-157`** ("Ledger — leave the record honest") is the closest existing per-fix
  version, and is already correctly pointer-based ("update by POINTER, resolved at read time — never an
  embedded copy that rots"). It is short and un-sequenced relative to the rest of the spine.

### 3.2 Where ownership should move
- **CONSULT** belongs as an explicit early step in the fixer's OWN lifecycle (not just the orchestrator's
  step 3) — right after Step 0 (locate the root) and before Step 2 (route by detector), since the matched
  card can change which demand lever is even considered. Fold `piflow-enhance/SKILL.md:57-68` (the CONSULT
  table + FIND command) into the fixer's Step map as a new reference-map row, rather than leaving it only in
  enhance (which is being de-emphasized for the automated/companion split per the directive).
- **WRITE-BACK** belongs at the fixer's own Verify step (SKILL.md:126-144) as the LAST action before the
  self-check, gated on "verdict = closed" (not merely "edits landed") — today's Ledger section (SKILL.md:153-
  157) is positioned AFTER Verify but before the orchestrator's own step 7, creating a real ambiguity about
  who writes the Applications line when the fixer runs stand-alone (companion mode, no orchestrator wrapping
  it). Resolve this by making the SINGLE-issue fixer always responsible for its own write-back (win OR
  under-delivery, per `piflow-enhance/SKILL.md:76-79`'s exact wording), and have the orchestrator's step 7
  become "audit that every dispatched fixer wrote back" rather than doing the writing itself.
- **What folds in verbatim from `piflow-enhance`:** the CONSULT table (§50-68) and the WRITE-BACK rule
  (§75-79) — both are METHOD-agnostic and belong equally to the automated and companion paths. What does
  NOT fold in: Companion Mode's judging role (`piflow-enhance/SKILL.md:86-89`, judge-vs-gold) — that stays
  with `piflow-enhance` since it is about SCORING an artifact against the criteria fixture, a different job
  than fixing one issue.

---

## 4 · SCOPE EVICTIONS

### 4.1 The triage/issue-naming half → OUT (the separate triage step, `optimize triage`/judge.ts, owns it)
- **`SKILL.md:36-44`** (Step 0, "Name nothing without its detector + evidence line…") — KEEP the reach/root
  check, EVICT the "naming a defect" framing: an issue arriving via `optimize fix --issue <name>` was already
  named+evidenced by `judge.ts`'s `postProcessJudgeDrafts` (`judge.ts:9-14`); re-litigating the name is
  redundant work, not diligence.
- **`SKILL.md:45-54`** (Step 1, "the LAPSE gate, before any edit") — EVICT in full as a fixer-owned gate. The
  LAPSE-vs-SKILL call is exactly what triage/judge already decided when it set `severity`+`status` on the
  issue (a first-occurrence LAPSE would arguably not even be minted as an issue by a well-tuned judge, or
  would be minted `low` severity with a routing-only recommendation). If the directive's "four-way bucket
  taxonomy is being retired" holds at the fixer layer, this whole step is the first thing to cut — replace it
  with a ONE-LINE trust statement: "the issue's severity/sig were already decided by triage; if they look
  wrong, that is a TRIAGE bug to report, not something to silently re-decide here."
- **`references/triage.md`** (the whole file) — §1 ("the evidence-line standard") and §2 ("the LAPSE gate")
  are triage's job now, not the fixer's; EVICT both wholesale. §3 ("Localizing the root") and §4
  ("Conditions and pre-prepared strategies" — root unreachable, multi-defect ticket, budget breach, judge
  abstain) are still the FIXER's job (these are about what to do once handed a validated issue) — KEEP,
  relocate to a leaner `references/root-cause.md` (drop the "triage" name entirely so nothing implies the
  fixer re-triages).
- **`references/orchestrator.md:11`** "→ per issue: LAPSE gate (triage.md §2) → consult memory…" — drop the
  LAPSE-gate clause from the cycle diagram; the orchestrator's job becomes "enumerate issues (already
  triaged) → dispatch."

### 4.2 The four-way bucket gate elsewhere in the skill (flag, not evict — code still uses it)
- `evaluateGate`/`DefectBucket` (`packages/core/src/optimize/types.ts:15`, `gate.ts:37-60`) is ALIVE CODE for
  the CLASSIC loop and is reused (bucket pinned to a constant `'SKILL'`) by the substrate gate itself
  (`fix.ts:70`, "a non-ARCH, non-FUNCTIONALITY bucket, so evaluateGate applies ONLY the editsApplied<1 and
  null⇒stage-for-human rules"). **Do not propose deleting the type or the gate rule** — only the FIXER's own
  procedural USE of the four-way naming (Step 1, triage.md) is in scope to retire. `piflow-enhance`'s §"The
  four-way triage buckets" (its own SKILL.md:131-135) is a SEPARATE skill's content and out of this plan's
  fence.
- **Facade table row** (`SKILL.md:117`) "the rule is correct and this is its first miss | a LAPSE — routing
  change, not a prose edit" — this row only makes sense if the fixer still runs the LAPSE gate. Once §4.1
  evicts Step 1, either drop this row or reframe it as "if triage already called this a LAPSE (see its
  severity/routing note), don't re-open the prose question."

### 4.3 What should NOT move (confirmed correctly fixer-scoped already)
- The two-foot routing (quality vs. harness, SKILL.md:56-65), the demand-lever menu (SKILL.md:73-102,
  `references/demand-levers.md`), Compile (SKILL.md:104-112), Verify (SKILL.md:126-144,
  `references/verification.md`), and the fixer's own tool-call retry/tripwire discipline (SKILL.md:146-151)
  are all genuinely about REPAIRING a validated issue, not naming one — these stay exactly where they are.

---

## 5 · GAPS — capability the fixer needs that no current verb/field provides

1. **No per-issue rerun-required flag.** `Issue` frontmatter (`issues.ts:95` `FRONTMATTER_KEYS`) has no field
   distinguishing "this fix needs a proving rerun" from "this fix is routing-only, skip the rerun." Today's
   `--no-prove` is pass-wide (`optimize-substrate.ts:205`), not per-issue. A schema addition (e.g. an
   optional `proveDefault: rerun | skip` frontmatter key, defaulting `rerun`) would let `fixIssue` read the
   right behavior off the issue itself instead of the caller's blanket flag — the fixer skill can only
   APPROXIMATE this in prose (§1.2) until that lands.
2. **No per-issue attempt/failure counter for DISCARDED attempts.** `attempts[]` is append-only and written
   ONLY on a landed/adopted fix (`issues.ts:281-286`); a REJECTED candidate leaves the issue at `open` with
   zero durable trace of the attempt (`fix.ts:566-570`). There is no ledger-visible way to answer "how many
   times has this issue already been tried and failed" — which is exactly what the "fixing limit" /
   circuit-breaker needs to gate on across INVOCATIONS (not just within one companion session). Building this
   (a `failedAttempts` counter, or a lightweight discard-log alongside the manifest) is a real code gap, not
   a skill-prose fix.
3. **No canonical "Companion Mode" procedure to point to.** `piflow-enhance/SKILL.md:86-89` says "Full
   procedure: piflow-init → 'Companion Mode (dev-time)'" — that section **does not exist** in
   `piflow-init/SKILL.md` (confirmed via `grep -n "^## "`, no such heading). The fixer's new companion front
   door (§1.1, door B) needs ITS OWN self-contained procedure rather than a second broken pointer to the same
   missing section — or this plan's author should flag the missing section as a prerequisite fix (separate
   from this skill) before the fixer's door B leans on it by reference.
4. **No CLI-level card/library pointer field.** Per §3.1, `piflow-enhance/SKILL.md:81-84`'s own documented
   TODO ("Autonomous seam TO-BUILD … a `[[card:<key>]]` backref in MEMORIZE blocks") is still open — the
   fixer's write-back step (§3.2) can name the card key in its own report/commit body today, but nothing
   downstream (the manifest, the issue ledger) stores it structurally yet.
5. **`piflow-inspect`'s routing table is one step behind** the substrate verbs (§2.3) — not a fixer-skill gap
   per se, but the fixer's door B leans on that skill for its performance-check step, so its staleness will
   surface through the fixer if not separately refreshed.

---

## Digest (≤15 lines)

**Lifecycle:** the fixer needs a SECOND front door — companion context (run/node + "solve it," self-checks
performance first) beside today's issue-packet door; issue-dependent rerun and the fixing-limit/escalation
ladder are directionally already in the skill (orchestrator.md §Tripwires/§5) but scoped to a multi-issue
orchestrator role, not the single-issue fixer's own lifecycle — pull them forward, and note two real code
gaps (no per-issue prove-flag, no per-issue failed-attempt counter) that prose alone can't close.

**Top CLI touchpoints (verb → skill line to fix):**
- `piflowctl issues list/show --node <id>` → new: door B's "does an issue already exist" step (nothing today)
- `piflowctl memory find <templateDir> --node <id>` → replaces bare `<node>/memory.md` at orchestrator.md:23
- `piflowctl understand <subsystem>` → replaces bare "code-map/okf slice key" at orchestrator.md:26
- `piflowctl optimize triage/fix/adopt --node <id>` → the SUBSTRATE system this skill is literally staged
  into (`fix.ts:391,399`) but never names by verb anywhere
- `piflowctl run --baseline <id> --stage-only` / `node <run> <id> --rerun` → replaces the hand-described
  "copy the baseline run's upstream artifacts" recipe at verification.md:20-24

**Scope evictions:** SKILL.md Step 1 (the LAPSE gate, lines 45-54) and all of `references/triage.md` §§1-2 —
triage/naming is now `optimize triage`/judge.ts's job; the fixer trusts the issue's severity/sig as given.
Root-localization content in triage.md §§3-4 stays, renamed off "triage."

Doc: `/Users/tk/Desktop/piflow/docs/design/fixer-skill-refresh-plan.md`.
