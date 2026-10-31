# Frontend integration contract

Base path `/v1`. All endpoints require `Authorization: Bearer <server-side token>` except `/health`. GETs accept either owner or read-only credentials; mutations require owner credentials. One token controls the entire installation, not just one account. Route through your BFF. API keys/private keys are provisioned on the server, never via browser forms.

Successful resources return `{data: ...}`; cursor collections also return `{meta:{nextCursor:number}}`. Errors return `{error:{code:string,details?:unknown}}`. Timestamps are UTC epoch milliseconds. Prices are probabilities in `[0,1]`; balances, costs, fees and PnL are USDT. Slot confidence is a strategy score, not calibrated probability. Market IDs/token IDs are strings. All financial values refer to paper simulation in this version.

## Account and strategy screens

- `POST /accounts`: `{name,initialEquity,walletAddress?,fixedShares?,paperFeeBps?}`. Creates a paused paper account. `walletAddress` is optional display metadata and does not connect a wallet. Initial equity cannot be edited later to hide losses.
- `GET /accounts`, `GET /accounts/{id}`: account ID, name, mode, enabled state, initial equity, remaining cash, size, fee assumption, and risk limits.
- `PATCH /accounts/{id}`: subset of `{enabled,maxMarketRisk,maxTotalRisk,dailyLossLimit,fixedShares,depthFraction}`. Risk limits are fractions of initial strategy equity in this release. For example `0.0025` is 0.25%. Changes apply to subsequent fills; an existing intent retains its original target and direction.
- `GET /strategies`: the 20 slots with asset, duration in seconds, strategy name, default score threshold, and `blockedReason`.
- `GET|PUT /accounts/{id}/strategies`: `{enabledSlots:["1","2"]}`. PUT replaces selection. An empty selection disables new signal generation. It does not cancel an already-created intent; pause the account to stop it. Undefined-feature slots return 409. Threshold editing and arbitrary indicator-code execution are deliberately not exposed.
- `GET /accounts/{id}/features`: last 50 stored market feature snapshots and qualifying signals. These are computed by the backend from observed closed bars. The frontend does not submit trading features or probabilities into the execution engine.

## Portfolio and PnL screens

- `GET /accounts/{id}/positions`: unresolved holdings grouped by market and direction, quantity, entry cost and fees.
- `GET /accounts/{id}/fills?after=0&limit=50`: execution ledger. Save `meta.nextCursor` and request subsequent pages. `payout` and `pnl` are null until resolved; zero means a real zero value. Limit range 1–200.
- `GET /accounts/{id}/pnl`: `{realizedPnl,fees,cash,committed,conservativeEquity,initialEquity,unrealizedPnl,unrealizedReason,fills,currency}`. `conservativeEquity` values open positions at zero. Unrealized PnL is null because no trustworthy liquidation valuation is implemented. Do not label this null as zero or use paper cash as on-chain balance.
- Build the realized PnL chart from settled fill records using `settled_at`, including losing and tie settlements. Retain unresolved positions separately; never infer a winner from the latest quote.

## Market screens and operator controls

- `GET /markets`: approved records with `bookAgeMs`, time window, outcome IDs, source-rule hash, status, fees and tick. A null book age means no observed book. The client should calculate time left from `end` rather than parse display titles.
- `GET /markets/discovery`: raw unapproved venue listing. This is a metadata inspection feed, not an instruction to trade.
- `POST /markets`: `{id,symbol,duration,start,end,upToken,downToken,yesIsUp,status,feeBps,tick,rulesHash}`. Operator/integration-service action after verifying the specific market. Duration is 300 or 900. Window length and distinct tokens are checked. Existing market IDs cannot be overwritten.
- `GET /markets/{id}/book`: latest YES-oriented `{marketId,receivedAt,updatedAt,asks,bids}`. NO asks are the complement of YES bids. Preserve side mapping using `yesIsUp`.
- `POST /markets/{id}/resolution`: `{payout:[upPayout,downPayout],source:"https://..."}`. For example `[0.5,0.5]` for a verified tie. Requires market end, valid complementary payouts, and evidence URL. The service records operator-provided evidence; it does not automatically verify the URL. Conflicting final payouts return 409.
- `POST /kill-switch` with `{}` pauses all accounts. Positions are retained.
- `GET /status`: runtime mode, time, storage mode and live release blockers.
- `GET /events?after=0&limit=50`: ordered event stream for polling, cursor semantics as fills. Poll every 2–5 seconds, drain full pages, and back off on 429/5xx. Reconnect from the last cursor. This stream contains public-market data and installation-wide account activity; enforce tenant filtering in your BFF if needed.

## Minimal BFF flow

```typescript
const response = await fetch(`${process.env.BOT_URL}/v1/accounts`, {
  headers: { Authorization: `Bearer ${process.env.BOT_READ_TOKEN}` },
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw new Error(`Bot API failed: ${response.status}`);
const { data: accounts } = await response.json();
```

Do not retry POST account creation blindly after a transport timeout: list accounts and reconcile first. Settlement is idempotent for the same market payout. Configuration replacement uses PUT. API versioning is via `/v1`; clients should tolerate additional response fields.

## OpenAPI scope

`GET /v1/openapi.json` and `docs/openapi.json` provide route discovery and generated request-body validation schemas. Account, strategy, portfolio, book and event responses have explicit schemas; arbitrary feature dictionaries and raw discovery metadata remain extensible. Use the field contracts above for their interpretation. Browser authentication, tenant isolation, wallet deposits/withdrawals, live order controls and SSE are outside this version.
