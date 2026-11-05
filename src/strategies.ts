import type { Direction, Signal } from "./domain.js";
import { clamp, type Features, type micro } from "./features.js";
type Result = [Direction, number];
const out = (up: boolean, c: number): Result => [up ? "up" : "down", c];
type Context = { micro?: ReturnType<typeof micro>; h1?: Features };
export const slots = [
  ["BTC", 900, "regime_adaptive", 0.6],
  ["BTC", 900, "v14_signal_reclaim", 0.5],
  ["DOGE", 900, "v10_apex", 0.6],
  ["DOGE", 900, "v14_signal_reclaim", 0.5],
  ["DOGE", 900, "v9_consensus_gate", 0.45],
  ["ETH", 900, "v14_signal_reclaim", 0.5],
  ["ETH", 900, "v2_rsi_shift", 0.6],
  ["ETH", 900, "v8_anti_momentum_a", 0.55],
  ["SOL", 900, "macd_crossover", 0.6],
  ["SOL", 900, "v2_pin_bar", 0.6],
  ["SOL", 900, "v8_anti_momentum_a_m2", 0.55],
  ["BTC", 300, "v18_trend_pullback_5m", 0.548],
  ["BTC", 300, "v19_anchor_trend_counter_5m", 0.62],
  ["BTC", 300, "v5_vol_regime", 0.6],
  ["ETH", 300, "regime_adaptive", 0.6],
  ["ETH", 300, "v19_anchor_trend_5m", 0.62],
  ["ETH", 300, "v8_ultra_conf", 0.6],
  ["SOL", 300, "v2_pin_bar", 0.6],
  ["SOL", 300, "v3_precision", 0.6],
  ["SOL", 300, "v7_ultra_conf_a", 0.6],
].map(([symbol, duration, strategy, threshold], i) => ({
  id: String(i + 1),
  key: `${String(symbol).toLowerCase()}:${Number(duration)}:${String(strategy)}`,
  symbol: String(symbol),
  duration: Number(duration),
  strategy: String(strategy),
  threshold: Number(threshold),
}));
export const blocked: Record<string, string> = {
  v9_consensus_gate: "DayEfficiencySoFar undefined in source",
  v19_anchor_trend_counter_5m: "CloseChg3Pct undefined in source",
  v19_anchor_trend_5m: "CloseChg3Pct undefined in source",
};
function base(f: Features, kind: string): Result {
  if (kind === "am") {
    const z = Math.abs(f.ret) / f.ap;
    if (z < 0.3) return out(f.c > f.o, 0.05);
    const u = f.ret < 0;
    let c = Math.min(z / 2, 1);
    if (u ? f.rsi < 25 : f.rsi > 65) c = Math.min(c * 1.2, 0.99);
    if (u ? f.rsi > 65 : f.rsi < 25) c *= 0.5;
    return out(u, c);
  }
  if (kind === "bb") {
    const pos = f.bbpos;
    if (pos >= 0.15 && pos <= 0.85) return out(f.c < f.bbmid, 0.05);
    const u = pos < 0.15;
    let c = Math.min(u ? (0.15 - pos) / 0.15 : (pos - 0.85) / 0.15, 1);
    if (f.adx > 35) c *= 0.85;
    if (u ? f.rsi < 30 : f.rsi > 70) c = Math.min(c * 1.2, 0.99);
    if (u ? f.rsi > 70 : f.rsi < 30) c *= 0.5;
    return out(u, c);
  }
  const a = Math.abs(f.consec),
    u = f.consec < 0;
  let c = 0.01;
  if (a >= 4) {
    c = Math.min((a - 3) * 0.2 + 0.6, 0.95);
    if (u ? f.rsi < 35 : f.rsi > 65) c = Math.min(c + 0.1, 0.95);
    if (u ? f.bbpos < 0.2 : f.bbpos > 0.8) c = Math.min(c + 0.1, 0.95);
  } else if (a === 3) c = (u ? f.rsi < 40 : f.rsi > 60) ? 0.6 : 0.45;
  else return out(f.c >= f.o, c);
  if (u ? f.rsi < 35 : f.rsi > 58) c = Math.min(c * 1.2, 0.99);
  if (u ? f.rsi > 58 : f.rsi < 35) c *= 0.5;
  return out(u, c);
}
function legacy(f: Features, kind: string): Result {
  let [d, c] = base(f, kind);
  if (c <= 0.05) return [d, c];
  const u = d === "up",
    am = kind === "am",
    bb = kind === "bb";
  if (!am && f.adx > (bb ? 43 : 35)) c *= bb ? 0.95 : 0.9;
  const n = [
    u ? f.stoch > (am ? 70 : 75) : f.stoch < (am ? 30 : 25),
    u ? f.wr > (am ? -10 : -15) : f.wr < (am ? -90 : -85),
    u ? f.ob > (am ? 0.2 : 0.25) : f.ob < -(am ? 0.2 : 0.25),
  ].filter(Boolean).length;
  if (n >= 2) c *= am ? 0.3 : bb ? 0.25 : 0.15;
  else if (n) c *= am ? 0.7 : bb ? 0.75 : 0.65;
  if (f.wr > -60 && f.wr < -40) c *= am ? 0.75 : bb ? 0.8 : 0.7;
  if (Math.abs(f.ob) < 0.1) c *= kind === "cr" ? 0.85 : 0.92;
  if (bb && c > 0.1 && (u ? f.kcpos < 0.1 : f.kcpos > 0.9))
    c = Math.min(c * 1.12, 0.95);
  const supports = [
    u
      ? f.stoch < (kind === "cr" ? 40 : 30)
      : f.stoch > (kind === "cr" ? 60 : 70),
    u ? f.ob < -0.15 : f.ob > 0.15,
    ...(kind === "cr" ? [] : [u ? f.cmf < -0.03 : f.cmf > 0.03]),
    ...(am ? [u ? f.wr < -70 : f.wr > -30] : []),
  ].filter(Boolean).length;
  if (am && supports >= 3) c = Math.min(c * 1.2, 0.95);
  else if (supports >= 2) c = Math.min(c * (am ? 1.1 : 1.12), 0.95);
  if (f.vol > (am ? 1.5 : 1.8)) c = Math.min(c * 1.08, 0.95);
  else if (f.vol < (am ? 0.7 : 0.6)) c *= am ? 0.92 : 0.88;
  return [d, c];
}
function tunedAM(f: Features, symbol: string): Result {
  let [d, c] = base(f, "am");
  if (c <= 0.05) return [d, c];
  const u = d === "up",
    sol = symbol === "SOL";
  const lo = sol ? 20 : 30,
    hi = sol ? 70 : 70;
  const n = [
    u ? f.stoch > hi : f.stoch < lo,
    u ? f.wr > -10 : f.wr < -90,
    u ? f.ob > 0.2 : f.ob < -0.2,
  ].filter(Boolean).length;
  c *= n >= 2 ? 0.3 : n === 1 ? 0.7 : 1;
  if (f.wr > (sol ? -60 : -45) && f.wr < (sol ? -25 : -30))
    c *= sol ? 0.7 : 0.75;
  if (Math.abs(f.ob) < 0.1) c *= sol ? 0.92 : 0.88;
  const support = [
    u ? f.stoch < lo : f.stoch > hi,
    u ? f.wr < -70 : f.wr > -30,
    u ? f.ob < -0.15 : f.ob > 0.15,
    u ? f.cmf < -0.03 : f.cmf > 0.03,
  ].filter(Boolean).length;
  if (support >= 2) c = Math.min(c * (support >= 3 ? 1.2 : 1.1), 0.95);
  const confirms = [
    u ? f.stoch < 30 : f.stoch > 70,
    u ? f.wr < -70 : f.wr > -30,
    u ? f.cmf < -0.03 : f.cmf > 0.03,
    u ? f.vwapdev < -0.04 : f.vwapdev > 0.04,
    u ? f.ob < -0.15 : f.ob > 0.15,
  ].filter(Boolean).length;
  if (confirms <= 1) c *= 0.5;
  else if (confirms >= 3) c = Math.min(c * (confirms >= 4 ? 1.18 : 1.1), 0.95);
  if (f.vol > (sol ? 2.5 : 1.3)) c = Math.min(c * 1.08, 0.95);
  else if (f.vol < 0.7) c *= 0.92;
  return [d, c];
}
function full(f: Features, sol: boolean): Result {
  let up = 0,
    down = 0;
  const add = (u: boolean, v: number) => {
    if (u) up += v;
    else down += v;
  };
  const trend = (f.ema5 - f.ema20) / f.atr;
  if (Math.abs(trend) > (sol ? 0.3 : 0.2)) add(trend > 0, 1);
  if (f.rsi > (sol ? 75 : 65)) down += (f.rsi - 50) / 30;
  else if (f.rsi < 35) up += (50 - f.rsi) / 30;
  for (const [x, hi, lo, w] of [
    [f.bbpos, sol ? 0.92 : 0.82, sol ? 0.1 : 0.18, 0.7],
    [f.kcpos, sol ? 0.92 : 0.85, sol ? 0.08 : 0.15, 0.6],
    [f.hlpos, sol ? 0.92 : 0.85, sol ? 0.2 : 0.15, 0.5],
  ]) {
    if (x > hi) down += w;
    else if (x < lo) up += w;
  }
  if (Math.abs(f.consec) >= 3) add(f.consec < 0, 0.5);
  if (f.buy5 > 0.65) down += 0.4;
  else if (f.buy5 < 0.35) up += 0.4;
  if (Math.abs(f.dev / f.ap) > (sol ? 1 : 0.8)) add(f.dev < 0, 0.6);
  if (Math.abs(f.ret / f.ap) > (sol ? 1.2 : 0.8)) add(f.ret < 0, 0.5);
  if (f.squeeze > 0 && f.squeeze > f.prevSqueeze) up += 0.4;
  else if (f.squeeze < 0 && f.squeeze < f.prevSqueeze) down += 0.4;
  return up + down < 4
    ? out(f.c >= f.o, 0.01)
    : out(up > down, Math.min(Math.max(up, down) / 4, 0.9));
}
export function evaluate(
  name: string,
  f: Features,
  symbol: string,
  ctx: Context = {},
): Signal {
  if (blocked[name]) throw Error(blocked[name]);
  let r: Result;
  switch (name) {
    case "regime_adaptive":
      r =
        f.adx <= 0 ||
        f.bbmid <= 0 ||
        f.bbhi <= f.bblo ||
        ![f.adx, f.bbmid, f.bbhi, f.bblo].every(Number.isFinite)
          ? out(true, 0.1)
          : f.adx > 25
            ? f.bbwidth > 3
              ? out(f.ema20 > f.ema50, Math.min(f.adx / 50, 1))
              : out(f.ema20 > f.ema50, 0.3)
            : f.bbwidth <= 3
              ? out(f.rsi < 50, Math.min(Math.abs(f.rsi - 50) / 25, 1))
              : out(
                  f.c < f.bbmid,
                  Math.min(
                    (2 * Math.abs(f.c - f.bbmid)) / (f.bbhi - f.bblo),
                    1,
                  ),
                );
      break;
    case "macd_crossover":
      r = out(
        f.hist > 0,
        f.prevHist === 0 ? 0 : f.hist * f.prevHist < 0 ? 0.7 : 0.1,
      );
      break;
    case "v2_pin_bar":
      r =
        f.lower > 0.55 && f.body < 0.3 && f.upper < 0.15
          ? out(true, 0.5 + (f.bbpos < 0.3 ? 0.15 : 0) + (f.rsi < 40 ? 0.1 : 0))
          : f.upper > 0.55 && f.body < 0.3 && f.lower < 0.15
            ? out(
                false,
                0.5 + (f.bbpos > 0.7 ? 0.15 : 0) + (f.rsi > 60 ? 0.1 : 0),
              )
            : out(f.c >= f.o, 0.02);
      break;
    case "v2_rsi_shift": {
      if (f.rsi <= 0 || f.prevRsi <= 0) {
        r = out(true, 0.02);
        break;
      }
      const delta = f.rsi - f.prevRsi;
      r =
        Math.abs(delta) < 5
          ? out(f.rsi > 50, 0.02)
          : delta > 0 && f.prevRsi < 40
            ? out(true, Math.min(delta / 15 + 0.3, 0.9))
            : delta < 0 && f.prevRsi > 60
              ? out(false, Math.min(-delta / 15 + 0.3, 0.9))
              : out(delta > 0, Math.min(Math.abs(delta) / 20 + 0.15, 0.7));
      break;
    }
    case "v5_vol_regime": {
      let u = 0,
        d = 0;
      if (f.up50 > 0.56) d += (f.up50 - 0.5) * 4;
      else if (f.up50 < 0.44) u += (0.5 - f.up50) * 4;
      if (f.rsi > 65) d += (f.rsi - 50) / 30;
      else if (f.rsi < 35) u += (50 - f.rsi) / 30;
      if (f.bbpos > 0.82) d += 0.6;
      else if (f.bbpos < 0.18) u += 0.6;
      if (f.buy5 > 0.65) d += 0.4;
      else if (f.buy5 < 0.35) u += 0.4;
      let c = Math.min(Math.max(u, d) / 3, 0.9);
      if (f.regime > 1.15) c = Math.min(c * 1.2, 0.9);
      else if (f.regime < 0.85) c *= 0.7;
      r = u + d < 0.8 ? out(f.c >= f.o, 0.01) : out(u > d, c);
      break;
    }
    case "v3_precision": {
      const votes: [boolean, number][] = [];
      if (Math.abs(f.consec) >= 3) votes.push([f.consec < 0, 3]);
      if (Math.abs(f.ret) / f.ap > 1.3) votes.push([f.ret < 0, 2.5]);
      if (f.bbpos < 0.12 || f.bbpos > 0.88) votes.push([f.bbpos < 0.12, 2]);
      if (f.rsi > 72 || f.rsi < 28) votes.push([f.rsi < 28, 1.8]);
      if (f.body < 0.3 && (f.upper > 0.5 || f.lower > 0.5))
        votes.push([f.lower > 0.5, 1.5]);
      if (f.body > 0.55 && f.vol < f.prevVol * 0.6 && f.vol < 0.7)
        votes.push([f.c < f.o, 1.2]);
      const u = votes.filter((x) => x[0]).reduce((s, x) => s + x[1], 0),
        d = votes.filter((x) => !x[0]).reduce((s, x) => s + x[1], 0),
        dom = Math.max(u, d);
      r =
        votes.length < 2
          ? out(f.c >= f.o, 0.01)
          : Math.min(u, d) > dom * 0.4
            ? out(u > d, 0.05)
            : out(
                u > d,
                Math.min((dom / (u + d)) * Math.min(dom / 4, 1), 0.95),
              );
      break;
    }
    case "v8_anti_momentum_a":
    case "v8_anti_momentum_a_m2": {
      r = tunedAM(f, symbol);
      if (!ctx.micro) throw Error("micro_required");
      if (
        (name.endsWith("_m2") ? ctx.micro.last2Up : ctx.micro.lastUp) !==
        (r[0] === "up")
      )
        r[1] = 0.02;
      break;
    }
    case "v7_ultra_conf_a": {
      r = full(f, true);
      if (!ctx.micro) throw Error("micro_required");
      if (ctx.micro.ret >= 0 !== (r[0] === "up")) r[1] = 0.02;
      break;
    }
    case "v8_ultra_conf": {
      r = full(f, false);
      if (r[1] <= 0.05) break;
      const u = r[0] === "up";
      const n = [
        u ? f.stoch > 75 : f.stoch < 25,
        u ? f.wr > -15 : f.wr < -85,
        u ? f.ob > 0.25 : f.ob < -0.25,
      ].filter(Boolean).length;
      r[1] *= n >= 2 ? 0.2 : n === 1 ? 0.75 : 1;
      const s = [
        u ? f.stoch < 30 : f.stoch > 70,
        u ? f.ob < -0.15 : f.ob > 0.15,
        u ? f.cmf < -0.03 : f.cmf > 0.03,
      ].filter(Boolean).length;
      if (s >= 2) r[1] = Math.min(r[1] * 1.12, 0.95);
      if (f.vol > 1.5) r[1] = Math.min(r[1] * 1.08, 0.95);
      else if (f.vol < 0.3) r[1] *= 0.7;
      break;
    }
    case "v14_signal_reclaim": {
      const sub = ["am", "bb", "cr"].map((x) => legacy(f, x));
      const kept = sub.filter((x) => x[1] > 0.15);
      let con: Result = out(f.c > f.o, 0.03);
      if (kept.length >= 2) {
        const up = kept.filter((x) => x[0] === "up").length,
          agree = Math.max(up, kept.length - up);
        con = out(
          up > kept.length - up,
          agree < 2
            ? 0.05
            : Math.min(
                (kept.reduce((s, x) => s + x[1], 0) / kept.length) *
                  (0.7 + 0.15 * agree),
                0.95,
              ),
        );
      }
      const ranges = [
        [0.3, 0.65],
        [0.3, 0.7],
        [0.5, 0.7],
        [0.4, 0.55],
      ];
      const votes = [...sub, con].filter(
        (x, i) => x[1] >= ranges[i][0] && x[1] < ranges[i][1],
      );
      if (!votes.length) {
        r = out(f.c >= f.o, 0.01);
        break;
      }
      const up = votes.filter((x) => x[0] === "up").length,
        agree = Math.max(up, votes.length - up),
        u = up > votes.length - up;
      if (votes.length > 1 && agree <= Math.floor(votes.length / 2)) {
        r = out(u, 0.03);
        break;
      }
      let c = votes.reduce((s, x) => s + x[1], 0) / votes.length;
      if (agree >= 2)
        c = Math.min(c * (agree >= 3 ? 1.25 : 1.15), agree >= 3 ? 0.9 : 0.85);
      const n = [
        u ? f.stoch > 80 : f.stoch < 20,
        u ? f.wr > -5 : f.wr < -95,
      ].filter(Boolean).length;
      c *= n >= 2 ? 0.3 : n === 1 ? 0.7 : 1;
      if (
        [
          u ? f.cmf > 0.03 : f.cmf < -0.03,
          u ? f.buy > 0.55 : f.buy < 0.45,
          f.vol > 1.2,
        ].filter(Boolean).length >= 2
      )
        c = Math.min(c * 1.12, 0.9);
      r = out(u, c);
      break;
    }
    case "v18_trend_pullback_5m": {
      if (!ctx.h1 || !ctx.micro) throw Error("h1_and_micro_required");
      const h = ctx.h1,
        t = Math.sign(h.ema20 - h.ema50);
      if (h.rsi <= 0 || !t || f.ret * t >= 0) {
        r = out(t > 0, 0.02);
        break;
      }
      const score =
        -0.03 -
        0.07 * clamp((f.dev / f.ap) * t, -3, 3) -
        0.04 * clamp((f.consec / 5) * t, -3, 3) -
        0.28 * clamp((ctx.micro.head / f.ap) * t, -2, 2) +
        0.04 * (2 * ctx.micro.pos - 1) * t +
        (0.03 * f.adx) / 50 +
        0.03 * clamp(Math.abs((100 * (h.ema20 - h.ema50)) / h.ema50) / 2, 0, 2);
      const p = 1 / (1 + Math.exp(-score));
      r = out(t > 0, p < 0.5 ? 0.02 : p);
      break;
    }
    case "v10_apex": {
      let o = 0,
        s = 0;
      if (f.rsi > 65) o += Math.min((f.rsi - 60) / 25, 1) * 1.5;
      else if (f.rsi < 35) s += Math.min((35 - f.rsi) / 25, 1) * 1.5;
      for (const [x, w] of [
        [f.bbpos, 2],
        [f.kcpos, 1.2],
      ]) {
        if (x > 0.78) o += (x - 0.5) * w;
        else if (x < 0.22) s += (0.5 - x) * w;
      }
      if (f.consec >= 3) o += Math.min((f.consec - 2) * 0.3, 0.9);
      else if (f.consec <= -3) s += Math.min((-f.consec - 2) * 0.3, 0.9);
      const z = f.ret / f.ap;
      if (z > 0.9) o += Math.min((z - 0.5) * 0.5, 0.8);
      else if (z < -0.9) s += Math.min((-z - 0.5) * 0.5, 0.8);
      if (f.buy5 > 0.65) o += (f.buy5 - 0.5) * 1.5;
      else if (f.buy5 < 0.35) s += (0.5 - f.buy5) * 1.5;
      if (f.dev / f.ap > 0.5) o += Math.min((f.dev / f.ap) * 0.5, 0.8);
      else if (f.dev / f.ap < -0.5) s += Math.min((-f.dev / f.ap) * 0.5, 0.8);
      const dom = Math.max(o, s),
        u = s > o;
      if (
        dom < 2 ||
        Math.min(o, s) > dom * 0.3 ||
        f.adx > 33 ||
        (u ? f.rsi > 62 || f.bbpos > 0.72 : f.rsi < 38 || f.bbpos < 0.28)
      ) {
        r = out(f.c >= f.o, 0.01);
        break;
      }
      let c = Math.min(dom / 5 + 0.2, 0.95);
      if (
        [
          u ? f.stoch < 28 : f.stoch > 72,
          u ? f.wr < -72 : f.wr > -28,
          u ? f.cmf < -0.03 : f.cmf > 0.03,
          u ? f.ob < -0.18 : f.ob > 0.18,
        ].filter(Boolean).length >= 2
      )
        c = Math.min(c + 0.08, 0.95);
      if (f.vol > 1.3) c = Math.min(c * 1.06, 0.95);
      else if (f.vol < 0.35) c *= 0.7;
      r = out(u, c);
      break;
    }
    default:
      throw Error("unknown_strategy");
  }
  if (!Number.isFinite(r[1])) throw Error("invalid_signal");
  return { strategy: name, direction: r[0], confidence: r[1] };
}
