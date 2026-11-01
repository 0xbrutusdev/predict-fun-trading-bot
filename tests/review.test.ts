import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { Collector } from "../src/collector.js";
import { createApp } from "../src/api.js";
import { settle, paperFill, type Account } from "../src/execution.js";
import type { Market, Book } from "../src/domain.js";
const m: Market = {
  id: "m",
  symbol: "BTC",
  duration: 300,
  start: 0,
  end: 300000,
  upToken: "1",
  downToken: "2",
  yesIsUp: true,
  status: "OPEN",
  feeBps: 200,
  tick: 0.01,
  rulesHash: "test",
};
const book: Book = {
  marketId: "m",
  receivedAt: 210000,
  updatedAt: 210000,
  asks: [[0.5, 1000]],
  bids: [[0.49, 1000]],
};
function setup() {
  const s = new Store(":memory:");
  const a: Account = {
    id: "a",
    name: "test",
    mode: "paper",
    enabled: true,
    initialEquity: 10000,
    cash: 10000,
    maxMarketRisk: 0.01,
    maxTotalRisk: 0.05,
    dailyLossLimit: 0.0001,
    fixedShares: 15,
    depthFraction: 0.1,
    paperFeeBps: 200,
    createdAt: 0,
  };
  s.put("account", "a", a);
  s.put("market", m.id, m);
  return s;
}
test("daily risk budget includes unclosed capital", () => {
  const s = setup();
  assert.equal(
    paperFill(s, "a", m, book, "up", 15, 0.51, "k", 210000).status,
    "no_fill",
  );
  assert.equal(s.get<Account>("account", "a")!.cash, 10000);
  s.close();
});
test("reject future books and NaN before changing ledger", () => {
  const s = setup();
  assert.throws(() =>
    paperFill(
      s,
      "a",
      m,
      { ...book, updatedAt: 210001 },
      "up",
      15,
      0.51,
      "k",
      210000,
    ),
  );
  assert.throws(() => paperFill(s, "a", m, book, "up", NaN, 0.51, "k", 210000));
  assert.throws(() =>
    settle(s, { ...m, status: "RESOLVED", payout: [NaN, NaN] }, 300000),
  );
  s.close();
});
test("settlement identity and conflict guards apply below HTTP layer", () => {
  const s = setup();
  assert.throws(() =>
    settle(
      s,
      { ...m, end: 250000, status: "RESOLVED", payout: [1, 0] },
      300000,
    ),
  );
  settle(s, { ...m, status: "RESOLVED", payout: [0.5, 0.5] }, 300000);
  assert.throws(() =>
    settle(s, { ...m, status: "RESOLVED", payout: [1, 0] }, 300000),
  );
  assert.deepEqual(s.get<Market>("market", "m")!.payout, [0.5, 0.5]);
  s.close();
});
test("shutdown drains in-flight collector jobs before DB close", async () => {
  const s = new Store(":memory:");
  const c = new Collector(s, "");
  let finished = false;
  (c as any).repeat(async () => {
    await new Promise((r) => setTimeout(r, 20));
    s.event("test", {});
    finished = true;
  }, 1000);
  await c.stop();
  assert.equal(finished, true);
  s.close();
});
test("read-only token cannot alias administrative credential", async () => {
  const s = new Store(":memory:");
  await assert.rejects(createApp(s, "a".repeat(32), undefined, "a".repeat(32)));
  await assert.rejects(createApp(s, "a".repeat(32), undefined, "weak"));
  s.close();
});
