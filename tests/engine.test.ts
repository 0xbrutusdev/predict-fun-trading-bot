import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../src/engine.js";
import { Store } from "../src/store.js";
import { Collector } from "../src/collector.js";
test("worker resumes durable checkpoint and does not duplicate filled exposure", async () => {
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
    await collector.recordBook({
      marketId: "m",
      receivedAt: time,
      updatedAt: time,
      asks: [[0.5, 1000]],
      bids: [[0.49, 1000]],
    });
  await new Engine(s).step(210000);
  await new Engine(s).step(210250);
  assert.equal((await s.allFills()).length, 1);
  assert.equal((await s.get<any>("run", "a:m"))!.phase, "done");
  await s.close();
});
test("a delayed 5m signal skips expired diagnostics but remains eligible at 210s", async () => {
  const s = new Store(":memory:"),
    start = 75_000_000;
  s.put("account", "a", {
    id: "a",
    name: "a",
    mode: "paper",
    enabled: true,
    cash: 10000,
    initialEquity: 10000,
    maxTotalRisk: 0.01,
    maxMarketRisk: 0.0025,
    dailyLossLimit: 0.01,
    fixedShares: 15,
    depthFraction: 0.1,
    paperFeeBps: 200,
    createdAt: 0,
  });
  s.put("market", "m", {
    id: "m",
    symbol: "SOL",
    duration: 300,
    start,
    end: start + 300000,
    status: "OPEN",
    tick: 0.01,
    yesIsUp: true,
    upToken: "1",
    downToken: "2",
    feeBps: 200,
    rulesHash: "test",
  });
  s.put("config", "a", { enabledSlots: ["18"], revision: 1 });
  const rows = Array.from({ length: 250 }, (_, i) => {
    const open = 100 + Math.sin(i / 5) * 2 + i * 0.01,
      close = open + Math.sin(i) * 0.4;
    return {
      time: i * 300000,
      open,
      close,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      volume: 100 + (i % 9),
    };
  });
  rows[249] = {
    time: start - 300000,
    open: 98,
    close: 98.1,
    high: 98.2,
    low: 97,
    volume: 100,
  };
  s.put("candles", "SOL:300", rows);
  s.put(
    "candles",
    "SOL:60",
    Array.from({ length: 5 }, (_, i) => ({
      time: start - 300000 + i * 60000,
      open: 98,
      close: 98.1,
      high: 98.2,
      low: 97,
      volume: 100,
    })),
  );
  const engine = new Engine(s);
  await engine.step(start + 20000);
  assert.equal((await s.get<any>("run", "a:m"))!.phase, "late");
  const collector = new Collector(s, "");
  for (const offset of [208000, 209000, 210000])
    await collector.recordBook({
      marketId: "m",
      receivedAt: start + offset,
      updatedAt: start + offset,
      asks: [[0.5, 1000]],
      bids: [[0.49, 1000]],
    });
  await engine.step(start + 210000);
  assert.equal((await s.allFills()).length, 1);
  await s.close();
});
