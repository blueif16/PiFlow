# Optimize — issue lifecycle redesign (candidate-as-commit · one folder per issue · uniform per-issue CLI)

Status: PLAN (for subagent development). Supersedes the copy-based candidate + shared-manifest model in
`optimize/substrate/{fix,gate}.ts`. Builds on the SHIPPED gate agent + outer retry loop
(`docs/design/optimize-verification-loop.md`).

## 0. Why

The current `fixIssue` fuses fixer→prove→gate in one call, stores a **physical copy** of the node's read-closure
as the "candidate", scatters artifacts (candidate in `staging/`, a shared `manifest.json`, `verdict.json` inside
the child run), and can only address issues through a `--manifest` path. Three problems, one root cause — the
candidate is a *copy* and the stages are *fused*:

- **Copies don't scale.** A broad-`readScope` node copies a huge tree; a whole-project fix can't be expressed at
  all; copies × issues × runs × retries is an untrackable pile.
- **Scattered files.** The lifecycle of ONE issue lives in four places; you reconstruct it to answer anything.
- **Non-uniform grammar.** `fix`/`verify`/`adopt` are the same object (an issue) but addressed differently
  (`--issue` vs `--manifest`), and the gate can't be triggered on its own.

## 1. The decisions (locked)

1. **Candidate = a git commit, not a copy.** A candidate is `{ baseSha, candidateSha }` on a throwaway branch.
   The fixer edits a git **worktree** at `baseSha` (full repo, any size), then commits → `candidateSha`. The
   stored reference is a SHA, never a tree. This scales to whole-project fixes and makes tracking a hash.
2. **Oracle fence via the sandbox + a diff check** (NOT copy-exclusion). The fixer runs in the worktree under
   the existing default-on sandbox `readScope` (seatbelt/bwrap), jailed to the node's closure MINUS the oracle
   (`optimize.measure`/`judge`/gold), so it cannot read or write the scorer/criteria. After commit, a
   diff-policy check rejects the candidate if its diff touches any oracle path. Belt + suspenders.
3. **One folder per issue.** Everything for an issue is addressed by `(node, issue)`:
   - **Record (durable, per-node, in the template):** `template/nodes/<node>/issues/<name>.md` — the index:
     `status · attempts[] · firstSeen/lastSeen · verify tier`. Runs UPDATE it (recurrence lives here).
   - **Lifecycle (per-run, keyed by issue):** `runs/<run>/optimize/issues/<node>/<issue>/` — `record.json`
     (`baseSha`, `candidateSha`, `decision`, `verifiedByRun`), `verdict.json`, `log.jsonl`. No candidate copy
     (it's a SHA); no shared `manifest.json` (dissolved into per-issue `record.json`). The `.md`'s `attempts[]`
     points at each run's lifecycle dir + `candidateSha` — one hop, nothing reconstructed.
4. **Uniform CLI — every verb acts on the same object (an issue):**
   ```
   optimize fix     --node <id> [--issue <name>] [--run <id>]
   optimize verify  --node <id> [--issue <name>] [--run <id>]
   optimize adopt   --node <id> [--issue <name>] [--run <id>]
   ```
   `--node --issue` = one issue · omit `--issue` = all eligible issues of the node (bulk sugar, free) · `--run`
   scopes · dotted `--node <run>.<id>` already works. The manifest is never named by the user. `--manifest`
   survives only as a hidden back-compat alias on `adopt`.
5. **Stages are decoupled + uniform.** `fix` (edit→commit), `prove` (rerun), `verify` (gate) are separate
   callables and separate verbs. All three agent stages (triage · fix · gate) are ONE base-agent grammar —
   `{ skill, inputs, output }`, run by `runBaseAgent`, defaulting to their standard skills. No specialized
   per-stage schema. The per-node **`criteria`** file (rename of `optimize.judge`, back-compat alias) is a
   shared INPUT to both triage and gate.
6. **Per-issue verify tier.** Each issue's frontmatter carries `verify: none | rerun | full` (node
   `verifyDefault`). `none` = trivial (typo) → no rerun, no gate, straight to adopt-ready. `rerun` = prove only.
   `full` = prove + gate agent. Effort proportional to the defect.

## 2. Adopt & staleness (git-native)

- `adopt` cherry-picks/merges `candidateSha` onto the live branch, then stamps the issue (`commit`,
  `verifiedByRun`) and transitions it `→ resolved`.
- **Base drift:** `record.json` stores `baseSha`. If the live branch moved past `baseSha` between prove and
  adopt, `adopt` re-verifies (re-prove) before landing, and the merge surfaces conflicts honestly (never a
  silent wrong-apply). Prove-then-adopt-promptly keeps candidates short-lived; the worktree is torn down after
  prove/gate, only the SHA persists.

## 3. Workstreams (dependency-ordered; each is a subagent contract)

Each workstream is TEST-FIRST (`test-discipline`): a failing test per behavior, watched red, then green; the
give-up / drift / oracle-fence paths get dedicated tests; logic is mutation-checked. Scope-fence every subagent:
no git history rewrite, no edit to measure/judge/gold, HALT-and-report if the root is out of reach.

### WS0 — Candidate = git worktree + commit (FOUNDATION; everything depends on it)
- **Replace** `prepareCandidateClosure` (copy) with a git-worktree candidate: create a throwaway branch +
  worktree at HEAD (reuse the harness worktree tooling / `--sandbox worktree`), return `{ baseSha, branch,
  worktreeDir }`.
- The fixer spawns with `cwd = worktreeDir`, sandbox `readScope`/`owns` = node closure MINUS oracle (reuse
  seatbelt/bwrap default-on). After the fixer, `git add -A && commit` → `candidateSha`; `editsApplied` = diff
  name-count.
- **Oracle diff-policy guard:** reject the candidate (as a fixer-side failure, not a gate reject) if the diff
  touches any `optimize.measure`/`judge`/gold path. Dedicated test.
- **Prove** re-runs the node against a worktree at `candidateSha` (measure with the live oracle at HEAD).
- **Cleanup:** remove the worktree after prove/gate; keep branch+SHA until adopt/discard.
- **Acceptance:** a fix that edits N files across the repo is captured as one `candidateSha`; a fix that edits an
  oracle path is rejected; prove runs against the SHA; no tree copy exists on disk. Depends on: nothing.

### WS1 — Storage: one folder per issue; dissolve the manifest
- New `issueLifecycleDir(runDir, node, issue)` = `runs/<run>/optimize/issues/<node>/<issue>/`.
- `SubstrateManifestRecord` → per-issue `record.json` in that dir (`baseSha`, `candidateSha`, `decision`,
  `verifiedByRun`, `deltaSummary`, `dropback?`). Provide a `scanRecords(runDir)` VIEW (glob the per-issue
  `record.json`s) for bulk ops + back-compat readers.
- `verdict.json`, `log.jsonl` written under the issue dir. The issue `.md` `attempts[]` gains a `lifecycle`
  pointer + `candidateSha`.
- **Acceptance:** every artifact for an issue is found under one dir by `(node, issue)`; no shared
  `manifest.json`; `scanRecords` reconstructs the bulk view. Depends on: WS0 (record shape carries SHAs).

### WS2 — Stage decoupling + uniform CLI
- Split `fixIssue` into `fixStage` (candidate+edits→record), `proveStage` (rerun→record), `verifyStage` (gate
  agent→verdict→record+status). Each reads/writes the per-issue dir; each is independently callable.
- **`optimize verify`** verb: resolve the issue's `record.json` (existing `candidateSha` + prove result) → run
  `verifyStage` (gate agent + shared `criteria` + candidate + rerun) → `verdict.json` → update decision+status.
  NO fixer, NO re-prove. **This is what gates `flaky-cottage` off its on-disk candidate.**
- **Uniform selector** shared by `fix`/`verify`/`adopt`: `--node [--issue] [--run]`; omit `--issue` = all
  eligible for that verb's stage; manifest internal.
- **`optimize adopt`** re-grammar: `--node --issue` (resolve `record.json`), cherry-pick `candidateSha`,
  re-verify on base drift; `--manifest` demoted to hidden alias.
- **Acceptance:** `optimize verify --node w0-classify --issue flaky-cottage` produces a real gate-agent
  `verdict.json` with zero fixer/prove re-runs; `fix`/`verify`/`adopt` share one selector; `--manifest` never
  required. Depends on: WS0, WS1.

### WS3 — Per-issue verify tier + uniform config grammar
- Issue frontmatter `verify: none|rerun|full` (+ node `optimize.verifyDefault`). `fix` reads the tier: `none`
  skips prove+gate (record `decision: proved`→adopt-ready), `rerun` proves only, `full` proves+gates.
- Rename `optimize.judge` → `optimize.criteria` (shared bar; keep `judge` as a read alias). Document the single
  base-agent stage grammar `{ skill, inputs, output }`; stages default to `piflow-{triage,fixer,gate}` — no
  per-node config required, override only a named knob.
- **Acceptance:** a `verify: none` issue lands with no rerun/gate; a `full` issue runs both; `criteria` is read
  by both triage and gate from one file. Depends on: WS2.

### WS4 — Rebase the retry loop + gate onto SHAs (this session's work survives)
- `fixIssueWithRetries` / the gate agent / the breaker are representation-agnostic — they carry a candidate
  *reference*. Swap `candidateRef` → `candidateSha` (branch per attempt); keep-best = the best SHA; escalation
  lists SHAs. The loop/cap/breaker LOGIC and their mutation-proven tests are unchanged.
- **Acceptance:** the retry-loop + breaker suites pass against the SHA-based candidate; a rejected attempt's
  drop-back still re-dispatches a fresh worktree/commit. Depends on: WS0, WS2.

## 4. Sequencing

WS0 → WS1 → WS2 → {WS3, WS4 in parallel}. WS2 is the milestone that lights up `optimize verify` on
`flaky-cottage`. Land each workstream on its own branch, `--no-ff` to main, tests green, before the next.

## 5. What already shipped (and how it rebases)

`docs/design/optimize-verification-loop.md` shipped the independent gate agent, the bounded diversifying retry
loop (`fixIssueWithRetries`), the triple cap, the give-up/escalation path, and the system-wide breaker — all
test-first + mutation-proven. This redesign changes the candidate REPRESENTATION and the STORAGE/CLI around
them; the loop/gate/breaker LOGIC is untouched (WS4 is a mechanical `candidateRef → candidateSha` rebase).

## 6. Risks + mitigations

- **Oracle readable in the worktree** → sandbox `readScope` jails the fixer out of oracle paths (default-on) +
  diff-policy guard. Test the fence directly (a fixer that tries to read/edit the scorer is blocked/rejected).
- **Base drift between prove and adopt** → re-verify on drift; adopt is a real merge (conflicts surface).
- **Worktree lifecycle leak** → tear down after prove/gate; a swept run removes dangling branches.
- **Whole-repo commit noise on the branch** → throwaway branches namespaced `optimize/<node>/<issue>/attempt-N`;
  swept with the run.
