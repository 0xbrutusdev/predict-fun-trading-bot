# Predict.fun CT4 research bot

TypeScript paper-trading worker, causal indicator/strategy library, Predict WebSocket/REST recorder, OKX candle collector, durable risk/settlement ledger, replay tool, and authenticated frontend API.

**Release status: paper/research, not live-ready.** This release implements the runnable foundation of the implementation plan. It does not establish profitability or complete the plan's live release gates. Live submission deliberately fails closed. Do not interpret paper account cash or PnL as wallet balances.

## Run

Requires Node >=22.13; the bundled `node:sqlite` is experimental on Node 22. The current deployment is one process per database on a local filesystem. PostgreSQL/multi-host operation from the original plan remains a subsequent migration; do not run multiple trading workers against this release.

```powershell
npm ci
Copy-Item .env.example .env
# Edit .env: set API_TOKEN to a cryptographically random value of at least 32 characters.
npm run build
node --env-file=.env dist/server.js
```

Default listen address is `127.0.0.1:3000`. The app does not automatically load `.env` without `--env-file`. Set `COLLECTOR_ENABLED=true` and configure `PREDICT_API_KEY` securely to capture mainnet public data. Startup does not submit orders, approve tokens, or transfer funds.

The collector fetches recent closed OKX candles and accumulates history. It does not automatically download the plan's complete 60-day warmup. Features require 200 primary bars; this release also conservatively requires 200 H1 bars for the H1 strategy. Use replay input to import archived history when necessary.

## First paper session

1. Create a paper account with `POST /v1/accounts`. It starts paused.
2. Inspect `GET /v1/strategies` and select slots with `PUT /v1/accounts/{id}/strategies`.
3. Inspect `GET /v1/markets/discovery`. Register verified market/window/token/rules metadata with `POST /v1/markets`. Discovery is deliberately not automatic trading approval; recurring windows each need registration by the integration service.
4. Wait for complete required candles and fresh books, then enable the account with `PATCH /v1/accounts/{id}`.
5. Inspect features, positions, fills, PnL, and event reasons. Record final official payout/evidence through the resolution endpoint after close.

The engine uses one position budget per market, conflict suppression, three fresh samples, and conservative paper fees. Source fixed-slot multiplication, permissive missing-sample behavior, and one-time chase re-anchoring are not used. These are explicit candidate-policy differences, not claims of exact source reproduction.

All 20 source slots are registered. Thirteen strategy functions are implemented; V9 consensus gate and both V19 strategies remain blocked because the supplied source does not define their required features. Source-engine golden fixtures are still needed to establish numerical parity. The source's unusual Williams %R and two-bar boolean behaviors are preserved.

## API integration

See [frontend API contract](docs/API.md). `GET /v1/openapi.json` publishes request schemas and route discovery. A committed snapshot is in `docs/openapi.json`. `src/client.ts` provides a small typed server-side/BFF client.

The API is single-owner, not a multi-tenant SaaS service. `API_TOKEN` grants control across all accounts; optional `API_READ_TOKEN` grants read-only access. Keep these tokens in a backend-for-frontend, not browser local storage or a public bundle. A BFF must supply end-user sessions, CSRF protection, and account authorization before exposing this to multiple users. Configure TLS at the reverse proxy and `ALLOWED_ORIGIN` explicitly.

Private keys and API credentials are never accepted through account endpoints. `walletAddress` is display metadata. The isolated SDK signing helper is a development probe, not a live execution path.

## Tests and replay

```powershell
npm run check
npm test
npm run build
npm run format:check
npm run replay -- events.jsonl
python research/evaluate.py replay-result.json
```

Replay JSONL uses `{time,type,data}` with receive timestamps in ascending order. Supported types: `setup.account`, `setup.market`, `candles` (`symbol,duration,rows`), `book`, `clock`, and `resolution` (resolved Market). Add clock events at checkpoints/retries; do not insert future snapshots to fill past gaps. `npm run replay` emits a result including fills in **integer micro-USDT**; the HTTP API converts them to USDT. For JSON redirection use `npx tsx src/replay.ts events.jsonl > replay-result.json` so npm's banner is excluded.

Paper fills consume a configured fraction of visible depth within the limit, share depth across intents for the same book version, and apply an explicit conservative flat-notional fee assumption (`paperFeeBps`, default 200). This is **not** the verified Predict fee schedule. Fee denomination, actual fills, latency, adverse selection and exact IOC/FAK semantics must be established before live economics are trustworthy.

`research/evaluate.py` is an initial day-block bootstrap report, not the full walk-forward/calibration study. The full holdout, cost-stress, calibration, capacity and canary gates in the implementation plan remain data-dependent work.

## Persistence and recovery

SQLite WAL records accounts, market metadata, run state, raw events, fills, and settlements. Restart recovers checkpoint state and ledger quantities; stale or late checkpoints skip. Monetary ledger entries use integer micro-USDT; SDK signing uses 18-decimal bigint amounts. Paper share quantities use floating point and must not be reused as a live exchange ledger.

Use the kill switch to stop new entries. It preserves existing positions and settlement tracking. Back up the database using a SQLite-aware backup or after stopping the process; copying only the main file during WAL writes is unsafe. No service is deployed by this repository. Add monitoring and retention appropriate to recorded book volume before prolonged capture.

## Live release blockers

- Undefined source features and original golden fixtures.
- Verified immediate order, partial fill, minimum, expiry and cancellation behavior.
- Exact cash/share fee accounting and wallet/order/chain reconciliation.
- Authenticated account adapter and durable live order submission/recovery.
- Authoritative automatic market-rule mapping and settlement ingestion.
- Full historical capture, out-of-sample calibration, timing/cost/capacity studies.
- Explicit capital/loss budget, deployment checks, and bounded live canary evidence.

See `PREDICT_FUN_IMPLEMENTATION_PLAN.md` for acceptance gates. This release keeps these distinctions visible instead of reporting simulated trades as live activity.
