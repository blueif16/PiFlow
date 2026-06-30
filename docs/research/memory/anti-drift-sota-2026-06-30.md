# Keeping a code-derived knowledge layer synced to ground truth — SOTA anti-drift patterns
_scope: no recency filter (techniques 2018–2026, AI-agent indexing skews 2024–2026), generic SWE/AI-tools lens, deep dive • generated 2026-06-30_
_source tags: [R]=Reddit • [E]=Exa web. Inline citations name the specific system/site so every claim is traceable._
_why this exists: research input for the world/code leg (Leg B) of [[piflow-memory-system-v1]] — specifically the anti-drift machinery. NOT a system component; a survey of what real systems do, to ground our design._

## How to read this
The machine layer (code-graph / embeddings) has a **converged, solved** anti-drift pattern. The prose layer (our curated OKF markdown slices) is the **hard, unsolved** part — but a clear emerging cascade exists, and ~5 young projects are near-isomorphic prior art to our design. Claims are practitioner-experience [R] or primary-source/engineering-blog/paper [E]; weight accordingly.

## TL;DR
- **Stale context is actively harmful, not neutral noise.** Stale-only retrieval induced obsolete code on 15/17 samples — an **88-percentage-point** increase over current-only retrieval [E, arxiv 2605.14478]. This is the strongest reason any of the below matters.
- **The machine-index pattern is settled:** a **Merkle tree of file content-hashes** → re-derive only the leaf→root path that changed, plus a **file-watch daemon** (debounced), a **connect-time (size,mtime)+hash reconcile** for edits made while the watcher was off, and a **TTL backstop**. Cursor, Meta Glean, codegraph all do versions of this [E].
- **Practitioners trust deterministic re-derivation over LLM-summarized memory.** The most-cited convention-learning tool is deliberately *"no AI, just AST parsing"* [R, Drift]; Staleguard's gate is *zero-false-positive deterministic*, with the LLM demoted to an advisory hint [E].
- **More front-loaded docs made drift *worse*.** Loading architecture context at session start fails because it's buried by the time code is generated 20 min later; re-deriving + validating *at generation time* lifted compliance 40%→92% [R, cursor]. "The feedback loop matters more than the documentation."
- **The prose-layer cascade that's emerging:** (1) deterministic **anchor-existence** check → (2) **provenance pin** `slice@sha` / method-body hash → (3) **regenerate-and-diff CI gate** → (4) **impact/blast-radius** re-validation → (5) **grounded LLM** semantic check, run last and *silent unless it can quote the contradiction*.
- **Near-isomorphic prior art exists** (all 2026, young): `agents-remember` (path-addressed memory, git-proven freshness), `agentsge`/`agents-first` (one typed freshness-tracked knowledge dir → derives CLAUDE.md/.cursorrules, pre-commit drift gate), `docdrift` (tree-sitter method-body AST hash = sub-file `slice@sha`), `Staleguard` (deterministic anchor check + alignment ledger).

---

## Key findings (in depth)

### The 11 mechanisms, by family
Each: what it is · which real system · what TRIGGERS the re-derive · fit to our codegraph+markdown-slice design.

**MACHINE LAYER (code-graph / embeddings — solved, converged)**

1. **Content / Merkle hashing + incremental re-derive.** Tree of cryptographic file hashes; a parent hash = hash of its children, so an edit dirties only the leaf→root path; diff walks only branches where hashes differ. **Cursor** (SHA-256 merkle, re-embed only diffed chunks, embeddings cached *by chunk content* so unchanged chunks in an edited file hit cache) [E, cursor.com]; **codegraph-rs** `sync` = sha256-based skip [E]. **Trigger:** hash mismatch on a branch. **Fit: direct** — hash each slice's underlying code anchors; the slice's `slice@sha` pin IS the leaf.

2. **File-watch / daemon sync.** Native OS events (FSEvents/inotify/ReadDirectoryChangesW) + debounce collapse edit-bursts into one re-index. **CodeGraph** (2s debounce, tunable `CODEGRAPH_WATCH_DEBOUNCE_MS`) [E], **Gortex** (fsnotify+150ms → ~200ms surgical graph patch vs 3–5s rebuild) [E], CodexA `--watch` [R]. **Trigger:** filesystem write. **Fit:** a watcher re-derives the slice for any node whose owned files changed; debounce = the re-derive batching window.

3. **Connect-time / catch-up reconciliation.** On (re)connect, scan working tree by **(size, mtime) + content-hash** to absorb edits made while nothing watched (a terminal `git pull`, an external editor). **CodeGraph** does this before answering the first query [E]. **Trigger:** session/server start. **Fit: direct** — validate every slice's pin against HEAD at session start; stale → re-derive before first use. The antidote to "watcher was off."

4. **AST / tree-sitter re-parse on change.** Re-parse only the changed file into symbols+edges. **Aider** (tree-sitter tags → file-dep graph → PageRank rank → binary-search to token budget; SQLite tags cache keyed by file `mtime`) [E]; **docdrift** hashes the tree-sitter AST of each tracked **method body** — sub-file granularity, so drift fires on body change, not formatting [E]. **Trigger:** changed file (or changed method-body hash). **Fit: direct** — method-body hash is the *precise* version of `slice@sha`.

**DEPENDENCY LAYER (blast-radius — well-developed in test-selection)**

5. **Impact / blast-radius re-validation.** Walk the dep graph from changed files to find what must be re-checked. **Meta Glean** computes **fanout** (O(fanout), e.g. all files transitively `#include`-ing a changed header) via its own queries [E]; **Meta Predictive Test Selection** (ML over build-dep graph, >95% accuracy, catches a failure on 99.9% of bad changes) [E]; **Ekstazi RTS** (per-test dependency files + checksums; re-run only tests whose dep checksum changed; also tracks *files that didn't exist but were attempted* — resource-anchor existence as a dependency) [E]; **vitest-affected** (git-diff → reverse-dep BFS → affected tests; lockfile change → full suite; self-healing prunes stale edges) [E]; **codegraph `impact`** [E]; **Drift** `impact_analysis`/`reachability_forward`/`reachability_inverse` [R]. **Trigger:** a change whose transitive closure touches a node. **Fit: direct** — on a code change, re-validate not just the directly-bound slice but every slice whose anchors are in the change's blast radius. This is what git-log-of-seeds *cannot* see and the graph can.

**PROSE / DOC LAYER (the hard part — emerging cascade)**

6. **CI drift gate (regenerate-and-diff / `--check`).** Re-derive in CI; fail if it differs from committed. **agents-sync** (pre-commit blocks when CLAUDE.md/.cursorrules drift from canonical AGENTS.md) [E]; **Staleguard** `check --fail-on-regression` against a committed alignment-score ledger [E]; **docdrift** `check --ci` exits non-zero [E]; **DocuGardener / Doc-Drift** PR-time check [E]. **Trigger:** PR/commit. **Fit: direct** — same shape as game-omni's `_generate.mjs --check` and our optimize strict-improvement gate.

7. **Doc-tests / executable docs.** Doc code-blocks compiled+run in CI so a signature change breaks the build. **Rust rustdoc** (`cargo test` runs every `///` block) [E]; docs-as-tests [E]. **Trigger:** doc example fails to run. **Fit: weak** — only the executable subset of a slice, but a strong anti-lie guarantee for any command/snippet inside the markdown.

8. **Resource-anchor existence checks.** Deterministically verify every path/command/symbol/env-var the doc references still exists. **Staleguard** Layer-1 (paths/commands/config-keys/entry-points/arch-rules vs the real import graph; reports only what it can *prove* wrong; ~1.2s on 330k LOC, zero false positives) [E]; **agentsge** `validate` (broken-ref + schema) [E]. **Trigger:** a referenced anchor no longer resolves. **Fit: direct & cheapest** — this is exactly `_generate.mjs`'s health pass and the pi-runner `run.mjs → legacy/run.mjs` drift we hit. Run it first.

9. **Freshness timestamps / TTL.** Periodic resync regardless of events. **Cursor** (~5 min) [E]; code-graph-ai 30s result-cache TTL [E]; Google monorepo LSIF refresh twice/day [E]. **Trigger:** TTL elapse. **Fit:** a backstop sweep for slices the event path missed.

10. **Provenance pins (`slice@sha`).** Store, with each derived artifact, the commit/hash it was derived from; compare before trust. **agents-remember** ("git-proven freshness… drift-checked against source commits before they are trusted"; path-addressed mirror notes) [E]; **agentsge** freshness-tracking [E]; **Sourcegraph commit-graph** (adjusts stale-commit results via git-diff between nearest indexed commit and requested commit) [E]. **Trigger:** pinned sha ≠ current sha. **Fit: perfect** — this is literally the `slice@sha` design; `agents-remember` is near-isomorphic prior art.

11. **LLM-as-judge staleness review.** *Semantic* (not string) diff of doc vs code, grounded in quoted evidence to suppress confabulation. **Doc-Drift** (only flags a *specific* claim contradicted by a *specific* change; "not allowed to guess… stays silent" otherwise) [E]; **Staleguard** advisory Layer-2 (`contradicted` = high-precision hint, not a gate) [E]; **SDD** AI semantic spec↔code diff [E]. **Trigger:** model finds a concrete, quotable contradiction. **Fit: top tier of a cascade** — run last, only on slices that passed the cheap checks, gated to quoted evidence.

### Two cross-cutting lessons that change the design
- **Deterministic-first.** Every battle-tested doc tool puts a deterministic, zero-false-positive layer (anchor existence, hashes) *first* and demotes the LLM to an advisory hint. Practitioners explicitly distrust LLM-summarized memory for the knowledge layer ("no AI, just AST parsing" [R, Drift]). → our curated prose is authored by an agent, but its *freshness signals* must be deterministic.
- **Don't front-load; validate at the moment of use.** Static context loaded at session start rots before it's used; the win is re-deriving the *relevant* slice + a post-generation compliance gate (40%→92% [R]). → matches our design law that code-maps are **optimizer-facing, never injected into the node's runtime prompt** — but suggests the *fixer* should pull the slice just-in-time and validate after.

## What's working (claimed)
- Merkle/content-hash incremental re-index — production-proven at Cursor scale (50k files; 92% cross-user similarity exploited via simhash to seed a teammate's index) [E].
- O(fanout) incremental code-graph via stacked immutable DBs — Meta Glean, open-sourced [E].
- Deterministic doc-anchor gate at ~1.2s / 330k LOC, zero false positives — Staleguard [E].
- Method-body AST-hash as the drift baseline (sub-file precision) — docdrift [E].
- Reverse-dep test selection with self-healing edge-pruning — vitest-affected; >95% predictive accuracy at Meta [E].
- Grounded, silent-unless-provable LLM doc check caught real stale commands (`npm run dev` after removal) [E, Doc-Drift].

## What's broken / contested
- **No automated staleness check on prose docs/diagrams exists in practice** for most teams — detection is "nobody trusts the docs anymore" (human distrust), and the resigned consensus is "the code is the documentation," diagrams updated only for onboarding/audits [R, r/softwarearchitecture score-48 thread].
- **N hand-maintained rule files drift** (`.cursorrules` + `CLAUDE.md` + `copilot-instructions.md` + CI prompt) — "someone updates one, forgets the others" [R]. The fix everyone gravitates to: one neutral source + a generator/sync (exactly `agentsge`'s model).
- **Front-loaded documentation made compliance worse**, not better [R, cursor 40→92] — a direct contradiction of "write more docs."
- The agent-memory prior-art tools (agentsge, agents-remember, agents-first) are 2026, low-star — *design* prior art, not battle-tested at scale [E].

## Numbers worth verifying
- 88.2 / 76.5 pp increase in stale helper refs from stale-only retrieval (Qwen2.5-Coder-7B / gpt-4.1-mini) [E, arxiv 2605.14478].
- Cursor: 50k files ≈ 3.2 MB of filename+SHA-256; ~92% cross-user codebase similarity; ~5-min sync cadence [E].
- Compliance 40%→92%, review time −51%, arch violations −90% from just-in-time rules + post-gen gate [R, AgiFlow/aicode-toolkit].
- CodeGraph debounce default 2000ms (clamp 100ms–60s); Gortex ~200ms patch vs 3–5s rebuild [E].
- Staleguard Layer-1 ~1.2s on 330k LOC, zero false positives [E].
- Meta Predictive Test Selection >95% accuracy, 99.9% bad-change catch [E].
- Drift tool: 15 categories / 150+ patterns; author spent "~75% of token budget on auditing vs writing" [R].
- TDAD: shrinking SKILL.md 107→20 lines moved resolution 12%→50% [E, arxiv 2603.17973].
- Knowledge-graph MCP claimed 120x token reduction across 35 repos [R, unverified link-post].

## Recommended cascade for piflow (synthesis → our Leg B)
A slice's `Freshness` block becomes a deterministic-first cascade; only signals that fire route to an agent; the LLM runs last and gated. Maps onto the 4-tier model already sketched, **upgraded** and with the external-research tier dropped (not a system component):

| Tier | Detector (cheapest first) | Substrate | Trigger | Grounded by |
|---|---|---|---|---|
| 0 | **anchor existence** — every path/symbol the slice cites resolves | git tree + codegraph resolve | pre-commit (blocking) | Staleguard L1, `_generate.mjs` health, agentsge validate |
| 1 | **content/provenance** — `slice@sha` ≠ HEAD, or tracked **method-body AST-hash** changed | git + tree-sitter | post-merge | docdrift, agents-remember, Cursor merkle |
| 2 | **dependency / blast-radius** — change's transitive closure hits the slice's anchors | codegraph `impact`/`affected` | post-merge (graph sync) | Glean fanout, vitest-affected, Ekstazi |
| 3 | **semantic staleness** (advisory) — LLM finds a *quotable* contradiction between prose and a specific change | LLM, evidence-gated | only on slices past tiers 0–2 | Doc-Drift, Staleguard L2 |

Tiers 0–2 are deterministic and cheap; tier 3 is advisory and silent-unless-provable. All four are *internal* (code↔slice). The `--check` regenerate-and-diff gate (mechanism 6) is the harness that runs tiers 0–1 in CI; we already ship its shape via game-omni's `_generate.mjs --check` and the optimize strict-improvement gate.

## Ready-to-paste scaffolds (verbatim from sources)

**Merkle build + diff (Cursor model)** [E, docs.bswen.com]:
```python
def compute_merkle_tree(codebase):
    tree = {}
    for file in codebase.files:
        tree[file.path] = hash(file.content)                 # leaf = hash of content
    for directory in bottom_up(tree.directories):
        tree[directory] = hash(sorted(tree[c] for c in directory.children))
    return tree
def diff_merkle_trees(old, new):                              # walk only diverging branches
    changed = []
    def walk(o, n, path):
        if o.hash == n.hash: return                          # subtree unchanged → skip
        if is_leaf(o): changed.append(path)
        else:
            for c in o.children: walk(o[c], n[c], path + c.name)
    walk(old.root, new.root, "/"); return changed
```

**docdrift layout — method-body hash baseline** [E, github.com/NicoSchwandner/docdrift]:
```
.context/
  config.json     # repo settings
  verified.json   # baseline AST hashes (committed)
  index.json      # auto-generated (gitignored)
# pin  -> record method-body baselines | check --ci -> exit!=0 on drift | ack <id> -> drift reviewed, doc still ok
```

**Staleguard CI gate** [E, github.com/Arthur920/Staleguard]:
```bash
staleguard check --write-ledger          # baseline alignment under .staleguard/
staleguard check --fail-on-regression    # CI: fail only if alignment REGRESSED below baseline
```

**agents-remember loop** [E, github.com/velantrian/agents-remember]: path-addressed note at a deterministic mirror path; *drift-check before planning → approval before implementation → onboarding/memory update only after approved land*; a `memory.md` ledger keeps code+memory synchronized.

## Practice → source quick-reference
| Practice | Why it works | Source | Leg |
|---|---|---|---|
| Merkle/content-hash, re-derive leaf→root only | O(changes) not O(repo); cache by content | Cursor, codegraph-rs | E |
| Re-embed/parse only changed files, cache by chunk-content | unchanged chunks in an edited file skip work | Cursor | E |
| File-watch daemon + debounce | collapse edit bursts into one re-index | CodeGraph, Gortex, CodexA | E/R |
| Connect-time (size,mtime)+hash reconcile | catches edits made while watcher was off | CodeGraph | E |
| Method-body AST hash as drift baseline | sub-file precision; ignores formatting | docdrift | E |
| `slice@sha` provenance pin, drift-check before trust | never trust a note older than its source commit | agents-remember, Sourcegraph commit-graph | E |
| Deterministic anchor-existence gate FIRST | zero false positives; proves what's wrong | Staleguard L1, agentsge | E |
| Regenerate-and-diff `--check` in CI | committed artifact must equal re-derived | agents-sync, docdrift, `_generate.mjs` | E |
| Impact/blast-radius → re-validate dependents | a change ripples beyond its own file | Glean fanout, vitest-affected, Ekstazi | E |
| One neutral source → generate CLAUDE.md/.cursorrules | kills N-copies drift | agentsge, agents-first | E/R |
| LLM check LAST, silent-unless-quotable | suppresses confabulation; high precision | Doc-Drift, Staleguard L2 | E |
| Validate at generation time, don't front-load | static context rots mid-session | aicode-toolkit | R |
| Treat staleness as first-class retrieval metadata | stale context actively induces obsolete code | arxiv 2605.14478 | E |

## Next moves
- Fold the 4-tier cascade above into the anti-drift section of [[piflow-memory-system-v1]] / `piflow-memory-v1.5.md`, replacing the earlier "tier-3 = external EXA/Reddit research" with tier-3 = internal evidence-gated LLM check.
- Evaluate `docdrift` (method-body hash) and `Staleguard` (deterministic anchor gate) directly as either dependencies or design references for piflow's `--check`.
- One experiment: run game-omni's `_generate.mjs --check` over piflow and measure tier-0 (anchor) drift on a real vertical (base-agent-types already surfaced two drifts by hand).

## Sources
### Reddit [R]
- Cursor merkle indexing — r/programming — https://www.reddit.com/r/programming/comments/1kkmjr4/
- 40→92 architectural compliance (just-in-time rules + post-gen gate) — r/cursor — https://www.reddit.com/r/cursor/comments/1pbag9x/
- N-copies rule drift across .cursorrules/CLAUDE.md/copilot — r/ExperiencedDevs — https://www.reddit.com/r/ExperiencedDevs/comments/1t8237u/
- Drift (AST, no-AI, 150+ patterns, impact/reachability) — r/LocalLLaMA — https://www.reddit.com/r/LocalLLaMA/comments/1qm0l2q/
- "How do you keep architecture docs in sync?" — r/softwarearchitecture — https://www.reddit.com/r/softwarearchitecture/comments/1r124hz/
- CodexA incremental `--watch` re-embed — r/Python — https://www.reddit.com/r/Python/comments/1ruy56p/
- Real-time arch-diff from control-flow graph — r/softwarearchitecture — https://www.reddit.com/r/softwarearchitecture/comments/1u0mzw6/
- CodeGraphContext MCP graph DB — r/LocalLLaMA — https://www.reddit.com/r/LocalLLaMA/comments/1rnarei/
- "Modeling Large Codebases as Static Knowledge Graphs" (the maintainability open-problem) — r/programming — https://www.reddit.com/r/programming/comments/1priv8c/
- tree-sitter-language-pack AST-aware chunking for RAG — r/Python — https://www.reddit.com/r/Python/comments/1s0nak7/
### Exa [E]
- Cursor secure codebase indexing — https://cursor.com/blog/secure-codebase-indexing
- Cursor secure-indexing deep dive (merkle pseudocode, simhash) — https://docs.bswen.com/blog/2026-03-24-cursor-secure-indexing/
- Meta Glean open-source incremental indexing — https://engineering.fb.com/2024/12/19/developer-tools/glean-open-source-code-indexing/
- CodeGraph (watch + connect-time reconcile + impact) — https://github.com/colbymchenry/codegraph
- Gortex (fsnotify graph patch) — https://zzet.org/gortex/how-cursor-indexes-codebase-embeddings-vs-graph/
- docdrift (method-body AST hash) — https://github.com/NicoSchwandner/docdrift
- Staleguard (deterministic anchor gate + ledger) — https://github.com/Arthur920/Staleguard
- agents-remember (git-proven freshness) — https://github.com/velantrian/agents-remember
- agentsge / agents-first (typed freshness-tracked knowledge dir) — https://github.com/larsen66/agentsge
- "When Retrieval Hurts Code Completion" — https://arxiv.org/html/2605.14478v1
- SCIP announcement (file-level incrementality) — https://sourcegraph.com/blog/announcing-scip
- Aider repo map (tree-sitter + PageRank) — https://aider.chat/2023/10/22/repomap.html
- Meta Predictive Test Selection — https://engineering.fb.com/2018/11/21/developer-tools/predictive-test-selection/
- Ekstazi practical RTS — https://mir.cs.illinois.edu/marinov/publications/GligoricETAL15PracticalRTS.pdf
- vitest-affected (reverse-dep, self-healing) — https://github.com/craigvandotcom/vitest-affected
- TDAD (grep-able impact map skill) — https://www.arxiv.org/pdf/2603.17973

## Method notes
- Legs run: A (Reddit, apify macrocosmos) + C (Exa). YouTube leg skipped per user. No A/B WebSearch probe.
- Reddit keyword search behaves OR/relevance — ~14 of 147 returned posts were on-topic; subagent filtered + pulled bodies on load-bearing threads. One link-post returned empty body (title/score only).
- No single source unifies code-index + test-selection + doc-drift into one framework — the cascade above is our synthesis across the three literatures.
