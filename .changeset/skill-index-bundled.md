---
"@piflow/core": minor
"@piflow/cli": minor
---

Instant marketplace search via a bundled index artifact, plus a concurrent live fan-out.

- **Bundled index** — `buildSkillIndex` (core) harvests the bounded bulk sources (topagentskills · skillregistry lite · claude-plugins pages) into a compact quality-ranked artifact (~6k docs, ~640KB gzipped) that the Vercel site publishes at `/skills-index.json`; `piflowctl skill index build [--out <file>]` builds it anywhere. The site regenerates it in its own `prebuild` on every deploy (standalone script, parity-gated against core's builder), and a scheduled workflow pokes a deploy hook twice a day.
- **`searchSkillIndex`** — a pure BM25-lite ranker (idf + tf-saturation, field weights, log-scaled popularity and quality boosts) shared verbatim by the GUI bundle and the CLI, so ranking never disagrees between surfaces. `RemoteSkillRow` gains optional `pop`/`quality`.
- **Staged fast path** — `searchRemote` tries the bundled index ALONE first (one cheap fetch, usually decisive — no live API touched); the live fan-out fires only as fallback, now CONCURRENT across sources and within them (claudskills' page window, agentskill's per-row details, skills-re's resolves), cutting live wall-clock ~11s → ~4s. A healthy zero-match no longer throws when a sibling source died.
- **GUI online lane** — loads the bundled artifact once (same-origin on the deployed site, canonical URL locally) and ranks client-side per keystroke; the live fan-out becomes an explicit "deep search" action. Every remote card now shows its `piflowctl skill add <source>` command in a visible copy pill.
