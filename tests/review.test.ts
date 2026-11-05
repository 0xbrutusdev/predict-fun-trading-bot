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
async function setup() {
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
  await s.put("account", "a", a);
  await s.put("market", m.id, m);
  return s;
}
test("daily risk budget includes unclosed capital", async () => {
  const s = await setup();
  assert.equal(
    (await paperFill(s, "a", m, book, "up", 15, 0.51, "k", 210000)).status,
    "no_fill",
  );
  assert.equal((await s.get<Account>("account", "a"))!.cash, 10000);
  await s.close();
});
test("reject future books and NaN before changing ledger", async () => {
  const s = await setup();
  await assert.rejects(() =>
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
  await assert.rejects(() =>
    paperFill(s, "a", m, book, "up", NaN, 0.51, "k", 210000),
  );
  await assert.rejects(() =>
    settle(s, { ...m, status: "RESOLVED", payout: [NaN, NaN] }, 300000),
  );
  await s.close();
});
test("settlement identity and conflict guards apply below HTTP layer", async () => {
  const s = await setup();
  await assert.rejects(() =>
    settle(
      s,
      { ...m, end: 250000, status: "RESOLVED", payout: [1, 0] },
      300000,
    ),
  );
  await settle(s, { ...m, status: "RESOLVED", payout: [0.5, 0.5] }, 300000);
  await assert.rejects(() =>
    settle(s, { ...m, status: "RESOLVED", payout: [1, 0] }, 300000),
  );
  assert.deepEqual((await s.get<Market>("market", "m"))!.payout, [0.5, 0.5]);
  await s.close();
});
test("shutdown drains in-flight collector jobs before DB close", async () => {
  const s = new Store(":memory:");
  const c = new Collector(s, "");
  let finished = false;
  (c as any).repeat(async () => {
    await new Promise((r) => setTimeout(r, 20));
    await s.event("test", {});
    finished = true;
  }, 1000);
  await c.stop();
  assert.equal(finished, true);
  await s.close();
});
test("read-only token cannot alias administrative credential", async () => {
  const s = new Store(":memory:");
  await assert.rejects(createApp(s, "a".repeat(32), undefined, "a".repeat(32)));
  await assert.rejects(createApp(s, "a".repeat(32), undefined, "weak"));
  await s.close();
});
test("repository transactions roll back failed multi-document changes", async () => {
  const store = new Store(":memory:");
  await store.put("account", "a", { cash: 100 });
  await assert.rejects(
    store.transaction(async () => {
      await store.put("account", "a", { cash: 0 });
      await store.event("should.rollback", {});
      throw Error("rollback");
    }),
  );
  assert.deepEqual(await store.get("account", "a"), { cash: 100 });
  assert.equal((await store.eventsPage(0, 10)).length, 0);
  await store.close();
});
test("only one process can hold the execution lease for a tenant database", async () => {
  const store = new Store(":memory:");
  try {
    assert.equal(
      await store.acquireLease("paper-execution", "worker-a", 1000, 5000),
      true,
    );
    assert.equal(
      await store.acquireLease("paper-execution", "worker-b", 1001, 5000),
      false,
    );
    assert.equal(
      await store.acquireLease("paper-execution", "worker-b", 6000, 5000),
      true,
    );
    await store.releaseLease("paper-execution", "worker-a");
    assert.equal(
      await store.acquireLease("paper-execution", "worker-c", 6001, 5000),
      false,
    );
  } finally {
    await store.close();
  }
});
