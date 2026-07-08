# Best Designs for Agentic System

A problem-indexed method library for building and optimizing agentic systems: harness/loop
engineering, context engineering, self-improvement loops, skill systems, supervision. Each entry
is a **card** — one problem class, the grounded practice that solves it, the evidence, and its
own track record of applications.

This library is the METHODS leg of a three-leg knowledge system: a product's per-node memory
records *what happened there* (self/history), its code slices record *how that code works*
(world/code), and this library records *which methods work in general* (portable, product-agnostic).
Consumers reference cards by pointer and read them fresh at decision time — never copy card
content into another store.

## Who reads this

Optimizer / fixer / supervisor / designer agents (and humans) deciding HOW to solve a problem:
"output format keeps failing", "node is too slow", "how do I structure skills", "what should the
accept gate compare". Cards are decision-time reference. **MUST NOT be injected into a worker
node's runtime prompt** — workers execute contracts; cards inform the agents that author and fix
those contracts.

## How to find the right card

1. Open `MEMORY.md` — the index. One line per card: title + when to reach for it. Scan hints, not files.
2. Open the matching card in `cards/`. Follow its `[[cross-refs]]` (each names a card `key`) for adjacent methods.
3. Frontmatter `aliases`/`tags` are the search surface. For ranked search, run the bundled OKF
   FIND engine: `cd cards && node _generate.mjs --find "<symptom or question>"` (add `--json` for
   a machine-readable list). Needs only `node`.
4. **A lookup MISS is a signal, not a dead end**: research the gap (subagents), distill the finding
   into a new card, commit. The library grows exactly at its failure points.

## The card contract

Format: `cards/_TEMPLATE.md` — copy it exactly. The hard rules:

- **One card = one problem class.** Body ≤ 80 lines. If it needs more, split it.
- **Card, never diary.** A card states current truth only. History lives in git; the commit
  message is the ground truth for every movement. Never append dated correction paragraphs —
  UPDATE the practice and commit.
- **Evidence is cited or absent.** Every number traces to a named source (paper id + year, or a
  named run/commit of ours). No uncited claims dressed as findings.
- **Practice stays product-agnostic.** Product/repo specifics may appear ONLY in Evidence or
  Applications lines as provenance, never inside Practice.
- **Applications are one-liners.** `YYYY-MM-DD · system · what was applied → observed outcome · ref`.
  Record UNDER-DELIVERY the same way — a card that under-delivers gets `status: under-delivering`
  and is the next card to fix, not to delete silently.

## Maintenance loop

1. Apply a card's practice somewhere → append ONE Application line (outcome + ref, improvement or not).
2. Card under-delivers → set `status: under-delivering`, then rewrite the Practice against the new
   evidence. Delete what is disproven; do not accumulate corrections.
3. Every change commits as `card(<key>): <movement>` — so `git log --grep '^card(<key>)'` is the
   card's full evolution. One card per commit.
4. After any card add/retitle/status change, refresh its line in `MEMORY.md` (hint = the card's
   frontmatter `description`, verbatim).
5. Raw research reports go to `research/` (dated, immutable annex). Cards cite them; cards never
   absorb them wholesale.

## Boundaries (MUST NOT)

- No product-specific practice (no piflow/game-omni paths or config inside Practice).
- Skills and other repos CITE cards; they never duplicate card content (a copy has no update gate to ride).
- No card without a Trigger a reader can match observationally.
- Never rewrite the whole library in one pass (rewrites rot indexes); cards move one commit at a time.
