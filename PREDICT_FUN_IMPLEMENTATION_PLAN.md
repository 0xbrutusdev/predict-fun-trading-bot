# Predict.fun CT4 bot: investigation and implementation plan

Prepared: October 31, 2026. Scope: research and implementation planning; no trading or deployment performed.

## 1. Recommendation

Build a Predict.fun research and execution system with two explicitly versioned strategy profiles:

1. **Reference CT4:** reproduce the supplied signals, thresholds, scheduling, and sizing for comparison, resolving the specification gaps below before claiming parity.
2. **Predict candidate:** use eligible Predict markets, their actual settlement rules and executable prices, calibrated expected payout, portfolio limits, and verified order semantics. Promote this profile only after out-of-sample and execution validation.

The investment hypothesis is that the document's closed-bar signals add information beyond Predict's price at the intended entry time. This is unproven. A high historical win rate, many agreeing indicators, or a profitable Polymarket replay does not establish that hypothesis.

Start recording BTC and ETH 5-minute and 15-minute markets immediately when API access is available. Research BTC first; retain ETH as a comparison, with ETH 5m a lower-priority candidate because its reported Polymarket margin was thin. Select the first live lane from Predict out-of-sample evidence, rather than assuming a particular asset or timeframe will win. Do not substitute BNB for SOL or DOGE.

**Workspace finding:** at the time of planning, the directory contained only b.md (original specification, removed from the current branch); it has no application, tests, dependency manifest, or Git repository. This is a greenfield implementation plan.

**Evidence boundary:** source-strategy facts below come from the supplied document; its performance claims were not independently reproduced. Platform facts come from current official pages and SDK documentation. No authenticated API requests, order submissions, liquidity measurements, or backtests were performed. Some developer pages were available through indexed official content while direct retrieval failed. Freeze and verify the actual API schemas and SDK version during Phase 0.

## 2. What the supplied bot actually does

### Signals and portfolio

The source describes 16 named strategies in 20 slots per account: 11 slots at 15m and 9 at 5m, over BTC, ETH, SOL, and DOGE. Two accounts run identical configurations. They are duplicated exposure, not independent diversification. See source overview (original specification, removed from the current branch) and slot map (original specification, removed from the current branch).

Inputs are OKX perpetual-swap candles, with closed primary bars and lagged 1H/15m context. Most rules combine mean reversion, momentum, candle shape, and regime filters. V18/V19 include frozen logistic scores. None of the supplied confidence outputs has demonstrated calibration to Predict settlement payouts or to the price at the eventual execution checkpoint.

Each qualifying slot contributes 15 target shares in reference mode. Same-direction signals merge; opposite directions remain separate in the source. Multiple strategies can share almost all their information, so slot count must not be treated as independent evidence or an automatic reason to multiply risk.

### Execution

The source is a taker system despite `prefer_maker=true`. Preserve the effective execution behavior, not that misleading flag. See CT4 configuration (original specification, removed from the current branch).

- **15m:** T1 at 75 seconds buys in `0.60, 0.76)`. An ask in `[0.05, 0.59)` routes to T3, while missing asks, asks below `0.05`, and `[0.59, 0.60)` route to T2. `[0.76, 0.95)` also defers to T2. An ask at or above `0.95` hard-skips. T2 at 120 seconds buys in `[0.72, 0.95)`; otherwise it routes to T3. T3 at 210 seconds buys in `[0.82, 0.92)` only with no prior fill. The configured 7-second T1 retry is inactive for 15m.
- **5m:** the 3-second and 7-second checkpoints do not buy under this configuration. They determine later eligibility, including a hard-skip path. The only entry is at 210 seconds, with eligible ask samples in `[0.45, 0.90)`. That leaves 90 seconds until the window ends.
- Checkpoints sample asks at `T-2`, `T-1`, and `T`. The source uses median selection for 15m and unanimous band membership for 5m.
- Orders allow partial fills and bounded retries: up to four attempts, with one-second spacing. A 15m T1 remainder may carry to T2; 5m has no T2 top-up. T3 is not an additional position after a prior fill.

The source's signal is fixed before the target window; its execution filter reacts to the market later. At 210 seconds, the prediction target is still the outcome of the entire 5m window, measured against its opening reference price. It is not simply the direction of the next 90-second return.

### What the performance evidence does and does not show

The document reports 4,617 fills, 4,389 resolved fills, 228 missing labels, net PnL of $1,223.45, and 4.47% return on reported cost plus fees. The missing-label rate is 4.94%. These are **reported Polymarket replay results**, using $5 target cost per slot rather than the live 15-share setting. They are neither Predict results nor an annualized bankroll return. See [replay results (original specification, removed from the current branch).

Four concerns materially affect the investment case:

1. The reported 15m optimum at 75 seconds loses approximately 20–32% of PnL with a five-second perturbation. This can reflect venue microstructure, data alignment, selection, or overfitting. It requires a timing-sensitivity audit before transfer.
2. The 5m 210-second leg's improvement is concentrated in a few weeks; the document itself does not treat it as proven alpha.
3. ETH 5m reports only 0.87% ROI. Small differences in fill quality, fees, or resolution can eliminate it. Aggregate win rate minus aggregate average entry is not a valid reconstruction of PnL when quantities and prices vary.
4. The source's V6 risk manager, breakout guards, and three-hour circuit breakers are disabled. Its nominal `max_daily_loss=50` is not enforced in the active per-signal path. This is not a production risk policy to inherit; the Predict implementation must enforce risk independently of strategy configuration.

Require raw fills, book tape, labels, and configuration hashes to reproduce these claims. Without them, reference-code parity can be tested on supplied fixtures, but historical performance remains unverified.

## 3. Specification defects and decisions required

These are engineering blockers to an *exact reproduction*, not reasons to stop building the collector or adapter.

1. **Ambiguous micro-bar timestamps.** Section 2.2 defines `W` as the new trading-window start, then puts the micro-bars at `W ... W+duration-1m`. Those would be future bars for the signal. Use distinct names: `windowStart=W`, `signalBarStart=B=W-duration`, and micro-bars `B ... W-1m`. Preserve the stricter source rule that HTF bars close by `B`, not merely by `W`. Obtain fixtures to confirm this interpretation. Source (original specification, removed from the current branch).
2. **Contradictory merge leader.** The text requires ascending lexicographic sorting, but the example selects `v14_signal_reclaim` ahead of `regime_adaptive`. Ascending sorting selects `regime_adaptive`. Implement that as a documented provisional interpretation; reconcile against source traces before claiming parity. The leader can affect confidence-aware gates. Source (original specification, removed from the current branch).
3. **Undefined active features.** `DayEfficiencySoFar` and `CloseChg3Pct` lack exact formulas, day boundary, and indexing conventions. They affect DOGE V9 and BTC/ETH V19 respectively. Do not invent definitions and call the result identical. Keep affected slots disabled until resolved or explicitly version a proposed definition as a new strategy. V9 (original specification, removed from the current branch), V19 (original specification, removed from the current branch).
4. **Surprising Williams %R contribution.** For the usual `[-100,0]` range, both branches of the composite overbought contribution are nonpositive. Preserve the formula in the reference profile; test a symmetric alternative only as a separate experiment. Source (original specification, removed from the current branch).
5. **Asymmetric two-minute confirmation.** `last2_up=false` includes mixed-direction pairs. Therefore the down branch of `v8_anti_momentum_a_m2` does not require two down candles. Do not silently rewrite it. Definition (original specification, removed from the current branch), filter (original specification, removed from the current branch).
6. **Signed path efficiency.** The micro feature is signed, but V19 clamps it to `[0,1]` without directional normalization. Negative paths become zero. Preserve that for reference testing. The 2.5-minute acceleration split and volume-centroid index origin are also underspecified, although they do not appear in the active decision formulas. Micro features (original specification, removed from the current branch), V19 clamp (original specification, removed from the current branch).
7. **Numerical edge cases.** Define zero-range/zero-volume behavior, zero ATR, flat RSI/StochRSI, all indicator seeds, rounding ties, zero head direction, and NaN propagation. EMA seeding and `AvgVol20=EMA20(volume)` must match. Do not substitute library defaults without fixtures.
8. **Incomplete execution transitions.** Clarify whether all three samples must be valid, exact late-grace handling, signal arrival after a checkpoint, unsuccessful T1/T2 order routing, retry eligibility after an invalid 7s sample, `full_cost_ratio`, and the maximum cumulative chase after re-anchoring. The prose does not settle every transition. Reference tests should enumerate each unresolved branch.
9. **No complete exit policy.** Hold-to-resolution is a reasonable baseline assumption from the replay methodology. Record it explicitly. Adding take-profit or stop-loss orders would create a different strategy requiring fresh execution and research validation.

Create a decision log with `source rule`, `ambiguity`, `chosen behavior`, `evidence`, and `strategy version`. Preserve the original document unchanged.

## 4. Predict.fun adaptation requirements

### Market universe and settlement

Official pages confirm BTC 5m/15m and ETH 5m markets; the market listing also contains ETH 15m and BNB short-duration markets. Current short-duration BTC/ETH examples use Chainlink data streams and resolve exact price ties 50–50. The cited BTC streams describe a Binance top-of-book midpoint source. This differs from blindly labeling OKX perpetual candles with `close >= open`. [BTC 5m rules](https://predict.fun/market/btc-updown-5m-1793484000), [BTC 15m rules](https://predict.fun/market/btc-updown-15m-1793484000), [ETH 5m rules](https://predict.fun/market/eth-updown-5m-1793463600), [market listing](https://predict.fun/markets/new).

Do not generalize those rules to every duration: the reviewed BTC 1h market uses Binance candle close/open and awards a tie to Up. Rules must be captured per market and version. [BTC 1h rules](https://predict.fun/market/bitcoin-up-or-down-october-30-2026-11pm-et).

Recommended registry behavior:

- Resolve the precise market ID, UTC start/end, condition ID, actual outcome token IDs, and outcome mapping for each window. A slug is a discovery hint, not sufficient validation.
- Store the question, rules text/hash, oracle/provider/feed, opening reference price, price precision, fees, trading status, and contract flags as observed at the time. Missing or contradictory metadata makes the window ineligible.
- Store payout vectors, including `[1,0]`, `[0,1]`, `[0.5,0.5]`, and other authoritative resolution values. Keep unresolved, disputed, fallback-source, and failed-redemption states distinct.
- Do not infer final payouts from last prices or a displayed 100% probability. Reconcile platform resolution with contract payout/redemption data.
- Retain SOL and DOGE in the reference strategy registry but disable Predict execution until exact matching markets and adequate liquidity are verified. Their availability was not established here. A BTC/ETH-only universe retains 11 of the original 20 slot definitions, before ambiguity and research exclusions.
- Treat BNB as a separate research extension; its volatility and symbol tuning have not been validated by the supplied document.

The API exposes outcome IDs, contract flags, fee rate, decimal precision, and crypto variant information. Example provider values in schemas are not evidence for a particular live market's oracle. [Market API](https://dev.predict.fun/get-market-by-id-25552989e0).

The initial BTC/ETH reference subset is explicit below. Numbers are source score thresholds, not estimated win probabilities; none of these slots is automatically authorized for live trading:

- BTC 15m: `regime_adaptive=0.600`, `v14_signal_reclaim=0.500`.
- ETH 15m: `v14_signal_reclaim=0.500`, `v2_rsi_shift=0.600`, `v8_anti_momentum_a=0.550`.
- BTC 5m: `v18_trend_pullback_5m=0.548`, `v19_anchor_trend_counter_5m=0.620`, `v5_vol_regime=0.600`.
- ETH 5m: `regime_adaptive=0.600`, `v19_anchor_trend_5m=0.620`, `v8_ultra_conf=0.600`.

Both V19 slots remain blocked on `CloseChg3Pct` semantics. V18 is defined more fully, but the source explicitly describes it as designed for K-line close-versus-open settlement; its frozen coefficients require target-label validation on Predict. This leaves nine BTC/ETH slot definitions without that specific undefined-feature blocker, still subject to the other specification and economic gates. Source slot map (original specification, removed from the current branch), V18 target warning (original specification, removed from the current branch).

### Connectivity and signing

The official API documents BNB mainnet at `https://api.predict.fun`, testnet at `https://api-testnet.predict.fun`, a default mainnet allowance of 240 requests/minute, and TypeScript/Python SDKs. Use a shared request budget, backoff, and a reserved reconciliation allowance. Rate limits must be read from the account/API contract rather than assumed permanently. [Developer documentation](https://dev.predict.fun/).

Use `GET /v1/auth/message`, wallet signing, and `POST /v1/auth` for wallet JWT authentication. Never hardcode the challenge. Refresh credentials before expiration and redact JWT-bearing WebSocket topics from logs. Separate EOA and Predict smart-wallet identity correctly. [Authentication guide](https://dev.predict.fun/doc-663127), [dynamic challenge](https://dev.predict.fun/get-auth-message-25326899e0).

Pin the official TypeScript SDK and use it for signing, market-specific exchange selection, approvals, and redemption. Respect `isNegRisk` and `isYieldBearing`; verify collateral units instead of copying a Polymarket USDC implementation. The SDK examples use 18-decimal amounts for shares and USDT. Use scoped approvals and a dedicated trading wallet. Verify BNB gas funding for direct BNB-chain transactions; do not copy incidental ETH wording from older examples. [Official SDK](https://github.com/PredictDotFun/sdk), [authentication and BNB guidance](https://dev.predict.fun/doc-663127).

### Order books and streaming

Predict publishes a YES-oriented book. Normalize it using:

```text
YES asks = raw asks                  YES bids = raw bids
NO asks  = complement(raw YES bids)  NO bids  = complement(raw YES asks)
complement(price) = 1 - price, using exact market precision
```

Buying NO crosses the complemented YES bids. Preserve quantities, validate sorting, and map YES/NO to actual Up/Down outcomes. Do not copy the orderbook guide's informal buy/sell wording without validating the side transformation. [Orderbook guide](https://dev.predict.fun/doc-685654), [REST book endpoint](https://dev.predict.fun/get-the-orderbook-for-a-market-25326908e0).

Use `wss://ws.predict.fun/ws` for books and status, with API-key authentication, heartbeat echo, reconnect backoff, and resubscription. Persist receive timestamps alongside exchange timestamps. A healthy socket does not prove a fresh book. Reconcile with REST after gaps; skip checkpoints that cannot be reconstructed causally. [WebSocket connection](https://dev.predict.fun/general-information-1915499m0), [request protocol](https://dev.predict.fun/request-format-1915501m0).

Subscribe to book, trading-status, lifecycle, and authenticated wallet events. Settlement-submitted, settlement-success, and settlement-failure are distinct states. Fee events may be in collateral or shares. Do not count pending settlement as spendable proceeds or add `settlementsPending` to executable depth. Confirm whether the main book already accounts for those quantities before any subtraction. [Subscription and wallet-event specification](https://dev.predict.fun/subscription-topics-1915507m0).

### Order semantics: a release blocker

The public create-order documentation supports MARKET and LIMIT, with API key plus wallet JWT. It does **not establish an exact FAK/IOC contract in the content retrieved here**. An `isFillOrKill` example exists on an OAuth endpoint explicitly marked unavailable for general use; it is not proof of FAK support on the public endpoint. [Public order endpoint](https://dev.predict.fun/create-an-order-32534694e0), [restricted OAuth endpoint](https://dev.predict.fun/create-an-order-for-a-oauth-connection-25326914e0).

Phase 0 must establish these capabilities with current schemas, SDK inspection, and testnet cases:

1. An enforceable maximum price/cost for a taker buy.
2. What happens to an unfilled MARKET remainder: canceled, rejected, or left active.
3. Whether partial fills are allowed, and when the remaining commitment is released.
4. FOK versus IOC/FAK availability and exact request fields.
5. Lookup by order hash, duplicate handling, cancellation locks, expiry, and failure recovery.
6. Actual minimum notional, quantity increments, fee rounding, and tick precision.

If a bounded immediate order with canceled remainder is supported, map reference FAK through that capability. If only FOK is viable, evaluate it as a separate execution variant because its fill distribution changes. A marketable LIMIT followed by cancellation is not atomic FAK: cancel latency can produce extra fills. Keep that fallback disabled until explicitly modeled and tested.

### Fees and accounting

Use each market's `feeRateBps`, documented fee calculation, rounding, actual event denomination, and confirmed wallet discount. Do not assume a uniform fee across markets. Predict's official fee explanation distinguishes taker fees from maker rebates and describes price-dependent effective fees; it does not provide enough detail by itself to implement the complete ledger formula. [Fee explanation](https://predict.fun/learn/how-prediction-market-fees-work).

Before live deployment, validate estimated fees against settled examples at several prices and both outcomes, including partial fills. Track gross shares, share fees, net shares, gross cash, cash fees, discounts, and redemption proceeds separately. A deduction in shares must reduce future payout inventory rather than also being subtracted as a cash fee.

Base alpha evaluation excludes speculative points, referral income, and assumed yield. Record realized rewards/yield separately. Only selected markets are yield-bearing, and yield accrues under a separate mechanism. [Yield explanation](https://predict.fun/learn/how-yield-works).

## 5. Quantitative decision framework

### Trade expected payout, not the source confidence score

For the purchased outcome, define at the actual execution time:

```text
v = P(outcome wins | information available now)
    + 0.5 * P(equal-price resolution | information available now)

expected_net_pnl = net_shares_received * v
                   - cash_spent - cash_fees - allocated_operational_cost

realized_net_pnl = net_shares_received * actual_payout_per_share
                   - cash_spent - cash_fees - allocated_operational_cost
```

Use the full payout distribution when a market's rules permit other resolutions. For partial fills, calculate these quantities per execution and sum them. Include price impact in executable VWAP; do not add the same spread or slippage twice.

A hypothetical 15-share buy with expected payout `v=0.78` and a **hypothetical** 0.10 USDT cash fee has expected PnL of +0.35 USDT at 0.75, but -1.15 USDT at 0.85. The fee and probabilities are illustrative, not measured Predict values. This is why a source confidence threshold such as 0.62 cannot authorize a buy at 0.85.

The Predict candidate should trade only if a conservative expected-payout estimate exceeds the fee-adjusted break-even level plus an uncertainty reserve. Estimate payout with calibration learned exclusively from prior data. Start with a low-complexity pooled model; avoid fitting a separate high-variance model to every small slot/checkpoint bucket.

Candidate features at entry include source signals, elapsed time, displacement of the current oracle price from the **window-opening reference**, recent volatility, executable book prices, spread/depth, and OKX-to-oracle basis. Source signals remain frozen in the reference profile. Adding these live features is an explicit change in the Predict candidate.

Use a time-to-expiry/strike-distance model and a book-only model as baselines. The source strategy must improve net expected value beyond them; merely forecasting what the book already prices is insufficient.

### Experiments, in order

1. **Exact source interpretation:** reproduce all defined feature and signal outputs on fixtures; resolve ambiguities before evaluating affected slots.
2. **Venue transfer:** replay unretuned CT4 against Predict books and official payouts. Report fixed 15-share and $5-cost sizing separately; neither is the other's performance estimate.
3. **Signal ablation:** compare CT4 alone, signal-plus-CT4, and matched control signals at equivalent asset/time/checkpoint/price distributions. This distinguishes directional information from buying already-favored outcomes.
4. **Timing robustness:** compare 15m T1 at 60/70/75/80/90 seconds and 5m late entry at 180/195/210/225 seconds. Pre-register this small grid and select on training data only. Look for a stable region rather than a single profitable second.
5. **Entry-price robustness:** perturb price bands by one and two venue ticks. Evaluate calibration and realized return within price bands, not only aggregate accuracy.
6. **Cost/capacity stress:** add 0.005/0.01/0.02 USDT per share of extra adverse execution, 100/250/500/1,000 ms submission delay scenarios, reduced available depth, and missed/partial fills. These are scenario assumptions until live measurements replace them.
7. **Portfolio ablation:** one signal per market versus merged slot sizing; conflict suppression versus both-sided entries; each slot's incremental contribution after other signals and shared costs.
8. **Feed transfer:** compare unchanged OKX features with separately versioned oracle-aligned features. Do not retrain and change the feed in the same unexplained experiment.

Maintain an experiment registry with all attempted variants. Avoid selecting the winner after inspecting the final holdout.

### Validation and promotion standard

- Use chronological walk-forward training/calibration/testing and a final untouched holdout. A practical starting schedule is 28 days train, 7 days calibration, and 7 days test, rolling forward, plus a final 14-day holdout. Extend the history if samples or regimes are insufficient.
- Purge overlapping outcomes around boundaries by at least the maximum 15-minute horizon plus any longer execution/label horizon. Fit normalization/calibration only on prior observations. Historical feature warmup may precede a split; future labels may not.
- Group duplicate slot records and all partial fills into their real market exposure. Bootstrap day blocks across all assets together, with week-block sensitivity, so correlated crypto moves do not become artificial independent samples.
- Use actual official payouts, including ties. Exclude unresolved cases from resolved statistics while reporting their count, committed capital, and worst-case economic bounds. Investigate systematic missingness.
- Report net PnL, return on turnover, capital utilization, return on deployed capital, daily equity/drawdown, loss concentration, fill ratio, markouts, fee error, calibration, and capacity. Report results by asset/timeframe/checkpoint and aggregate them with actual sizing.
- Initial promotion gate: positive out-of-sample net expectancy with a predeclared one-sided 95% block-bootstrap lower bound above zero, nonnegative net results under a 0.01 USDT/share extra-friction scenario, acceptable drawdown under the chosen risk budget, and no unresolved accounting/execution defects. Adjustments to these gates must be documented before rerunning the holdout.
- Aim for at least 500 distinct filled market windows over at least 30 calendar days as an initial evidence floor; neither threshold guarantees significance. Extend observation until confidence intervals and market-regime coverage are adequate. Do not count 20 slot allocations as 20 independent observations.

## 6. Production architecture

Use TypeScript with the official SDK for the live engine and deterministic replay. Use Python only for offline statistical analysis/calibration, exporting versioned model artifacts consumed by TypeScript. Reuse the same feature and state-machine implementation in live and replay to avoid two drifting engines.

Start as a modular application with one trading writer per wallet, PostgreSQL for durable execution state, and compressed raw events/Parquet for research. DuckDB/Python can analyze the archives. A message-bus cluster or frontend is unnecessary for the first release.

Proposed modules under `D:/Home/Utility_Projects/predict-fun-trading-bot/`:

```text
src/domain/             market, book, payout, intent, fill and money types
src/adapters/okx/       candle capture, backfill, completeness checks
src/adapters/predict/   discovery, auth, REST, WebSocket, signing, redemption
src/features/          causal indicators and source quantization
src/strategies/        the 16 reference strategies and slot registry
src/execution/         checkpoint policy, capability mapping, order state
src/risk/              exposure, reservations, limits, kill switches
src/ledger/            fills, fees, positions, payouts and reconciliation
src/replay/            event clock and execution simulation
src/worker/            collector, paper and live entry points
research/              calibration, walk-forward analysis, experiment manifests
config/                reference and Predict candidate profiles
tests/fixtures/        timestamp, feature, signal, order and payout fixtures
docs/                  schema decisions, source ambiguities, operations runbook
```

Essential persisted records:

- Versioned market/rules snapshots and actual outcome-token mapping.
- Raw events with provider time, receive time, ingest sequence, and connection epoch.
- Closed candles with first-availability time and revision history; backfilled data must not masquerade as data available live.
- Feature snapshots with input hashes, strategy version, and availability cutoff.
- Individual signals plus merged intent membership and deterministic fill allocation.
- Checkpoint decisions with samples, valid count, book age, requested price, veto reason, and policy version.
- Signed order hash/payload, attempt state, acknowledgements, cumulative fills, settlement IDs, fees, reservations, positions, and redemption transactions.

Use exact integer/decimal arithmetic for exchange amounts; represent money and share amounts in base units at the API boundary. Floating-point features are acceptable only with specified rounding and fixtures. Use UTC instants for market windows and a monotonic clock for elapsed timers.

### Execution safety and reconciliation

An intent is unique by wallet, market/window, outcome, and policy version; member slot identity is separately unique. Attempts are children of the same intent, not new independent bets. Persist and reserve funds atomically **before** submitting.

Track `planned -> reserved -> submitted/unknown -> accepted -> matched_pending -> settled/failed`, with cancellation and expiry states tracked per attempt. A partially executed order can have multiple settlement children; position and cash changes come from their deduplicated results.

On timeout, query by the persisted order hash and reconcile wallet events before retrying. Never mint a new order identity just because the HTTP response was lost. An unknown or pending fill consumes risk and capital until resolved. If the venue cannot reliably disambiguate submission, stop that intent and alert.

Serialize decisions for each market exposure and atomically enforce wallet-wide capital limits across simultaneous symbols/timeframes. Fence any replacement process so two workers cannot both trade the same wallet. On restart, reconcile orders, pending settlements, token balances, and collateral before enabling new orders.

For the Predict profile, require all three scheduled samples to be valid and sufficiently fresh; this stricter policy is a deliberate departure from the source's ambiguous valid-sample rule. Suggested initial local thresholds are a 1-second maximum observation age and 250 ms maximum clock offset, to be validated against feed cadence. Do not infer a missing sample from a later snapshot. Grace periods must never cross market close or authorize an expired signal.

Price construction must satisfy the venue tick, the policy's hard price limit, and the model's net-edge limit. Re-anchoring cannot reset the cumulative risk or slippage budget. Recalculate remaining quantity from settled **and pending** commitment, and do not round a residual upward past risk limits merely to meet a minimum order.

## 7. Sizing and risk policy

Reference mode retains `15 * merged_slot_count` gross target shares for comparison. The Predict candidate uses a single risk budget per economic exposure, independent of the number of correlated slots. Retain members for attribution and model features.

Suggested conservative canary defaults, pending the user's actual capital and loss budget:

- Maximum worst-case loss per market: 0.25% of start-of-day strategy equity.
- Aggregate committed worst-case loss across unresolved markets and unknown orders: 1% of strategy equity. Add tighter shared-direction crypto and overlapping 5m/15m caps if exposure clusters.
- Daily loss stop: 1% of start-of-day equity, accounting for realized results and conservative open-position value. This stops new risk; it cannot guarantee realized loss stays within 1% when exposure is already open.
- Weekly drawdown stop: 3%, with manual review before resumption.
- Initial depth participation: no more than 10% of conservatively available quantity inside the approved price cap, subject to measured fill quality and lower absolute canary limits.
- No martingale, averaging down, or confidence-to-Kelly conversion. Fractional Kelly is a later option only after robust payout calibration and dependence-aware constraints.

For an unhedged long binary position, reserve the full cash commitment plus cash fees and operational buffer as worst-case loss. Size by the minimum of the risk budget, available capital after reservations, approved depth, and configured absolute cap. Skip if the resulting size is below the venue minimum.

Fifteen shares at 0.75 cost 11.25 USDT before fees; a 0.25% cap requires at least 4,500 USDT equity for that position alone. Three merged slots require three times that budget in reference sizing. These are arithmetic illustrations, not a recommended deposit.

For a conflict on the same market, the initial Predict policy skips the conflicted exposure. Later research may select the side with stronger calibrated net value. Buying both sides is a separate complete-set/hedging decision and requires its own fee-adjusted economics; never spend twice simply because two signal names disagree.

Use one wallet initially. Any later additional wallets share aggregate exposure limits; duplicated configuration does not diversify losses.

Pause new entries on stale books, missing mandatory candles, ambiguous market mapping, metadata/rules changes, exhausted risk limits, ledger drift, unknown submissions, prolonged settlement, failed authentication, or unavailable database writes. Keep capture, reconciliation, and settlement tracking running while entry is paused.

## 8. Ordered implementation backlog and acceptance gates

Estimates below assume one experienced developer, working API access, and responsive answers to specification questions. Approximately 5–7 engineering weeks is a reasonable planning range; evidence collection and forward validation can extend calendar time substantially. Passing gates, not elapsed days, controls promotion.

### Phase 0 — Capability and specification contract (2–3 days)

Dependencies: none for local work; API key and testnet wallet for integration probes.

Deliverables: initialized project and version control, pinned SDK/API schema snapshot, reference config, ambiguity log, market eligibility schema, fee/order capability matrix, sanitized testnet observations, and a disabled-by-default live mode.

Acceptance: resolve exact market/outcome mapping; prove signing/auth and required contract routes; establish bounded order behavior, partial-fill/remainder semantics, minima and units. Every source ambiguity has either fixture-backed semantics or an explicitly disabled dependent path. No claim of full reference parity yet.

### Phase 1 — Market and candle recorder (3–5 days)

Dependencies: Phase 0 API contract. Start capture as early as access permits while source questions are being resolved.

Deliverables: Predict market/book/status recorder; OKX 1m/5m/15m/1H backfill and live closed candles; permitted oracle/reference-feed capture; immutable raw archive; data-quality report. Load the document's 60-day feature warmup independently of the longer research dataset.

Acceptance: exact UTC window and outcome mapping; reconstruct checkpoint samples using receive-time cutoffs; detect gaps/reconnects and clock drift; distinguish unobserved windows from no-trade decisions. Every traded/replayed candidate has its complete required inputs. Missing oracle-feed access may allow reference replay, but must disable any candidate that relies on unavailable intrawindow oracle features.

### Phase 2 — Reference features and strategy library (4–6 days)

Dependencies: time/data contracts and resolved feature definitions.

Deliverables: common indicators, symbol overrides, all 16 named strategies, all 20 reference slots, deterministic merge/allocation, and serialized feature/signal fixtures. Keep unresolved slots disabled rather than silently approximating them.

Acceptance: fixture parity for feature values, direction, confidence, threshold boundaries, and source-specific quirks; causal truncation produces identical historical outputs when future rows are appended. Source-trained and symbol-tuned strategy variants remain distinct. If original fixtures are unavailable, label validation as internal consistency rather than source-engine parity.

### Phase 3 — CT4 replay and ledger (4–6 days)

Dependencies: recorded books, Phase 2 signals, confirmed order capabilities.

Deliverables: event-clock CT4 state machine, both sizing modes, conservative depth consumption, latency scenarios, partial-fill handling, payout ledger, and per-window decision traces.

Acceptance: cover every defined T1/T2/T3 and 5m retry path; no 5m early buys; no T3 after a prior 15m fill; no missed terminal skip; no duplicate depth consumed by merged slots; no access to future books or labels. Separate optimistic and conservative fill assumptions and never describe simulated fills as actual execution.

### Phase 4 — Predict research and candidate selection (4–7 days of analysis, once data is sufficient)

Dependencies: Phases 1–3 and enough historical/forward data.

Deliverables: experiment registry, chronological splits, fee-aware calibration, ablation/stress results, proposed market/slot subset, risk-adjusted capacity estimate, and a frozen candidate config.

Acceptance: satisfy Section 5's predeclared statistical and cost gates. If no candidate qualifies, deliver a reproducible no-go result and continue capture or revise the hypothesis in a new experiment. Do not relax thresholds until one version appears profitable.

### Phase 5 — Paper operation and fault recovery (3–5 engineering days plus observation)

Dependencies: execution adapter and ledger; paper comparisons can begin before final Phase 4 selection.

Deliverables: the same production path in no-submit mode, testnet settlement exercises, operational metrics, alerting, restart/failover runbook, and kill-switch controls.

Acceptance: replay and paper agree on identical inputs; crash tests around reservation/submission/settlement do not produce duplicate intent; lost responses and delayed events leave conservative reservations; reconnect/auth refresh recover; successful, failed, partial, and 50–50 settlement cases reconcile exactly. Testnet demonstrates mechanics, not mainnet profitability or liquidity.

### Phase 6 — Small live canary (2–3 engineering days plus a bounded observation campaign)

Dependencies: Phases 0–5 passed; capital, wallet, absolute loss budget, and chosen market subset configured for live operation.

Deliverables: one-wallet, one-lane canary, execution-quality comparison against contemporaneous shadow decisions, measured latency/slippage/fee error, and verified settlement/redemption.

Acceptance: begin at venue-minimum-compatible size inside the risk cap; target at least 100 settled distinct market windows over multiple days for operational evidence, extending as needed. Zero unresolved ledger discrepancies or unexplained exposure is mandatory. Feed measured execution distributions back into the out-of-sample economics before scaling. Canary observations do not replace the larger statistical evidence gate.

### Phase 7 — Controlled scale-up

Dependencies: canary operational gate plus positive updated economics.

Increase size in small predeclared steps, recalculating capacity and adverse selection at each step. Add ETH, additional timeframes, or new assets one at a time. Promote new configurations only through shadow comparison and the same replay tests. Revert to the last validated config or paper mode if edge, execution quality, or risk behavior deteriorates.

## 9. Tests that protect money and research validity

1. **Time causality:** timestamp boundaries, delayed candle arrival, HTF cutoff, missing 1m bars, midnight/day features, and daylight-saving display changes. Scheduling remains UTC.
2. **Strategy parity:** indicator seeds, EMA volume average, all thresholds, zero/flat inputs, legacy HTF disabled behavior, V18/V19 feature order, rounding, and merge-leader conflict.
3. **Book normalization:** YES/NO side inversion, empty sides, arbitrary allowed precision, depth ordering, and market outcome-token mapping.
4. **Execution:** band endpoints, skipped early 5m entries, retries, chase cap, missed checkpoints, partial T1 carry, no-fill versus prior-fill T3 eligibility, and minimum residual quantity.
5. **Distributed failures:** HTTP timeout after successful submission, duplicate/out-of-order wallet events, JWT expiry, 429/5xx bursts, database failure, process crash, two-worker contention, and delayed/failed chain settlement.
6. **Accounting:** cash-fee and share-fee variants, reservations, gross versus net shares, partial fill allocation, win/loss/tie payouts, redemption idempotency, and chain/API reconciliation.
7. **Replay integrity:** future-data append invariance, availability-time cutoffs, strategy-version hashes, depletion of consumed liquidity, realistic delay, and clustered statistical sampling.

Use property tests for conservation, nonnegative remaining quantity, and position/risk limits. Use fixture/state-transition tests for policy semantics. A mocked successful HTTP response alone is insufficient evidence of a correct execution adapter.

## 10. Operations, rollback, and remaining inputs

Observe feed lag, checkpoint lag, feature availability, eligible/skipped windows, order acceptance, partial-fill rate, settlement latency, pending capital, realized fees, fee-estimation error, PnL, drawdown, and reconciliation discrepancies. Keep every veto explainable from stored inputs.

Rollback means disabling new entries, canceling any outstanding orders through the verified venue mechanism, reconciling in-flight settlements, and continuing position/redemption management. Cancellation does not erase fills. For the hold-to-resolution baseline, do not automatically liquidate into a thin book unless an explicit emergency-exit policy has been evaluated. Use backward-compatible schema migrations and preserve old configuration/model hashes so the prior executable can recover outstanding state.

Inputs needed before implementation can claim full parity or enable capital:

- Original feature/signal/order fixtures and definitions for the ambiguities in Section 3; raw source replay artifacts if historical reproduction is required.
- Predict API access and the selected EOA or Predict smart-wallet model, configured securely outside committed files.
- Actual target capital, absolute daily/campaign loss limits, and operating deployment constraints.
- Confirmed market availability, fees, immediate-order behavior, historical-book coverage, and oracle/reference-feed access.

The first implementation milestone is a **read-only recorder plus capability report and causal replay skeleton**. The first investment milestone is evidence of positive Predict-specific net expectancy after costs and dependence-aware uncertainty. These are separate deliverables; building the bot does not establish its edge.
