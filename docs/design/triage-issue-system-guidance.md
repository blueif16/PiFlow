# Triage guidance: issue initialization, assignment, and the recurrence/de-dup check

Scope: this doc covers ONLY the drafting side — how an issue file comes into being, gets assigned to a
fixer, and how the system stops itself from minting a duplicate for a problem already on file. It does NOT
cover how a fixer solves an issue (that is `piflow-fixer`'s job — see the Gaps section, item 4, for a naming
collision to watch). It seeds a future `piflow-triage` skill.

Everything below is grounded in two concrete artifacts read for this doc:
- **The mechanism** — `packages/core/src/optimize/substrate/{issues,judge,fix}.ts` (the M2 issue ledger +
  M4 judge stage + M6 fix stage; `docs/specs/optimize-substrate-plan.md` is their design doc, not re-read here).
- **The convention** — the four real issue files under
  `/Users/tk/Desktop/game-omni/.piflow/game-omni/template/nodes/gameplay/issues/` and the judge prompt that
  drafts them, `/Users/tk/Desktop/game-omni/packages/skills/harden-blueprint/optimize-judge.md`.

A second, PARALLEL optimize system exists in this codebase (`optimize/{types,triage,recurrence,gate,memorize}.ts`)
built around the four-way `LAPSE|SKILL|FUNCTIONALITY|ARCH` bucket taxonomy the team lead flagged as being
retired. It is cataloged in Gaps (item 2) but this guidance is NOT designed around it, per instruction.

---

## 1 · Issue initialization

**Where an issue lives:** one markdown file per issue, `<templateDir>/nodes/<node>/issues/<name>.md` — the
directory IS the table, a file is a row (`packages/core/src/optimize/substrate/issues.ts:1-4`).

**Frontmatter, in the FIXED serialization order the codec enforces** (`issues.ts:95`, `FRONTMATTER_KEYS`):

| key | who sets it | rule |
|---|---|---|
| `id` | **tool-computed, never agent-authored** | `sha256:<hex>` of `"v1\n" + nodeId + "\n" + sig` — a PURE function of node id + the stable `sig` line ONLY (`issues.ts:99-108`, `computeIssueId`). Title/severity/prose/attempts/timestamps are deliberately excluded from the hash so rewriting the context brief on a reopen never mints a new identity. Verified: recomputing this hash for 3 of the 4 real game-omni issue files reproduces their on-disk `id` byte-for-byte (double-jump-locks-input, player-hitbox-oversized, spawn-rate-unbounded-on-restart) — see Gaps item 3 for the 4th file, which breaks this. |
| `name` | **tool-minted, never agent-authored** | a "pie name" from `generateRunName` (`packages/core/src/names/generator.ts:40-56`) — Docker-style `<adjective>-<pie>` (e.g. `flaky-pecan`), reused verbatim against the names already on file, never re-implemented in `issues.ts` (module header, `issues.ts:26-27`). The file is named `<name>.md`. |
| `title` | agent (drafts it), tool (persists it) | one-line, rewritable (`issues.ts:73`, `125`). |
| `severity` | agent | `critical\|high\|medium\|low` (`issues.ts:54,90`). Justified by CITED evidence per `optimize-judge.md:41-45` — a specific criteria bullet, red flag, gold contrast, or measure-report number, never "this seems weak". |
| `status` | tool-governed state machine | a DRAFT may only ever declare `status: open` (`judge.ts:199-201` throws otherwise) — every other transition is mechanical, see §2/§3 below. |
| `reason` | tool | `null` unless `status: resolved`, in which case one of `fixed\|wontfix\|false-positive\|superseded` (`issues.ts:56,128-132`); cleared back to `null` the instant an issue is reopened. |
| `sig` | **agent, the one load-bearing judgment call** | the stable identity line the `id` hash runs over. Convention: `<node>::<stable-defect-tag>` (`optimize-judge.md:47-51`) — the tag names the DEFECT/root-cause PATTERN, never the instance data (`gameplay::unfeasible-traversal`, not `gameplay::gap-is-630px`). If the defect matches an existing memory.md lesson's `sig:` or an existing issue's `sig`, REUSE that exact tag — minting a near-duplicate defeats the mechanical dedup (see §4). |
| `firstSeen` / `lastSeen` | tool | stamped to the run id (`path.basename(path.resolve(runDir))`, `judge.ts:379`); `firstSeen` never changes after mint, `lastSeen` bumps on every re-observation including a reopen (`issues.ts:81-83`). |
| `attempts` | tool, APPEND-ONLY | `{commit, verifiedByRun, regressedIn?}[]` (`issues.ts:58-64`). `writeIssueFile` enforces append-only on every overwrite — no past row's fields may change, with exactly one sanctioned exception: `reopen()` may attach `regressedIn` to the LAST row only (`issues.ts:227-245`). |
| body | agent, rewritable on reopen | the ~30-40 line context brief: what was observed, WHERE (blueprint path/coords or equivalent), the cited evidence, why it matters downstream, and a suspect-scope hint — never a diagnosis, never a fix (`optimize-judge.md:55-58`, `97-100`). |

**The draft an agent is actually allowed to author is narrower than a full `Issue`:** only
`title / severity / sig / status:open` + body (`judge.ts:103-108`, `DRAFT_KEYS` at `judge.ts:157`). Everything
else in the table above is tool-stamped by `postProcessJudgeDrafts` (`judge.ts:228-317`) the moment the draft
file is found on disk after the judge agent's turn — an agent-authored `id`/`name`/`firstSeen`/`lastSeen`/
`attempts`/`reason` line is a hard parse error (`judge.ts:190-194`).

**Status machine** (`issues.ts:307-315`, `ALLOWED_TRANSITIONS`):
```
open → active → fix-landed → verifying → resolved
                  fix-landed ──────────→ resolved   (skip-proof path)
                               verifying ──→ open    (proven-REJECT: walk back, re-attemptable)
                                            resolved → regressed  (reopen)
                                            regressed → active    (behaves like open for dispatch)
```
Any edge outside this graph throws before a byte is written (`issues.ts:317-319`, `assertTransition`).

---

## 2 · Issue assignment

**One issue → one node → one fixer turn, always.** The node id is not a separate assignment field — it is
derived straight from the issue's own file path (`nodes/<node>/issues/<name>.md`):
`path.basename(path.dirname(path.dirname(issuePathAbs)))` (`fix.ts:483`). There is no cross-node issue and no
"assign to a different node" primitive.

**Dispatch order** is an explicit, sorted property of the ledger reader, not the caller's choice:
`listIssues` sorts **severity DESC, then `firstSeen` ASC** (`issues.ts:362-371`, `compareIssues`) — its own
doc comment calls this "the order fix selection consumes" (`issues.ts:376`). A `status` filter narrows the
same call (e.g. only `open`+`regressed`) but the severity-first ordering always holds.

**Per-issue fix flow** (`fixIssue`, `fix.ts:481-602`) — everything downstream of assignment happens against
an ISOLATED copy, never the live product:
1. **Activate** — `open|regressed → active` (`fix.ts:496`).
2. **Candidate copy** — the node's `{{WORKSPACE}}`-read closure (`contract.readScope` + `execReads` + `hooks`
   + `op`) copied into a scratch dir, MINUS anything referenced by `optimize.measure`/`optimize.judge` (the
   oracle is physically absent from what the fixer can touch) — `fix.ts:172-200`.
3. **One fixer agent turn**, `readScope`/`owns` pinned to ONLY the candidate dir (`fix.ts:507-520`) — the
   issue FILE, read verbatim, IS the whole dispatch contract: `buildFixerPrompt` embeds it and tells the
   agent "its context brief is your specification. Read it in full before editing." (`fix.ts:396-401`).
4. **Prove** (optional rerun against the candidate) → **gate** → **stage**. Adoption onto the live product is
   a SEPARATE, human-gated step (`adoptSubstrateManifest`, `fix.ts:604-669`) — `fixIssue` never auto-adopts.

**Severity is a prioritization signal, not an enforced gate** — nothing in `fix.ts` refuses to run a lower-
severity issue first; a caller that iterates `listIssues`'s own output gets severity-first for free. (Contrast
with the OTHER optimize system: `triage()`'s `Defect[]` output carries no sort at all — see Gaps item 5.)

---

## 3 · The recurrence-check protocol

This is wired TODAY exactly where the team lead's ask lives: the M4 judge stage (`judge.ts`), which builds
the FULL prompt an agent drafts issues from. It performs the search BEFORE the agent ever writes a file.

### Step 1 — search prior issue files (by `sig` + title/description)
`buildJudgePrompt` calls `listIssues(templateDir, { node: nodeId })` (`judge.ts:141`) and renders every
record into the prompt as `<existing_issues>`, one line each:
```
- <name> [<severity>] status=<status> sig="<sig>" — <title>
```
(`judge.ts:83-88`, `renderExistingIssues`). The agent is instructed (`optimize-judge.md:101-103`) to read this
FIRST: *"If a listed issue's `sig`/description already covers what you see, do NOT draft a new file — edit
that existing file's body/severity in place."* This SEMANTIC read is the PRIMARY dedup path.

### Step 2 — search prior commits
The exact command is embedded verbatim in the prompt (`GIT_HISTORY_INSTRUCTION`, `judge.ts:96-100`):
```
git log --grep '^skillsys(<node>)'
```
run "git ONLY — never `gh`, never a network lookup... to see prior fixes/discussion for this node, and avoid
re-flagging something already reasoned about." **See Gaps item 1 — this pattern does not match what the
mechanized fix/adopt pipeline itself will commit going forward.**

### Step 3 — REFERENCE, REOPEN, or NEW
Enforced mechanically by `postProcessJudgeDrafts` (`judge.ts:228-317`) as the BACKSTOP behind Step 1's
semantic read:
1. Compute `id = computeIssueId(nodeId, draft.sig)` (`judge.ts:275`).
2. Look it up against every already-valid issue on disk (`byId` map, `judge.ts:265,276`).
3. **Hit, and the existing issue is `resolved`** → `reopen(file, {run})` (`issues.ts:295-302`): `status →
   regressed`, `reason → null`, `regressedIn: run` stamped onto the LAST attempt row, `lastSeen → run`. The
   draft file is deleted, never duplicated (`judge.ts:281,289`).
4. **Hit, and the existing issue is anything else (open/active/fix-landed/verifying/regressed)** → a plain
   `lastSeen` bump, no status change (`judge.ts:283-286`) — a "re-seen, still the same problem" merge.
5. **No hit** → mint brand-new, subject to a per-pass cap (`DEFAULT_JUDGE_CAP = 5`, `judge.ts:38`, overflow
   parked in a `.pending/` sibling dir rather than dropped, `judge.ts:292-301`).

### Decision table

| what the agent/tool sees | existing issue's status | action | mechanism |
|---|---|---|---|
| same defect, differently worded, agent recognizes it via Step 1 | any non-resolved | **REFERENCE** — edit the existing file's body/severity in place; never touch `id` | agent-authored edit (`optimize-judge.md:101-103`) |
| agent drafts with the SAME `sig` text as an existing entry | `resolved` | **REOPEN** | `reopen()`, `issues.ts:295-302` |
| agent drafts with the SAME `sig` text as an existing entry | open / active / fix-landed / verifying / regressed | **RE-SEEN** (lastSeen bump only) | `judge.ts:283-286` |
| agent BELIEVES a `resolved` issue's defect has regressed | `resolved` | draft a **PLAIN new file with the SAME `sig`** — never hand-edit the resolved file's status; the mechanical layer performs the reopen | `optimize-judge.md:104-106`, scope_fence "Never resurrect a resolved issue by hand" |
| genuinely new defect, no title/sig overlap | n/a | **NEW** | `postProcessJudgeDrafts`, `judge.ts:304-315` |

---

## 4 · What makes two problems the SAME issue

The unit of identity is **`(nodeId, sig)`, compared by exact string equality inside a hash** — never fuzzy,
never semantic, at the MECHANICAL layer. `computeIssueId` (`issues.ts:106-108`) hashes the literal `sig`
string; the lookup in `postProcessJudgeDrafts` is an exact-match `Map` get (`judge.ts:275-276`). There is no
similarity scoring anywhere in this codebase's issue-ledger path.

This makes the `sig` TAG ITSELF the load-bearing judgment call, and it is entirely the agent's — not the
tool's. `optimize-judge.md:47-51` states the rule precisely: the tag names the DEFECT, so a differently-worded
rediscovery next run must hash to the SAME tag — e.g. `gameplay::unfeasible-traversal`, never
`gameplay::gap-is-630px`; `gameplay::design|pacing-shape`, never `gameplay::fill-is-28-percent`. So "same
configuration" concretely means: **same node, and the SAME underlying root-cause/mechanism**, encoded as one
stable string chosen at the semantic level (a symptom is the same configuration as a prior one if a human
would call them the same bug, even if the numbers differ) — NOT literal-value equality of the observed
symptom, and NOT keyed on the blueprint coordinates, measure numbers, or wording of the title/body.

The corollary: the mechanical hash dedup in §3 step 3 ONLY functions when the agent reuses the exact tag. An
agent that judges two occurrences of the identical defect to be "the same" but writes a slightly different
tag string produces two DIFFERENT ids and silently defeats the backstop — Step 1's semantic ledger read is
therefore not a redundant nicety, it is the actual primary defense (confirmed by the judge.ts module header,
`judge.ts:28-30`: "an agent's semantic re-read of the ledger is the PRIMARY dedup path... computeIssueId is
the MECHANICAL backstop").

Contrast: the OTHER, parallel recurrence system (`recurrence.ts`) defines "same failure" completely
differently and mechanically — `signatureOf(s) = "${node}::${sortedAnomalies.join('+') || reason ||
'underperformed'}"` (`recurrence.ts:31-33`) is a PURE function of Tier-0 telemetry (anomaly kinds), so two
runs of the identical failure MODE always produce the identical key regardless of anyone's wording. No agent
judgment enters that comparison at all. The two systems are NOT bridged (Gaps item 2).

---

## 5 · Gaps — what exists vs what this guidance requires

1. **The Step-2 git-search command will miss the pipeline's own future fixes.**
   `GIT_HISTORY_INSTRUCTION` hardcodes `git log --grep '^skillsys(<node>)'`
   (`packages/core/src/optimize/substrate/judge.ts:96-100`), but the MECHANIZED commit path this same
   pipeline lands fixes through mints a DIFFERENT subject: `optimize(<node>): <title>`
   (`packages/core/src/optimize/substrate/fix.ts:316`, `commitAdoption`). Verified empirically in game-omni:
   `git log --grep '^skillsys(gameplay)'` returns 45+ real commits; `git log --grep '^optimize(gameplay)'`
   returns ZERO. Today's instruction happens to work only because every real commit predates the mechanized
   adopt path. The moment `adoptSubstrateManifest` lands its first live commit, this exact grep will not find
   it — a triage skill built on this instruction verbatim needs to search BOTH conventions (or the two
   conventions need to be unified).

2. **The four-way `DefectBucket` taxonomy is alive in a second, parallel optimize system**, entirely separate
   from the file-ledger this guidance documents: `packages/core/src/optimize/types.ts:15` (the type),
   `triage.ts` (the whole `LAPSE|SKILL|FUNCTIONALITY|ARCH` projector), `recurrence.ts` (feeds its SKILL
   signal), `gate.ts:22,44,54` (bucket-conditioned land policy), `driver.ts:13,108,197-240` (dispatch),
   `memorize.ts:21,52,59,71,80` (only `LAPSE`/`SKILL` buckets are recordable into memory.md lessons),
   `events.ts:9,14-15`. `substrate/fix.ts:55,70` imports the TYPE only to borrow `evaluateGate`'s two generic
   rules (its own comment at `fix.ts:26-32` says explicitly this "neither models a substrate fix"). These two
   systems carry TWO INDEPENDENT recurrence mechanisms with different sig namespaces (agent-chosen
   `<node>::<tag>` in the issue ledger vs. telemetry-derived `signatureOf` in the score pass) and nothing
   bridges them — a lesson recorded by one is invisible to the other's dedup.

3. **On-disk evidence that no live run has yet exercised search-before-draft end-to-end**, plus one issue
   file that would fail today's parser outright. `schema-gate-skipped-ajv-draft-mismatch.md` carries a
   `bucket: FUNCTIONALITY` line and has NO `id:` field at all — both incompatible with the current ledger
   codec, which requires exactly the 10 `FRONTMATTER_KEYS` (`issues.ts:95`) and fails closed on any unknown
   key (`issues.ts:175-176`) or missing key (`issues.ts:173-174`); loading this file through
   `parseIssueFile`/`listIssues` today throws. By contrast, the other three files' `id` hashes reproduce
   `computeIssueId(nodeId, sig)` EXACTLY (verified by direct computation against the live formula) — strong
   evidence they were authored to the current recipe — while their `name` fields
   (`double-jump-locks-input`, not an `<adjective>-<pie>` shape `generateRunName` actually produces,
   `names/generator.ts:40-56`) show they were not literally minted by a running `postProcessJudgeDrafts`
   call. Net: the reopen code is real and exercised by unit tests
   (`packages/core/test/optimize-substrate-issues.test.ts`, `optimize-substrate-judge.test.ts`), but this
   repo shows no direct evidence of a LIVE run driving the search-before-draft flow against game-omni — the
   existing files read as a carefully hand-matched reference shape (consistent with game-omni's documented
   role as a by-hand practice of the design), not proof of a live invocation.

4. **A naming collision risk for the planned `piflow-triage` skill.**
   `/Users/tk/Desktop/piflow/.claude/skills/piflow-fixer/references/triage.md` already exists and covers a
   DIFFERENT "triage" — the FIXER's own post-dispatch LAPSE-vs-SKILL classification (whether an
   already-assigned issue deserves an edit at all, built around the same four-way taxonomy flagged for
   retirement in item 2). It is downstream of everything this doc covers. The future `piflow-triage` skill
   (scoped to initialization/assignment/dedup, upstream of dispatch) should be named or cross-referenced
   carefully to avoid being confused with this existing file.

5. **Ordering guarantee asymmetry.** The file-ledger's `listIssues` has an explicit, tested dispatch order —
   severity DESC then `firstSeen` ASC (`issues.ts:362-371,376`). The parallel score+triage system's
   `triage()` emits `Defect[]` in raw `NodeScore[]` input order with no severity sort anywhere in `triage.ts`
   or `driver.ts` — "assignment order" is a guarantee only the substrate ledger makes today.
