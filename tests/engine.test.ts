import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/engine.js";
import { Store } from "../src/store.js";
import { Collector } from "../src/collector.js";
test("worker resumes durable checkpoint and does not duplicate filled exposure", () => {
  const s = new Store(":memory:");
  s.put("account", "a", {
    id: "a",
    enabled: true,
    cash: 10000,
    initialEquity: 10000,
    maxTotalRisk: 0.01,
    maxMarketRisk: 0.0025,
    dailyLossLimit: 0.01,
    fixedShares: 15,
    depthFraction: 0.1,
    paperFeeBps: 200,
  });
  s.put("market", "m", {
    id: "m",
    symbol: "BTC",
    duration: 300,
    start: 0,
    end: 300000,
    status: "OPEN",
    tick: 0.01,
    yesIsUp: true,
  });
  s.put("run", "a:m", {
    phase: "late",
    direction: "up",
    members: ["v5_vol_regime"],
    filled: 0,
    attempt: 0,
    target: 15,
  });
  const collector = new Collector(s, "");
  for (const time of [208000, 209000, 210000])
    collector.recordBook({
      marketId: "m",
      receivedAt: time,
      updatedAt: time,
      asks: [[0.5, 1000]],
      bids: [[0.49, 1000]],
    });
  new Engine(s).step(210000);
  new Engine(s).step(210250);
  assert.equal(
    (s.db.prepare("SELECT COUNT(*) n FROM fills").get() as any).n,
    1,
  );
  assert.equal(s.get<any>("run", "a:m").phase, "done");
  s.close();
});
