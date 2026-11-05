import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { backfill, historyAt, parseCandles } from "../src/history.js";
const candle = (t: number) => [
  String(t),
  "100",
  "102",
  "99",
  "101",
  "10",
  "0",
  "0",
  "1",
];
test("paged backfill resumes and preserves observation time", async () => {
  const s = new Store(":memory:");
  const cursors: number[] = [];
  const deps = {
    now: () => 600000,
    wait: async () => {},
    request: async (url: string) => {
      const after = Number(new URL(url).searchParams.get("after"));
      cursors.push(after);
      return {
        code: "0",
        data:
          after === 240000
            ? [candle(180000), candle(120000)]
            : [candle(60000), candle(0)],
      };
    },
  };
  const opts = { symbol: "BTC", duration: 60 as const, start: 0, end: 240000 };
  assert.equal(
    (await backfill(s, { ...opts, maxPages: 1 }, deps)).complete,
    false,
  );
  const report = await backfill(s, opts, deps);
  assert.equal(report.complete, true);
  assert.deepEqual(cursors, [240000, 120000]);
  assert.equal((await historyAt(s, "BTC", 60, 0, 240000, 599999)).length, 0);
  assert.equal((await historyAt(s, "BTC", 60, 0, 240000, 600000)).length, 4);
  await s.close();
});
test("closed flags and invalid OHLC fail safely", () => {
  assert.deepEqual(
    parseCandles([[...candle(0).slice(0, 8), "0"]], 60, 60000),
    [],
  );
  assert.throws(() => parseCandles([candle(0)], 60, 59999));
  assert.throws(() =>
    parseCandles(
      [["0", "100", "90", "99", "101", "10", "0", "0", "1"]],
      60,
      60000,
    ),
  );
});
test("empty exchange history reports gap without claiming completion", async () => {
  const s = new Store(":memory:");
  const result = await backfill(
    s,
    { symbol: "BTC", duration: 60, start: 0, end: 120000 },
    {
      now: () => 200000,
      wait: async () => {},
      request: async () => ({ code: "0", data: [] }),
    },
  );
  assert.equal(result.missing, 2);
  assert.equal(result.complete, false);
  await s.close();
});
