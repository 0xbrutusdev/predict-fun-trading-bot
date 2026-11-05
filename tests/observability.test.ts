import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { observability } from "../src/observability.js";
test("readiness distinguishes live process from missing and stale trading inputs", async () => {
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
    assert.equal(
      (await observability(store, runtime, now)).readiness,
      "degraded",
    );
    await store.put("market", "m", {
      id: "m",
      symbol: "BTC",
      status: "OPEN",
      start: 0,
      end: 200000,
      duration: 300,
    });
    await store.put("books", "m", [
      { marketId: "m", receivedAt: now, updatedAt: now, asks: [], bids: [] },
    ]);
    assert.ok(
      (await observability(store, runtime, now)).reasons.includes(
        "insufficient_or_stale_candles",
      ),
    );
    for (const duration of [60, 300, 3600])
      await store.put(
        "candles",
        `BTC:${duration}`,
        Array.from({ length: 200 }, (_, i) => ({
          time: now - (200 - i) * duration * 1000,
        })),
      );
    assert.equal((await observability(store, runtime, now)).readiness, "ready");
    assert.equal(
      (await observability(store, runtime, now + 2000)).staleBooks,
      1,
    );
    await store.event("collector.error", { reason: "failure" }, now);
    assert.ok(
      (await observability(store, runtime, now)).reasons.includes(
        "recent_collector_error",
      ),
    );
    assert.ok(
      (await observability(store, runtime, now + 6000)).reasons.includes(
        "engine_heartbeat_missing",
      ),
    );
  } finally {
    await store.close();
  }
});
