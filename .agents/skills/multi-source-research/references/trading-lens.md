# Trading lens — multi-source-research overlay

Apply this overlay on top of the generic `SKILL.md` flow when the project or query is finance/trading flavored (crypto, perps, alpha, funding, regimes, market microstructure, MEV, on-chain, basis, Sharpe, backtests).

## Reddit leg — default subreddit list

Override the "pick 3-8" guidance in the Reddit template with this curated list:

- r/algotrading — strategy discussion, backtest critique
- r/quant — academic-leaning, paper-driven
- r/CryptoCurrency — sentiment only, filter hard for technical posts
- r/CryptoMarkets — macro + structure takes
- r/hyperliquid — venue-specific, fills/funding anecdata
- r/perpetualprotocol — perp DEX adjacent
- r/wallstreetbets — PnL screenshots only, ignore memes

Plus one site-wide reddit search for the topic.

## YouTube leg — channel suggestions when corpus is empty

If `list_repository` returns nothing relevant for a trading topic, recommend ingesting one of these (ask the user first — ingest is global and slow):

- One quant-research channel the user has previously flagged (check past sessions).
- A macro/markets long-form channel — only suggest if user has named one before.

**Do not hardcode channel handles in this overlay.** Channel quality is taste-dependent and decays; ask the user for a current pick rather than carrying a stale list.

## Exa leg — additional angles

Append to Phase 2 of the Exa template:

- One venue-specific angle: e.g. "Hyperliquid funding rates {YYYY}" / "Binance perp basis {topic}"
- One backtest/paper angle: "{strategy} backtest crypto perps Sharpe drawdown"
- One on-chain angle if topic touches MEV / liquidations / order flow

## Synthesis — invariant check

Add a "Next moves" bullet that flags which trading invariant (if any) the claims pressure-test. The canonical list from this user's CLAUDE.md:

1. **Out-of-sample is sacred.** Flag claims fitted on the same data they're evaluated on.
2. **Eval harness > strategies.** Flag claims that lean on a single backtest without hostile-evaluator framing.
3. **Forward-test before capital.** Flag claims that skip paper-trading.
4. **Costs and slippage are real (model 2-3×).** Flag headline Sharpes computed without realistic costs.
5. **Sample size > Sharpe.** Flag high-Sharpe claims with <500 trades.
6. **Regimes end.** Flag claims that assume the current regime persists.
7. **Risk overlay stays deterministic.** Flag claims that suggest ML-driven position sizing or stop-losses.

Format inside the brief:

```markdown
## Next moves
- One concrete experiment to run
- One follow-up search if needed
- **Invariant pressure points:** {list any of the 7 above that this topic strains}
```

## Crypto-only legs — Twitter (X) + Telegram

**These two legs fire ONLY under this lens** (crypto / perps / on-chain / funding / venue
topics). Do NOT run them in generic research — they are pay-per-result social feeds whose
signal is mostly relevant to fast-moving crypto markets. When the trading lens is active,
append them to the parallel fan-out so a trading run is **five legs** (A Reddit, B YouTube,
C Exa, **D Twitter, E Telegram**) launched in one message.

**Start from the curated registry, do not re-discover, and run one-shot.** Seed Leg D
profile pulls and Leg E channel lists from `references/crypto-handles.md` (vetted accounts,
channels, a "most-valuable shortlist", Actor practices, and recorded gotchas). Do not call
`fetch-actor-details`, run key-status checks, or decode expected 400 responses on every run.
Only fall back to live Exa/web discovery when the registry has no fit. Append each new vetted
handle or channel so the list compounds.

Use these routes:

- Twitter/X posts: prefer `mcp__apify-xquik__xquik--x-tweet-scraper`. Retain the existing
  `python3 ~/.config/apify/actors.py twitter ...` catalog command as fallback.
- Public follower relationships: use `mcp__apify-xquik__xquik--x-follower-scraper` only when
  the research question depends on audience overlap or source relationships. If unavailable,
  skip this optional enrichment.
- Telegram: keep the existing catalog route:
  `python3 ~/.config/apify/actors.py telegram <ch1>,<ch2>,... --max_results 30 --start_date "3 days"`.

Before each paid run, verify the current Store price and obtain any required spend approval.
For Xquik calls, set both `maxItems` and `callOptions.maxTotalChargeUsd`. For the Twitter
catalog fallback, keep `max_posts` at 20. For Telegram, keep channels at **≤ 4** and
`max_results` between **10 and 30** because the current Actor rejects values below 10.
Single-quote catalog queries to protect `$cashtags`. Never put an Apify token in a URL, prompt,
output, or log. If a social route or its credentials are unavailable, note the gap and skip it.
Never block the A/B/C legs.

### Leg D — Twitter (X) subagent prompt template

```
You are the Twitter/X leg of a multi-source-research fan-out. Topic: "{topic}".
Recency window: last {N} days. Trading lens is ACTIVE.

Build {query} for crypto: combine the cashtag(s) and the mechanism, e.g.
  "$BTC funding rate"  /  "$HYPE perp basis"  /  "{ticker} liquidations".

Preferred route: use ONLY `mcp__apify-xquik__xquik--x-tweet-scraper`.
Run one bounded search with two query variants:
{
  "mode": "search",
  "searchTerms": ["{query 1}", "{query 2}"],
  "time": {
    "since": "{YYYY-MM-DD}",
    "until": "{YYYY-MM-DD}"
  },
  "queryType": "Latest",
  "maxItems": 20,
  "maxItemsPerTarget": 10,
  "outputVariant": "rich",
  "fieldStyle": "camelCase",
  "outputPreset": "nested",
  "includeSearchTerms": true,
  "callOptions": {
    "maxTotalChargeUsd": 0.10
  }
}
Compute the dates from the requested recency window. To track specific KOLs, replace
`mode` and `searchTerms` with `"mode": "profileTweets"` and
`"twitterHandles": ["handle-a", "handle-b"]`; keep the same caps.

When the question depends on audience overlap or source relationships, make one optional
call to `mcp__apify-xquik__xquik--x-follower-scraper` for two relevant public accounts:
{
  "twitterHandles": ["handle-a", "handle-b"],
  "relation": "followers",
  "maxItems": 100,
  "maxItemsPerTarget": 50,
  "outputMode": "compact",
  "overlapMode": true,
  "includeTargetMetadata": true,
  "callOptions": {
    "maxTotalChargeUsd": 0.25
  }
}
Report aggregate overlap and only the public accounts needed to support a claim. Treat
follower relationships as weak signals, not endorsements. Never infer sensitive traits.

Fallback route: if the Xquik Tweet tool is unavailable, use ONLY Bash:
  python3 ~/.config/apify/actors.py twitter "{query}" --max_posts 20 --search_type Latest
Run 1-2 catalog calls with varied queries, or add `--username <handle>` and omit the query.
Do not substitute another follower scraper when the optional follower tool is unavailable.

For each tweet: read the text; weight by engagement (likes/retweets/replies if present)
and recency. Score 1-5: 5 = first-hand desk/PnL/positioning with specifics or a dated
on-chain claim; 1 = price-cheerleading / influencer noise / unsourced calls.
Discard obvious shill / airdrop-farming / bot spam.

Return ONLY this markdown — no preamble, no raw tweet dumps:

### Twitter findings ({N} tweets scanned)
- **[score/5]** {one-line thesis ≤20 words} — @{handle} — {date} — {url}
- ...

### Sentiment summary
{2-3 sentences: net tilt (bullish/bearish/contested) + any named desks/accounts}

### Surprising / contrarian
{tweets that cut against the crowd or flag a broken edge / venue issue}

### Audience overlap
{include only when follower enrichment ran; summarize aggregate overlap and limitations}

Cap output at 350 words. If a call returns nothing or errors, say so under "### Empty".
```

### Leg E — Telegram subagent prompt template

```
You are the Telegram leg of a multi-source-research fan-out. Topic: "{topic}".
Recency window: last {N} days. Trading lens is ACTIVE.

Use ONLY the Bash tool to run the global actor catalog (do not call any MCP):
  python3 ~/.config/apify/actors.py telegram {channels} --max_results 30 --start_date "{N} days"

Default {channels} (comma-separated, override per topic): @WatcherGuru,@binance_announcements,@cointelegraph
- If the topic names a VENUE, add its official channel (e.g. Hyperliquid → @HyperliquidX_official-style handle the user confirms).
- If on-chain / whales, add a whale-tracking channel.
Keep channels ≤ 4. Each returned item has: text, sender, view_count, reactions, date, id, urls.

For each message: read text; weight by view_count + reactions; favor announcements that
move markets (listings, delistings, halts, hacks, regulatory). Score 1-5: 5 = primary
market-moving announcement or dated on-chain alert; 1 = ad / referral / recycled news.
Build a source link as t.me/<channel>/<id> when no url is present.

Return ONLY this markdown:

### Telegram findings ({N} messages scanned)
- **[score/5]** {one-line ≤20 words} — {channel} — {date} — {url}
- ...

### Market-moving items
{bullets — any listing/halt/hack/regulatory item, with the channel + timestamp}

### Cross-channel echoes
{claims appearing in ≥2 channels — higher confidence}

Cap output at 350 words. If a channel returns nothing or errors, list it under "### Empty".
```

### Synthesis — crypto leg tags

In the brief's `## Sources` section add **### Twitter** and **### Telegram** subsections, and
extend the source tags in "What's working / What's broken" with `[T]`=twitter, `[TG]`=telegram
alongside the existing `[R]/[Y]/[E]`.

## Default trading-lens scope hint

When announcing scope at Step 1, prefer:

> "Scoping: last 30d, trading lens, deep dive — five legs in parallel (Reddit, YouTube, Exa, Twitter, Telegram)."

over the generic phrasing.
