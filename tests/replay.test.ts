import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replay } from "../src/replay.js";
import { Store } from "../src/store.js";
test("replay closed candles through signal, checkpoint, fill and supplied payout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "predict-replay-")),
    path = join(dir, "events.jsonl"),
    store = new Store(":memory:");
  try {
    const start = 250 * 300000;
    const rows = Array.from({ length: 250 }, (_, i) => {
      const o = 100 - i * 0.1;
      return {
        time: i * 300000,
        open: o,
        close: o - 0.05,
        high: o + 0.1,
        low: o - 0.15,
        volume: 100,
      };
    });
    rows[249] = {
      time: 249 * 300000,
      open: 75,
      close: 75.05,
      high: 75.1,
      low: 73,
      volume: 100,
    };
    const one = Array.from({ length: 5 }, (_, i) => ({
      time: start - 300000 + i * 60000,
      open: 75,
      close: 75.05,
      high: 75.1,
      low: 74.9,
      volume: 20,
    }));
    const account = {
      id: "a",
      name: "test",
      mode: "paper",
      enabled: true,
      initialEquity: 10000,
      cash: 10000,
      maxMarketRisk: 0.0025,
      maxTotalRisk: 0.01,
      dailyLossLimit: 0.01,
      fixedShares: 15,
      depthFraction: 0.1,
      paperFeeBps: 200,
      createdAt: start - 1000,
    };
    store.put("config", "a", { enabledSlots: ["18"] });
    const market = {
      id: "m",
      symbol: "SOL",
      duration: 300,
      start,
      end: start + 300000,
      upToken: "1",
      downToken: "2",
      yesIsUp: true,
      status: "OPEN",
      feeBps: 200,
      tick: 0.01,
      rulesHash: "fixture",
    };
    const events: any[] = [
      { time: start - 1000, type: "setup.account", data: account },
      { time: start - 1000, type: "setup.market", data: market },
      {
        time: start,
        type: "candles",
        data: { symbol: "SOL", duration: 300, rows },
      },
      {
        time: start,
        type: "candles",
        data: { symbol: "SOL", duration: 60, rows: one },
      },
    ];
    for (const sec of [1, 2, 3, 208, 209, 210])
      events.push({
        time: start + sec * 1000,
        type: "book",
        data: {
          marketId: "m",
          updatedAt: start + sec * 1000,
          asks: [[0.5, 1000]],
          bids: [[0.49, 1000]],
        },
      });
    events.push({
      time: start + 300000,
      type: "resolution",
      data: { ...market, status: "RESOLVED", payout: [1, 0] },
    });
    writeFileSync(path, events.map((x) => JSON.stringify(x)).join("\n"));
    const result = await replay(path, store);
    assert.equal(result.fills.length, 1);
    assert.equal((result.fills[0] as any).pnl, 7350000);
    assert.equal(store.get<any>("account", "a").cash, 10007.35);
  } finally {
    store.close();
    if (!dir.startsWith(join(tmpdir(), "predict-replay-")))
      throw Error("unsafe_test_cleanup");
    rmSync(dir, { recursive: true, force: true });
  }
});
