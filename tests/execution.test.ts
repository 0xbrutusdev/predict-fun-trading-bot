import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { decide, paperFill, settle, type Account } from "../src/execution.js";
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
    name: "a",
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
    createdAt: 0,
  };
  s.put("account", "a", a);
  return s;
}
test("5m only buys late and requires three samples", () => {
  assert.equal(decide(300, "t1", [0.7, 0.7, 0.7], false).buy, false);
  assert.equal(decide(300, "late", [0.7, 0.7, 0.9], false).buy, false);
  assert.equal(decide(300, "late", [0.7], false).buy, false);
  assert.equal(decide(300, "late", [0.7, 0.7, 0.7], false).buy, true);
});
test("15m boundaries and prior-fill T3 prohibition", () => {
  assert.equal(decide(900, "t1", [0.76, 0.76, 0.76], false).buy, false);
  assert.equal(decide(900, "t1", [0.6, 0.6, 0.6], false).buy, true);
  assert.equal(decide(900, "t3", [0.85, 0.85, 0.85], true).buy, false);
});
test("deduplication, conflict prevention, tie settlement conservation", () => {
  const s = setup();
  const r = paperFill(s, "a", m, book, "up", 15, 0.51, "key", 210000);
  assert.equal(r.quantity, 15);
  assert.equal(
    paperFill(s, "a", m, book, "up", 15, 0.51, "key", 210000).status,
    "duplicate",
  );
  assert.throws(() =>
    paperFill(s, "a", m, book, "down", 15, 0.52, "other", 210000),
  );
  settle(s, { ...m, status: "RESOLVED", payout: [0.5, 0.5] }, 300000);
  settle(s, { ...m, status: "RESOLVED", payout: [0.5, 0.5] }, 300000);
  assert.equal(s.get<Account>("account", "a")!.cash, 9999.85);
  s.close();
});
test("stale book cannot trade", () => {
  const s = setup();
  assert.throws(() => paperFill(s, "a", m, book, "up", 15, 0.51, "k", 212000));
  s.close();
});
