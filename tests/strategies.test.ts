import { test } from "node:test";
import assert from "node:assert/strict";
import { features, closedBars, micro, ema } from "../src/features.js";
import { evaluate, slots, blocked } from "../src/strategies.js";
export const bars = Array.from({ length: 250 }, (_, i) => {
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
test("EMA is seeded by SMA", () =>
  assert.deepEqual(ema([1, 2, 3, 4], 3).slice(2), [2, 3]));
test("causal cutoff excludes future data and refuses missing tail", () => {
  const cutoff = 240 * 300000;
  assert.deepEqual(
    features(closedBars(bars, 300, cutoff)),
    features(closedBars(bars.slice(0, 240), 300, cutoff)),
  );
  assert.throws(() => closedBars(bars.slice(0, 238), 300, cutoff));
});
test("all defined reference strategies produce bounded deterministic outputs", () => {
  const f = features(bars);
  for (const s of slots) {
    if (blocked[s.strategy]) {
      assert.throws(() => evaluate(s.strategy, f, s.symbol));
      continue;
    }
    const result = evaluate(s.strategy, f, s.symbol, {
      h1: f,
      micro: { head: 0.01, pos: 0.6, ret: 0.1, lastUp: true, last2Up: true },
    });
    assert.ok(result.confidence >= 0 && result.confidence <= 1, s.strategy);
  }
});
test("micro requires exact sequence", () =>
  assert.throws(() => micro([], 0, 300)));
test("pin bar and crossing thresholds", () => {
  const f = features(bars);
  assert.equal(
    evaluate(
      "v2_pin_bar",
      { ...f, lower: 0.6, upper: 0.1, body: 0.2, bbpos: 0.2, rsi: 35 },
      "BTC",
    ).confidence,
    0.75,
  );
  assert.equal(
    evaluate("macd_crossover", { ...f, hist: 0.1, prevHist: -0.1 }, "SOL")
      .confidence,
    0.7,
  );
});
test("source guards suppress invalid edge-state confidence", () => {
  const f = features(bars);
  assert.deepEqual(
    evaluate("v2_rsi_shift", { ...f, rsi: 7.142857, prevRsi: 0 }, "ETH"),
    { strategy: "v2_rsi_shift", direction: "up", confidence: 0.02 },
  );
  assert.equal(
    evaluate("macd_crossover", { ...f, hist: 0.1, prevHist: 0 }, "SOL")
      .confidence,
    0,
  );
  assert.deepEqual(evaluate("regime_adaptive", { ...f, adx: 0 }, "BTC"), {
    strategy: "regime_adaptive",
    direction: "up",
    confidence: 0.1,
  });
  assert.equal(
    evaluate("v18_trend_pullback_5m", { ...f, ret: -1 }, "BTC", {
      h1: { ...f, ema20: 2, ema50: 1, rsi: 0 },
      micro: { head: 0, pos: 0.5, ret: 0, lastUp: false, last2Up: false },
    }).confidence,
    0.02,
  );
});
