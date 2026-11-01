import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { observability } from "../src/observability.js";
test("readiness distinguishes live process from missing and stale trading inputs", () => {
  const store = new Store(":memory:"),
    now = 100000;
  const runtime = {
    startedAt: now - 10000,
    lastTickAt: now,
    lastTickMs: 2,
    engineErrors: 0,
    lastEngineErrorAt: null,
    collectorEnabled: true,
  };
  try {
    assert.equal(observability(store, runtime, now).readiness, "degraded");
    store.put("market", "m", {
      id: "m",
      symbol: "BTC",
      status: "OPEN",
      start: 0,
      end: 200000,
      duration: 300,
    });
    store.put("books", "m", [
      { marketId: "m", receivedAt: now, updatedAt: now, asks: [], bids: [] },
    ]);
    assert.ok(
      observability(store, runtime, now).reasons.includes(
        "insufficient_or_stale_candles",
      ),
    );
    for (const duration of [60, 300, 3600])
      store.put(
        "candles",
        `BTC:${duration}`,
        Array.from({ length: 200 }, (_, i) => ({
          time: now - (200 - i) * duration * 1000,
        })),
      );
    assert.equal(observability(store, runtime, now).readiness, "ready");
    assert.equal(observability(store, runtime, now + 2000).staleBooks, 1);
    store.event("collector.error", { reason: "failure" }, now);
    assert.ok(
      observability(store, runtime, now).reasons.includes(
        "recent_collector_error",
      ),
    );
    assert.ok(
      observability(store, runtime, now + 6000).reasons.includes(
        "engine_heartbeat_missing",
      ),
    );
  } finally {
    store.close();
  }
});
