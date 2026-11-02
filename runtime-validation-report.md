# Runtime Validation Report

**Generated**: 2026-11-02T03:50:35.7690504-05:00  
**Target**: `D:\Home\Utility_Projects\predict-fun-trading-bot`  
**Scope**: Local paper-trading Worker and Next.js control room. Production VPS hosting, live market collection, and real-money execution are excluded by operator decision.

## Summary

| Step | Status | Exit Code | Details |
|---|---:|---:|---|
| Environment | PASS | 0 | Node.js 22.23.4; Playwright 1.64.1; Chromium 1248 installed |
| Startup | PASS | n/a | Worker and dashboard readiness endpoints returned HTTP 200 |
| Type check | PASS | 0 | `npm run check` |
| Worker build | PASS | 0 | `npm run build` |
| Dashboard build | PASS | 0 | `npm run web:build`; five Next.js routes generated |
| Unit/integration | PASS | 0 | 22 passed, 0 failed, 0 skipped |
| Browser E2E | PASS | 0 | 4 passed, 0 failed, 0 skipped |

**Overall local verdict**: PASS

## Environment

- Docker: **UNAVAILABLE** — CLI exists, but `docker info` could not connect to `//./pipe/docker_engine` because the daemon is not running.
- Infrastructure tier: **NATIVE** — isolated in-memory SQLite is the application's actual persistence technology, so no database substitution was required.
- Node.js: **AVAILABLE** — v22.23.4.
- Playwright: **AVAILABLE** — Chromium and headless shell v1248 installed successfully.
- Browser tier: **PRIMARY (Playwright)**.

## Startup Evidence

- Compiled Worker started and reported `Server listening at http://127.0.0.1:3000`.
- Worker `GET /health` returned `status: ok`.
- Next.js production server started locally and `GET /api/health` returned HTTP 200.
- E2E validation used separate ports 3100/3101 and an in-memory Worker store; it did not open the operator database.

## Integration Evidence

Command: `npm test`  
Exit code: `0`  
Result: `22 passed, 0 failed, 0 skipped`

Covered behavior includes:

- Worker API authentication and read-only scope enforcement.
- Account validation, persistence, configuration, and P&L retrieval.
- Strategy blocking, deterministic signals, and feature calculations.
- Risk budgets, stale-book rejection, settlement conflicts, and ledger conservation.
- Gateway session, CSRF/origin checks, allowlisting, upstream error handling, and kill switch.
- Replay, checkpoint recovery, history backfill semantics, observability, and graceful shutdown.

## Browser E2E Evidence

Command: `npm run test:e2e`  
Exit code: `0`  
Result: `4 passed, 0 failed, 0 skipped`

| Test file | Journey |
|---|---|
| `e2e/auth-flow.spec.ts` | Invalid key rejection, valid login, Worker connection, logout, and post-logout API denial |
| `e2e/account-persistence.spec.ts` | Create a paper account, select it, reload the browser, and verify persisted paused state |
| `e2e/dashboard.spec.ts` | Existing operator journey: create/enable account, strategy restrictions and persistence, monitoring, mobile layout, kill switch, and logout |
| `e2e/localization-flow.spec.ts` | English/Chinese switching, persisted locale, translated navigation, operations view, and mobile overflow |

The existing Playwright journey was reused without production-selector changes. Three focused validation files were added for authentication, persistence, and localization.

## Test Infrastructure Fix

The managed Windows host rejects `os.userInfo()` inside `tsx` with `uv_os_get_passwd ... ENOMEM`. A Windows-only preload shim supplies a deterministic test identity. It does not run in production and does not modify application behavior.

## Known Boundaries

- Vercel remains intentionally disconnected from the local Worker. Connecting it requires the later VPS/operator decision plus `BOT_API_URL` and `BOT_API_TOKEN` production secrets.
- Market discovery, external Predict/OKX connectivity, and collector reconnection were not exercised because `COLLECTOR_ENABLED=false` and no operator-approved production API key was used.
- Real-money ordering is not implemented by this version and was not tested.
- Settlement correctness is covered through deterministic integration/replay tests rather than an external authoritative settlement feed.

## Verdict Block

```text
environment:
  docker: UNAVAILABLE — daemon pipe not found
  node: AVAILABLE — v22.23.4
  playwright: AVAILABLE — Chromium v1248
  infra-tier: NATIVE(SQLite in-memory) — actual application store, isolated per test process
  browser-tier: PRIMARY(Playwright)
startup: PASS — Worker and Next.js production servers, HTTP readiness confirmed
integration: PASS — exit_code: 0, passed: 22, failed: 0, skipped: 0
e2e: PASS — exit_code: 0, passed: 4, failed: 0, skipped: 0
overall: PASS — complete local paper-trading operator workflow within the stated boundaries
```
