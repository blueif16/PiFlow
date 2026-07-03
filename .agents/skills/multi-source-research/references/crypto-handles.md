# Crypto information-channel registry — curated handles for the trading-lens X/TG legs

Persistent, **EXPANDABLE** list of vetted Twitter accounts + Telegram channels that the
multi-source-research **Twitter (Leg D)** and **Telegram (Leg E)** legs should **START FROM**
each run — so we stop re-discovering channels every time and stop missing known-good sources.

**How to use:** when the trading lens fires, seed Leg D `--username` pulls + Leg E `telegram`
channel lists from the ⭐⭐+ entries below. **After every run, APPEND any new vetted find here**
(with what it's good for + a star rating + today's date), and prune sources that have decayed.
Stars: ⭐ = situational/noisy · ⭐⭐ = useful · ⭐⭐⭐ = high-signal, prioritize.

---

## How to use the X/TG actors (best practice)
1. **One-shot — don't re-probe.** Mechanics + gotchas are recorded here. Run the scrape directly; **skip `fetch-actor-details`, key-status checks, and 400-decoding** — that was first-time gotcha discovery, now done. (Only re-probe if an actor visibly changed.)
2. **Start here; expand via Exa only if needed.** Seed from the shortlist below. Do live discovery (Exa/web) **only** when the registry has no fit for the topic — then append the find back.
3. **Intent = candidate-selection / best-practice insight, NOT live emotion.** Go deep (10+ calls) — cost is trivial (~$0.0003/tweet, ~$0.05/TG-channel-start). Under-calling the focus legs "for cost" is the wrong instinct.
4. **Twitter mechanics:** `--search_type Top` for methodology quality (`Latest` for live); `--username <handle>` for the method accounts (omit the query); single-quote queries to protect `$cashtags`; free keys cap `max_posts` at 20. **Filter on account-age + follower floor, NOT `verified`** (spam is blue-checked). `created_at` + cashtag entities present → mention-velocity harvestable; engagement counts (fav/RT/reply) come back **null** → no engagement-weighting from this feed.
5. **Telegram mechanics:** `max_results` **10–30** (floors at 10); **$0.05 start/channel** → ≤4 channels/run, comma-listed in one call; `--start_date "N days"`. Returns text + ISO date + `view_count` + emoji `reactions` + reply/forward counts. **News channels LAG** (context only); for the leading families (signal/pump) you MUST build an **append-only edit/delete-tracking ingest first** (channels delete losing calls + edit targets → survivor bias; the actor exposes no edit flag).
6. **Keys:** rotate automatically (credit-aware); `python3 ~/.config/apify/apify_rotate.py status` if you suspect exhaustion.

## ⭐ Most-valuable shortlist (the official recurring set)
**Twitter — scrape via `--username` (methodology, high-value):**
- Tier-1: **@Keisan_Crypto** + **@kriptoholder** + **@abetrade** (spot-vs-perp CVD split = the sharpened #2), **@kimlage** (OOS gauntlet discipline), **@Alphractal** (slower-horizon mid-cap rotation delta = NEW-B).
- Tier-2 order-flow: **@QuantFlows_xyz** (level-gate), **@MoFibz** (6-step checklist), **@sportytechworld**.
- Liq-cascade (⚠️ #6 demoted to beta — discretionary read only): **@0xQuantyx**, **@simo_vanov**.
- _Skip for recurring scrape: HYPE live-sentiment accts (@anglio etc.) — situational. ❌ @Yuriy_Biko (shill)._

**Telegram — by purpose:**
- Crowd-emotion / message-velocity feature R&D: **@WatcherGuru** (rich reactions + burst clustering) — note it LAGS price (context).
- Pump-fade detection (candidate #4): **@crypto_pumps_p** (machine-detectable countdown→reveal).
- Signal-call extraction (candidate #3, only if greenlit): **@wolfoftrading** — but needs **8–15 channels aggregated** for sample size, so not worth official recurring scrape yet.
- _Listings (market-moving): @binance_announcements. Drop @bigpumpsignal (junk)._

**If we need more channels:** Exa-search the topic, verify the handle loads, append it below with a rating + date.

---

## Twitter / X — methodology & leading-signal practitioners
_Pull with `--search_type Top` (quality) or `--username <handle>` (timeline). Single-quote queries to protect `$cashtags`._

### Order flow / CVD / microstructure (candidate #2)
> _Deep-pass refinement 2026-06-04: the LEADING read is the **spot-vs-perp CVD SPLIT**, **size-filtered by clip** (100k/1M/5M), **level-gated**. Sign is **momentum, not fade** (contrarian IC −0.12). Public naive-VPIN edge **decayed to net-negative in 2026** + half-life ~5s → test where IC dies, model cost-hostile (4 bps taker floor)._
- **@Keisan_Crypto** — spot-delta-vs-perp-delta (spot leads, perp follows); best single methodology acct found — ⭐⭐⭐ — 2026-06-04
- **@kriptoholder** (~37.7k) — spot-vs-perp CVD divergence + Coinbase-Premium confluence; cleanest codeable spot-lead read — ⭐⭐⭐ — 2026-06-04
- **@abetrade** (~198k) — cross-asset CVD-absorption + spot-premium reads; large/established — ⭐⭐⭐ — 2026-06-04
- **@QuantFlows_xyz** — order-flow/CVD checklists; CVD divergence needs a LEVEL GATE (else noise) — ⭐⭐ — 2026-06-04
- **@MoFibz** — absorption / delta-rotation at value-area edges; 6-step codeable entry checklist — ⭐⭐ — 2026-06-04
- **@sportytechworld** (~0.9k) — futures-vs-spot CVD health gauge + OI/price divergence — ⭐⭐ — 2026-06-04
- **@QuantFlows_xyz** — UPGRADE → ⭐⭐⭐ (2026-06-14): strongest order-flow acct this window; **resting-limit liquidity-heatmap** = a directly-codeable **depth-asymmetry / book-pressure** feature (Σ resting-bid vs ask notional in price bands) = candidate **L2-C** — 2026-06-14
- **@Mubaraqkhan** — real-time Order Book Imbalance (bid/ask volume skew across pools) + depth-collapse detection = clean **depth-conditioned OFI / OBI** construct (candidate L2-B) — ⭐⭐ — 2026-06-14
- **@codedtrader** ("Range Radar") — daily cross-sectional **+deviation / −downside-asymmetry** breadth across a tracked universe = slower-horizon wide-universe rotation/dispersion (fits L09) — ⭐⭐ — 2026-06-14
- ⚠️ **Window note 2026-06-14:** @Keisan_Crypto was price/news cheerleading (no depth/CVD method this window); @Alphractal was retweeting macro, not the 300-asset rotation deltas. Don't demote on one window — re-check next run.
- ❌ **@Yuriy_Biko** — DEMOTED 2026-06-04: mostly shill/livestream/"WLD long" promo, thin mechanics despite the order-flow handle name. Skip as a method source.

### Slower-horizon / mid-cap rotation (candidate NEW-B — fits the 4h/wide-universe hunt, escapes sub-minute decay)
- **@Alphractal** (~14.3k) — Buy/Sell Pressure Delta crossover (90d aggressive-order delta deep-neg→pos) flagged mid-cap moves before funding/CEX-vol/CT; 300+ assets, orthogonal to BTC order-flow — ⭐⭐⭐ — 2026-06-04
- **@origamitech_** (~2.9k) — HL/HIP-3 RWA-perp structure: hourly funding (4% cap) vs 8h CEX breaks CEX-trained bots (candidate NEW-C, funding-speed arb) — ⭐⭐ — 2026-06-04

### Liquidation-cascade fade (candidate #6 — ⚠️ DEMOTED 2026-06-04: systematic fade is leveraged BETA, not alpha — OOS Sharpe 3.58 → +0.98%/p=0.18 net of BTC. Good discretionary read, weak systematic edge; revisit only beta-neutral.)
- **@0xQuantyx** — reproducible liq-cascade stack (long-liq-dominance %, spot CVD, funding-into-dump, OI new highs as price falls); fade the REACTION (spot CVD turns +, funding cools, premium recovers), not the flush — ⭐⭐⭐ — 2026-06-04
- **@simo_vanov** (~1.8k) — best mechanistic cascade explainer: self-funding flush → fast exhaustion → snap-back (fadeable) vs slow selling w/o delta spike = repositioning (don't fade) — ⭐⭐ — 2026-06-04
- **@Aivoraex** (~18.8k) — liquidation-heatmap zone pre-mapping (round numbers / prior lows / 5-10x leverage piles); vendor-tilted but mechanics sound — ⭐ — 2026-06-04

### Validation / hostile-harness discipline
- **@kimlage** — public hypothesis gauntlet, 0/111 survived cleanly; **forkable hostile-harness repo** — ⭐⭐⭐ — 2026-06-04
- **@getquantvue** — "tuning off backtests = measuring memorization, not edge" — ⭐⭐ — 2026-06-04
- **@Muhanadabulhusn** — never persist raw LLM extraction as fact; validate before store — ⭐⭐ — 2026-06-04

### HL smart-money flow (candidate #1) — cautions
- **@StratiumSol** — naive copy-trade/wallet-mirroring makes you exit liquidity; only published-PnL curation works — ⭐⭐ — 2026-06-04

### Live HYPE / positioning (lower priority — sentiment, not method)
- **@anglio, @mystcapital, @0xhyperfury, @OttoSuwen** — HYPE positioning + insider-skepticism ("KOLs larping for HL don't hold $HYPE" = a fade angle) — ⭐ — 2026-06-04

### ❌ AVOID (noise / manipulation)
- @fake_aio + "NEW KOL joined, X% wr" botspam; Solana pump-vote spam; "verified copy-trade" mirroring services.
- **Verified badge is near-useless now** (spam is blue-checked) → filter on **account-age + follower floor**, not `verified`.

---

## Telegram — channels
_Actor `truefetch/telegram-channel-message` **floors `max_results` at 10** (pass ≥10 or it 400s); **$0.05 actor-start per channel** → keep ≤4/run._

### News / market-moving CONFIRMERS (lag price — context only, not leading)
- **@WatcherGuru** — liquidations, macro, fear/greed; ~36 msgs/3d; rich emoji reactions (crowd-emotion feature) — ⭐⭐ — 2026-06-04
- **@binance_announcements** — listings/delistings (genuinely market-moving on the listed pair) — ⭐⭐ — 2026-06-04
- **@cointelegraph** — general crypto news — ⭐ — 2026-06-04

### Signal / buy-sell calls (candidate #3 — ⚠️ DO-NOT-BUILD 2026-06-04: ~0.7 structured calls/wk, fatal vs invariant #5; HIGH PIT, outcome posts are retro-fit brags)
- **@wolfoftrading** (~170k) — verified 1 fully-structured call in 10d (`Longing ACEUSDT, Entry 0.12-0.11, T1/T2/T3, SL 0.095`); rest TA-teaser + WEEX funnel — ⭐⭐ — 2026-06-04
- **@cryptoinnercircle** — ~1 call/day mid-cap alt longs (SEI/INJ); mostly TP/SL *updates*; 399 USDT VIP upsell — ⭐ — 2026-06-04

### Pump-announcement / fade (candidate #4 — ⚠️ NO-GO for HL 2026-06-04: machine-detectable but the asset is a Raydium/Solana memecoin, never reaches a HL perp. Park.)
- **@crypto_pumps_p** (~328k) — clean `🔥INSIDER LAUNCH🔥` countdown (`4 DAYS`→`5 MIN`→reveal exactly 5.0 min later); regex `🔥\s*\$([A-Z]{2,10})\s*🔥`; reveal OVERWRITTEN ~35min post-drop (PIT proof) — ⭐⭐ — 2026-06-04

### ❌ AVOID
- @bigpumpsignal (~6.7k) — junk (returned a TON username-for-sale spam post), no live pumps. Drop.

---

## Discovery shortcuts (when expanding the list)
- **TGStat / Telemetr** — Telegram channel discovery + historical subscriber/reach.
- For signal-channel backtesting you need **8–15 call channels aggregated** for a 2000-trade sample (free tiers leak ~1 structured call/channel/week).
- Apify TG signal-actor candidates flagged in prior research (VERIFY via `search-actors`): khadinakbar / automation-lab / cryptosignals.

## Key research sources / repos (from the Exa + YouTube legs)
- **arXiv 2411.05577** — LLM buy-signals Granger-cause price ≥6h lag (top-3 coins, mixed).
- **blog.kalena.ai** — 9-channel TG test: 72%→49% win after 93s execution gap; front-run 15–45s pre-signal.
- **github.com/2582552544-gif/memerecall** — GPT intent tiers + on-chain KOL-call verification (~$0.15/KOL).
- **arXiv 2605.09431 (PumpSense)**, **2503.01686 (Perseus)** — Telegram / coordinated-pump detection methods.
- **onchaindivers.com/hyperliquid** — 425M-row HL warehouse w/ per-wallet ROI quantiles (feasibility ref for candidate #1).
- **Tools:** HyprPulse (free HL liq heatmaps + smart-money flow + wallet tracking, no login), Nansen (trades HL perps), Birdeye (top-holder tracing), MadeOnSol (KOL-convergence API).
- **Deep-pass #2/#6 backdrop (2026-06-04):** Tigro Blanc/Coinmonks (VPIN +31bps/24h but decaying to net-neg 2026); Coinmonks liq-cascade debunk (Sharpe 3.58→+0.98%/p=0.18 net of beta); delphicalpha.substack (orderflow IC half-life ~5s, imbalance=momentum); themicrostructurelab (sell-toxic persists / buy-toxic reverts, depth-gated OFI = NEW-A); arXiv:2510.27334 (meta-order not monetizable as taker, 0.42bps<4bps).

_Last updated: 2026-06-04 (deep-pass second run — sharpened #2, demoted #6 to beta, parked #3/#4, added NEW-B mid-cap rotation; +6 handles, −1 shill). Prior: 2026-06-04 candidate-selection run._
