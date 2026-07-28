---
name: multi-source-research
description: Fan out a research query across three source types — Reddit (practitioner sentiment), local YouTube transcript RAG via yt-rag (curated long-form), and Exa web search (semantic crawl) — then synthesize a distilled brief. Use when the user wants the newest/highest-quality information on a topic — vendor diligence, "what's actually working right now," tooling shootouts, technique comparisons, library evaluations, strategy/idea research, "is X dead," "compare X vs Y." Triggers on "research", "find approaches", "what's working", "scan reddit", "scan youtube", "deep dive", "latest on X", "is X dead", "compare X vs Y", "evaluate X."
requires: [read, write, mcp.exa:web_search_exa]
allowed: [read, write, bash, mcp.exa:web_search_exa, mcp.exa:web_fetch_exa, mcp.apify-xquik:xquik--x-tweet-scraper, mcp.apify-xquik:xquik--x-follower-scraper]
display:
  label: Multi-Source Research
  icon: 🔎
---

# Multi-Source Research — three-source fan-out

Run parallel deep searches across **Reddit**, the **local YouTube RAG (`yt-rag`)**, and **Exa** (with native `WebSearch` as a comparison probe), then synthesize into one brief. Main agent stays lean: subagents do the raw fetches and return distilled bullets **plus the concrete specifics worth keeping** (see the detail-preservation rule in Step 3). The written brief favors **completeness over brevity** — it is a reusable artifact, not a one-off chat answer (see Step 5).

## Prerequisites

MCPs (verify with `claude mcp list`; Xquik is optional):

| MCP | Tools | Install if missing |
| --- | --- | --- |
| `yt-rag` | `mcp__yt-rag__list_repository`, `mcp__yt-rag__search`, `mcp__yt-rag__ingest_channel` | already user-scope; if absent, ask the user (custom server at `/Users/tk/Desktop/yt-rag`) |
| `exa` (HTTP) | `mcp__exa__web_search_exa`, `mcp__exa__web_fetch_exa`, `mcp__exa__deep_search_exa`, `mcp__exa__web_search_advanced_exa` | `claude mcp add --transport http exa "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa,deep_search_exa,web_search_advanced_exa" --header "x-api-key: $EXA_API_KEY" -s user` |
| `apify-reddit` (HTTP) | `mcp__apify-reddit__macrocosmos--reddit-scraper` (wraps the Apify actor `macrocosmos/reddit-scraper`) | `claude mcp add --transport http apify-reddit "https://mcp.apify.com/?tools=macrocosmos/reddit-scraper" --header "Authorization: Bearer $APIFY_TOKEN" -s user` |
| `apify-xquik` (HTTP, optional trading overlay) | [`xquik/x-tweet-scraper`](https://apify.com/xquik/x-tweet-scraper), [`xquik/x-follower-scraper`](https://apify.com/xquik/x-follower-scraper) | `claude mcp add --transport http apify-xquik "https://mcp.apify.com/?tools=xquik/x-tweet-scraper,xquik/x-follower-scraper" --header "Authorization: Bearer $APIFY_TOKEN" -s user` |

Keep `APIFY_TOKEN` in the authorization header. Never put tokens in MCP URLs, prompts, output, or logs.

> Xquik is an independent third-party service. Not affiliated with X Corp. "Twitter" and "X" are trademarks of X Corp.

> **Why not `reddit-mcp-buddy`?** As of May 2026 Reddit edge-blocks all anonymous/unauthenticated access (403 because OAuth is missing, not because of the IP). This breaks buddy's anonymous mode and live-scrape actors like `trudax/reddit-scraper-lite`. `macrocosmos/reddit-scraper` serves pre-harvested data, so it avoids the blocked live edge. See `[[reddit-data-access-2026]]` in memory.

If `apify-reddit` is missing, **do not block** — run the YouTube + Exa legs and note the gap. Ask the user whether to install before retrying.
If `apify-xquik` is missing, retain the existing Twitter catalog fallback and skip follower enrichment. Never block the Reddit, YouTube, or Exa legs.

## Domain overlays

This skill is domain-agnostic by default. If the working directory or topic is finance/trading flavored, **read `references/trading-lens.md`** before launching legs and merge its Reddit, YouTube, Exa, and invariant defaults. Detection cues:

- Project `CLAUDE.md` mentions trading, quant, perps, alpha, crypto, market making, Hyperliquid, funding rates.
- User query names a financial instrument, exchange, regime, drawdown, Sharpe, basis, or backtest.

Decide the paid social scope separately. Launch Twitter/X and Telegram only
when the project or query explicitly names crypto, a token or chain, on-chain
activity, DeFi, perps, funding rates, MEV, or a crypto venue. Generic equities,
portfolio, Sharpe, or backtest research stays on legs A–C. If neither finance
cue applies, skip the overlay and use the generic templates as written.

## Tool restriction

ONLY use these tools inside this skill:

- `mcp__yt-rag__*` (search, list_repository, ingest_channel)
- `mcp__exa__web_search_exa`, `mcp__exa__web_fetch_exa` (default)
- `mcp__exa__deep_search_exa` (with `outputSchema` — only when you need structured columns, see §"Advanced Exa")
- `mcp__exa__web_search_advanced_exa` (with `category`/date/domain filters — only when filtering matters)
- `mcp__apify-reddit__macrocosmos--reddit-scraper` (the Apify Reddit actor — the ONLY Reddit tool)
- `mcp__apify-xquik__xquik--x-tweet-scraper` (preferred crypto-only Twitter/X post route)
- `mcp__apify-xquik__xquik--x-follower-scraper` (optional crypto-only public network enrichment)
- `WebSearch` — **only** as the A/B probe described in §"Exa vs WebSearch"
- `Bash`: **only** run the global Apify actor catalog (`python3 ~/.config/apify/actors.py …`) for the crypto-only Telegram leg and the existing Twitter fallback defined in `references/trading-lens.md`. Never use it for anything else.
- `Agent` (for subagent fan-out), `Write` (for the brief file)

Do NOT use `WebFetch` for content already returned by Exa/Reddit/yt-rag. Do NOT mix in random web tools.

## Architecture: three base legs, one synthesis

```text
Main agent (lean — never reads raw posts/chunks)
├── Leg A: Reddit subagent      ──┐
├── Leg B: YouTube (yt-rag)     ──┤  launched IN PARALLEL via Agent
├── Leg C: Exa web              ──┤  (+ optional WebSearch A/B probe)
├── Leg D: Twitter/X subagent   ──┤  crypto scope only
├── Leg E: Telegram subagent    ──┘  crypto scope only
└── Synthesis: merge → brief.md → present to user
```

**Crypto scope adds two legs.** When the trading lens and the explicit crypto
predicate above are both active, legs **D Twitter** and **E Telegram** run in
the SAME parallel message. Leg D prefers the Xquik Actor tools and retains
`actors.py` as its fallback. Leg E keeps using the catalog. They never run in
generic or non-crypto finance research.

**Why subagents?** A single Reddit thread or 5 yt-rag chunks can be 5-20k tokens. Three legs at 30+ items each = 100k+ tokens of raw text. Subagents process, dedupe, and return ~30 distilled bullets per leg plus a `### Keep verbatim` block of concrete specifics (≤2-3k tokens each). Main stays well under ~20k tokens regardless of query depth — while still receiving the details the final guide needs.

**Parallelism:** launch A–C in one message for generic or non-crypto finance
research. When crypto scope is active, launch A–E in one message. Do not
serialize.

## Step 1 — Classify and scope the query

Before fan-out, decide three things:

1. **Recency window.** "Latest on X" → last 30d. "Is X dead?" → 6mo. "How does X work?" → no recency filter.
2. **Domain lens.** Check the overlay cues above. If the trading lens fires,
   load `references/trading-lens.md` and apply its defaults. Independently set
   `crypto_scope=true` only when the explicit crypto predicate matches.
3. **Depth.** Quick scan = top_k=5 per leg, ≤6 Exa results. Deep dive = top_k=15, 20+ Exa results, follow-up `web_fetch_exa` on the best 3 URLs.

Tell the user the scope in one line before launching: *"Scoping: last 30d,
{lens}, deep dive: {three generic/non-crypto | five crypto} legs in parallel."*

## Step 2 — Inventory check + auto-enrich (yt-rag)

Before the YouTube leg runs, call `mcp__yt-rag__list_repository` **once** in main context (it's cheap — namespaces + counts, no chunks). Use the output to pick relevant namespaces for the subagent's queries.

**If the corpus is THIN for the topic** (no namespace fits, or the best matches are clearly off-domain), do NOT silently accept a thin leg — but enrichment is **opt-in**:

- **Only run the discover → ingest → search enrichment when the user explicitly asked for a YouTube search / to include YouTube.** If the user did not ask for YouTube and the corpus is thin, just note the gap in the synthesis and skip the leg — never auto-ingest unprompted (ingestion is a slow side-effect that mutates the global corpus shared across all repos).
- When enrichment IS warranted, run the loop instead of asking for a channel handle:
  1. **Discover (Exa).** Spawn an Exa subagent to find the highest-signal YouTube videos on the topic — specific watch URLs + `@handles`, scored 1–5, 2025–2026, rejecting hype/news-roundups/off-topic.
  2. **Ingest (curated).** Prefer `mcp__yt-rag__ingest_videos(urls, namespace)` into a **themed** namespace `yt_<topic_slug>` — cherry-picking on-topic videos across creators beats `ingest_channel`'s 30 mostly-off-topic uploads. Use `ingest_channel` / `ingest_channels` only when a whole creator is on-topic. Surface the candidate list, but once the user has asked for YouTube a curated ingest needs no per-video sign-off.
  3. **Search.** Run Leg B (Step 3) scoped to the new namespace.

Compounding: the corpus is global, so an enrichment ingest benefits every future run. The yt-rag MCP server has **no web/Exa access**, so the discovery half MUST live here in the skill — the server only exposes `ingest_videos` / `ingest_channel(s)`.

## Step 3: Launch A–C or A–E in parallel

Use one message with three `Agent` calls for generic or non-crypto finance
research. Use one message with five calls only when crypto scope adds D and E.
Templates are below and in `references/trading-lens.md`. Each subagent must
return a structured markdown block, not raw text.

**Detail-preservation rule (applies to ALL legs and overrides any "Return ONLY" or "no raw quotes" line in the templates).** The word caps keep the *ranked-findings bullets* lean. They are not a license to discard substance. Every leg must also append a **`### Keep verbatim`** block with the concrete specifics worth carrying into the final guide. Preserve exact snippets, numbers, named tools, formats, fields, precise phrasings, and short high-signal quotes. Attach the source URL, creator, or subreddit. This block does not count toward the ranked-bullet cap, but A–C must keep it within 2,000 words. Paid social legs D and E use the stricter item and character budgets in `references/trading-lens.md`. The synthesizer can cut a detail, but it cannot recover one a leg never returned. Preserve the specific within those budgets.

### Leg A — Reddit subagent prompt template

```text
You are the Reddit leg of an multi-source-research fan-out. Topic: "{topic}".
Recency window: last {N} days. Domain lens: {lens or "generic"}.

Use ONLY the `mcp__apify-reddit__macrocosmos--reddit-scraper` tool. It returns
POSTS (title, score, url, body/selftext) — there is NO comment-tree tool, so
work from titles + bodies + scores. Input shape:
  { "subreddits": ["sub1","sub2"],   // names without r/; omit for site-wide
    "keyword": "{search terms}",       // optional; omit to just browse the subs
    "limit": 15,                       // paid-result cap; verify current Store pricing
    "sort": "top" }                    // "top" | "hot" | "new" — use "top" for recency scans

Make 2 calls in parallel (one message):
  1. Subreddit scan — subreddits = 3-8 most relevant subs (one broad catch-all
     like r/{broad-sub-for-topic} + 2-5 niche), keyword="{topic}", sort="top", limit=15.
     {if lens overlay provided a subreddit list, use it instead of picking}
  2. Site-wide scan — omit `subreddits`, keyword="{topic}", sort="top", limit=10
     (catches relevant posts in subs you didn't list).

For each post returned:
- Read title + body; weight by score.
- For a high-signal post needing more depth, make ONE follow-up call with
  `{ "url": "{post url}" }` to pull full content. Do this sparingly (cost).
- Flag: practitioner reports, broken-edge confessions, contrarian dissent,
  vendor warnings, "what's actually working" posts
- Score 1-5: 5 = first-hand result with specifics; 1 = noise/recycled news

Return this markdown — no preamble (short high-signal verbatim snippets belong in the Keep-verbatim block):

### Reddit findings ({N} threads scanned)
- **[score/5]** {one-line thesis in ≤20 words} — r/{sub}, {date} — {url}
- ...

### Sentiment summary
{2-3 sentences on net tilt: bullish/bearish/mixed/contested, with named camps}

### Surprising contradictions
{bullet anything where high-karma comments contradict the OP or each other}

### Keep verbatim
{concrete specifics worth carrying into the final guide: exact techniques, numbers, named tools/formats, and short quotes. Include each post URL. This does not count toward the bullet cap; keep it within the shared 2,000-word ceiling.}

Cap the bullet sections at ~400 words. Keep `### Keep verbatim` within the
shared 2,000-word ceiling. If a subreddit returns nothing, list it under
`### Empty`.
```

### Leg B — YouTube (yt-rag) subagent prompt template

```text
You are the YouTube leg of an multi-source-research fan-out. Topic: "{topic}".

Use ONLY mcp__yt-rag__search. Namespaces in scope: {namespace_list_from_step_2}
(omit `namespace` to search the full corpus when no scope fits).

Run 3-5 search() calls in parallel, varying query phrasing:
- Literal: "{topic}"
- Semantic rewrite: "{rewrite that names the mechanism, not the buzzword}"
- Contrarian: "why {topic} doesn't work" / "{topic} broken" / "{topic} dead"
- Adjacent: pick one nearby concept (e.g. for "funding rate MR" → "basis trade")
Use top_k=10 per call.

For each chunk returned:
- Read the prefix [Channel — "Title" — date — MM:SS] and the content
- Score 1-5: 5 = creator gives concrete numbers/code/timing; 1 = vibes only
- Dedupe by video_id (keep highest-scoring chunk per video)

Return this markdown:

### YouTube findings (top {N} of {M} chunks)
- **[score/5]** {one-line takeaway in ≤25 words} — {Channel} — {date} — {source_url}
- ...

### Cross-creator consensus
{2-3 bullets — claims made by ≥2 independent creators}

### Lone-wolf claims
{bullets — interesting claims made by exactly one creator, worth checking}

### Keep verbatim
{concrete techniques, steps, and numbers a creator actually demonstrates. Name the channel and keep the MM:SS deep-link. This does not count toward the bullet cap; keep it within the shared 2,000-word ceiling.}

Cap the bullet sections at ~400 words. Keep `### Keep verbatim` within the
shared 2,000-word ceiling. If a query returns nothing, suggest one channel to
ingest.
```

### Leg C — Exa subagent prompt template

```text
You are the Exa leg of an multi-source-research fan-out. Topic: "{topic}".

Use ONLY mcp__exa__web_search_exa and mcp__exa__web_fetch_exa.

Phase 1 — broad search (one call):
  web_search_exa(query="{describe the IDEAL page, not keywords}", numResults={10|20})
  Exa works best with descriptive page-shape queries:
    GOOD: "technical blog post analyzing funding rate mean-reversion in crypto perps with backtest code"
    BAD:  "funding rate strategy crypto"

Phase 2 — targeted searches (run in parallel, 2-4 calls):
  - One academic/paper angle: "research paper on {mechanism}"
  - One github angle: "github repo implementing {topic}" or "code example {topic}"
  - One substack/blog angle: "{topic} substack analysis 2025"
  - {if lens overlay specifies additional angles, append them here}

Phase 3 — fetch the best 1-3 URLs with web_fetch_exa(maxCharacters=4000)
  Only fetch if the search highlight is insufficient. Skip paywalled / login-walled.

Return this markdown:

### Exa findings ({N} pages reviewed)
- **[score/5]** {one-line thesis ≤20 words} — {domain} — {date if known} — {url}
- ...

### Highest-signal source
{1 paragraph on the single best page found, with the key claim and any numbers}

### Gaps
{what the search did NOT surface — code? recent data? institutional view?}

### Keep verbatim
{concrete techniques and example snippets (prompt fragments, config, code, exact structures/figures) extracted from the pages. Include each URL. Preserve specifics rather than paraphrasing them away. This does not count toward the bullet cap; keep it within the shared 2,000-word ceiling.}

Cap the bullet sections at ~400 words. Keep `### Keep verbatim` within the
shared 2,000-word ceiling.
```

## Step 4 — Optional: Exa vs WebSearch A/B probe

When the user is evaluating Exa (default until they say otherwise), spawn a **fourth** small subagent that runs the *same primary query* through native `WebSearch` and returns the top 5 results in the same format. Then in the synthesis section, compare:

- **Overlap:** how many URLs appear in both Exa and WebSearch top-10
- **Unique-to-Exa:** URLs Exa found that WebSearch missed (and vice versa)
- **Quality tilt:** which set leans more toward primary sources / code / data vs SEO blogspam

Skip the probe on deep dives (too much overhead) or when the user has already decided to commit to Exa.

## Step 5 — Synthesize

Main agent receives the A–C blocks, optional A/B probe, and the D/E blocks when
crypto scope is active. Each block includes findings bullets and its
`### Keep verbatim` section. Do **not** read raw chunks again. You produce
**two artifacts at different altitudes**:

- **Chat reply = concise.** Print the resolved file path, a tight TL;DR (3-5 bullets), and the 2-3 most decision-relevant findings. This is the *only* place brevity is the goal.
- **Written file = comprehensive. Completeness over brevity.** This file gets reused later, so do NOT strip detail to look clean or to seem efficient. Fold in **every crucial, novel, or worth-keeping detail** the legs surfaced — especially everything in the `### Keep verbatim` blocks: concrete techniques, exact numbers, named tools/formats, example snippets, edge cases, contradictions. **Give each claim an inline source reference** — the `[R]`/`[Y]`/`[E]` tag *and* the specific creator/site/subreddit (and URL/timestamp where available) — so any reader can trace it. Cut only true noise and duplication, never substance. When unsure whether a detail earns its place, keep it (tagged) rather than cut it.

Default file template — these sections are **minimums, not caps**; expand any section as far as the material warrants:

```markdown
# {topic} — research brief
_scope: {recency}, {lens}, {depth} • generated {date}_
_source tags: [R]=Reddit • [Y]=YouTube (yt-rag) • [E]=Exa web • [X]=Twitter/X when active • [T]=Telegram when active. Inline citations name the specific creator/site so every claim is traceable._

## TL;DR
{3-5 bullets — highest-confidence claims that survived ≥2 sources}

## Key findings (in depth)
{The substance — one subsection per major theme. Under each, ALL the concrete detail for that
theme: techniques, mechanisms, exact numbers, named tools/formats, example snippets, caveats —
each with an inline source ref. Prose or bullets, whatever carries the detail best. No length cap.}

## What's working (claimed)
{bullets, each tagged + named source}

## What's broken / contested
{bullets — broken edges, vendor warnings, cross-source contradictions, each sourced}

## Numbers worth verifying
{every specific number — perf, cost, throughput, token counts, %, dates — with where it came from}

## Next moves
- One concrete experiment or follow-up action
- One follow-up search to run if needed
- {if lens overlay specifies an invariant check, include its bullets here}

## Sources
### Reddit
- {bullets with urls}
### YouTube
- {bullets with deep-link urls — keep the MM:SS timestamps}
### Exa
- {bullets with urls}
### Twitter/X (crypto scope only)
- {bullets with tweet urls}
### Telegram (crypto scope only)
- {bullets with channel and message references}

## Method notes
- Legs run: {A/B/C for generic or non-crypto finance, A/B/C/D/E for crypto, ± A/B probe} • Empty legs: {any}
- {if A/B probe ran} Exa vs WebSearch: {overlap %, tilt}
```

**Guide / playbook / reference mode.** When the user asks for a "guide", "design guide", "playbook", "reference", "best practices", "how-to", or anything meant to be read and reused later (not a one-off answer), upgrade the file beyond the template above:
- Add a **"Ready-to-paste examples / worked scaffolds"** section: concrete, copyable artifacts (prompt snippets, configs, code, templates) reconstructed from the legs' findings — each block annotated with the exact source it came from.
- Add a **"Practice → source quick-reference" table** with columns `Practice | Why it works | Source | Leg`, one row per actionable recommendation, so a future reader can trace every practice to its origin.
- Preserve the example snippets from the `### Keep verbatim` blocks **verbatim** — don't paraphrase the specifics away.
- Add a short "how to read this" note up top, and state honestly where claims are practitioner-experience vs. benchmarked, so readers know what to trust.

**Output path.** If the current working directory is inside a git repo, write to `research/{slug}-{YYYY-MM-DD}.md` (relative to repo root — `git rev-parse --show-toplevel`). Create `research/` if missing. Otherwise fall back to `~/research/{slug}-{YYYY-MM-DD}.md`. Print the resolved path and the TL;DR in the chat reply.

## Source-strength cheat sheet

Use this when deciding how much to weight a claim:

| Source | Strongest for | Weakest for | Trust filter |
| --- | --- | --- | --- |
| Reddit | recent sentiment, broken-edge confessions, real-PnL anecdata, vendor reputations, "is X dead" | numbers, code, anything older than 6mo (decays fast) | upvotes alone lie — read top dissent |
| YouTube (yt-rag) | curated long-form analysis from creators *you trust*, mechanism explainers, regime takes | breadth (only what's ingested), freshness for un-ingested channels | check date; ingest if stale |
| Exa | papers, github, substacks, primary sources, niche blogs, things native search buries | conversational opinion, very recent reddit/twitter | describe the ideal page, not keywords |
| WebSearch | breaking news, mainstream coverage, official docs | depth, niche sources | use mostly as A/B probe vs Exa |

## Advanced Exa — when to escalate beyond `web_search_exa`

Default to `web_search_exa` + `web_fetch_exa`. Escalate only when the query shape demands it:

**Use `web_search_advanced_exa`** when you need filters that the basic search can't express:
- Date-bounded: `startPublishedDate: "2025-10-01"` for "what's been published since {event}"
- Category-bounded: `category: "financial report"` for SEC filings / earnings; also accepts `research paper`, `github`, `news`, `pdf`, `personal site`, `linkedin profile`, `company`
- Domain-locked: `includeDomains: ["github.com"]` or `includeDomains: ["substack.com"]` for source isolation
- Required-text: `includeText: ["funding rate"]` (single-item arrays only — multi-item 400s)
- Constraint: `excludeText` is NOT supported on the `financial report` category specifically

**Use `deep_search_exa`** when you need structured columns extracted across many sources (the lead-gen pattern). Required params on every call: `structuredOutput: true`, `numResults: 50`, `highlightMaxCharacters: 1`, `type: "deep"`. Schema caps: ≤10 properties total across all nesting; array items must be flat primitives only. Every string field in the schema MUST carry a word/char limit in its description (e.g. "in 12 words or less") — otherwise responses bloat. **Always spawn a subagent for `deep_search_exa`** — one call returns 30-50 rows (5-15k tokens) and you don't want that in main context.

Don't reach for these tools for ordinary "find me an article about X" queries — basic `web_search_exa` is faster and cheaper.

## Performance & limits

- A generic run uses 3 parallel legs. A trading-lens run uses 5 parallel legs.
- Each leg subagent stays under 8 tool calls. If a leg needs more, it's drifting — kill and re-scope.
- Reddit (Apify `macrocosmos`) is pay-per-result. Verify current Store pricing before a run. One call fans across ALL listed subreddits, so keep `subreddits` ≤8 and `limit` ≤15 per call. Two calls per leg is plenty.
- yt-rag `ingest_channel` is slow (30s-2min for 30 videos). Never call it inside a fan-out — only on explicit user OK. Remember: the corpus is global, so an ingest in one repo benefits every future run.
- `web_fetch_exa` costs more than `web_search_exa`. Cap at 3 fetches per leg.

## Common failure modes

- **Echo chamber.** Multiple legs repeat one source. Down-score and note it in synthesis.
- **Stale yt-rag.** If `published_at` on every chunk is >3mo old for a fast-moving topic, recommend ingest before trusting.
- **Vendor astroturf.** Reddit posts shilling a paid product. Score 1, flag in "What's broken / contested".
- **Exa hallucination via summary.** If `web_search_exa` returns a highlight that sounds too clean, fetch the URL with `web_fetch_exa` and verify before quoting.
- **Empty corpus.** If yt-rag returns zero hits and no namespace matches, don't fake it — say so and skip the leg.
