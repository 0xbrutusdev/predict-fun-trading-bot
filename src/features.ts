import type { Candle } from "./domain.js";
export const clamp = (x: number, a: number, b: number) =>
  Math.max(a, Math.min(b, x));
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
const last = (a: number[]) => a.at(-1)!;
export function ema(a: number[], n: number, alpha = 2 / (n + 1)): number[] {
  const out = a.map(() => NaN);
  let start = a.findIndex(Number.isFinite);
  if (start < 0 || a.length < start + n) return out;
  out[start + n - 1] = mean(a.slice(start, start + n));
  for (let i = start + n; i < a.length; i++)
    out[i] = alpha * a[i] + (1 - alpha) * out[i - 1];
  return out;
}
export function features(b: Candle[]) {
  if (b.length < 200) throw Error("insufficient_primary_history");
  if (
    b.some(
      (x) =>
        ![x.open, x.high, x.low, x.close, x.volume].every(Number.isFinite) ||
        x.open <= 0 ||
        x.low <= 0 ||
        x.high < x.low ||
        x.volume < 0 ||
        x.close < x.low ||
        x.close > x.high ||
        x.open < x.low ||
        x.open > x.high,
    )
  )
    throw Error("invalid_candle");
  const c = b.map((x) => x.close),
    v = b.map((x) => x.volume),
    e5 = ema(c, 5),
    e20 = ema(c, 20),
    e50 = ema(c, 50);
  const gains = c.map((x, i) => (i ? Math.max(0, x - c[i - 1]) : NaN)),
    losses = c.map((x, i) => (i ? Math.max(0, c[i - 1] - x) : NaN));
  const g = ema(gains, 14, 1 / 14),
    l = ema(losses, 14, 1 / 14),
    rsi = g.map((x, i) => (x + l[i] === 0 ? 50 : (100 * x) / (x + l[i])));
  const tr = b.map((x, i) =>
    i
      ? Math.max(
          x.high - x.low,
          Math.abs(x.high - c[i - 1]),
          Math.abs(x.low - c[i - 1]),
        )
      : x.high - x.low,
  );
  const atr = ema(tr, 14, 1 / 14),
    pm = b.map((x, i) =>
      i && x.high - b[i - 1].high > b[i - 1].low - x.low
        ? Math.max(0, x.high - b[i - 1].high)
        : 0,
    ),
    nm = b.map((x, i) =>
      i && b[i - 1].low - x.low > x.high - b[i - 1].high
        ? Math.max(0, b[i - 1].low - x.low)
        : 0,
    );
  const p = ema(pm, 14, 1 / 14),
    m = ema(nm, 14, 1 / 14),
    adx = ema(
      p.map((x, i) =>
        x + m[i] === 0 ? 0 : (100 * Math.abs(x - m[i])) / (x + m[i]),
      ),
      14,
      1 / 14,
    );
  const slow = ema(c, 26),
    macd = ema(c, 12).map((x, i) => x - slow[i]),
    macdSignal = ema(macd, 9);
  const hist = macd.map((x, i) => x - macdSignal[i]);
  const rawK = rsi.map((x, i) => {
    const a = rsi.slice(i - 13, i + 1);
    const lo = Math.min(...a),
      hi = Math.max(...a);
    return i < 27 ? NaN : hi === lo ? 50 : (100 * (x - lo)) / (hi - lo);
  });
  const k = rawK.map((_, i) => (i < 2 ? NaN : mean(rawK.slice(i - 2, i + 1))));
  const x = b.at(-1)!,
    tail = b.slice(-20),
    range = x.high - x.low;
  if (range <= 0 || last(atr) <= 0 || last(ema(v, 20)) <= 0)
    throw Error("degenerate_features");
  const bbmid = mean(c.slice(-20)),
    std = Math.sqrt(mean(c.slice(-20).map((z) => (z - bbmid) ** 2)));
  if (std === 0) throw Error("flat_bands");
  const bblo = bbmid - 2 * std,
    bbhi = bbmid + 2 * std,
    ap = (100 * last(atr)) / x.close;
  const hh = Math.max(...tail.map((z) => z.high)),
    ll = Math.min(...tail.map((z) => z.low));
  let consec = 0;
  const sign = x.close >= x.open ? 1 : -1;
  for (let i = b.length - 1; i >= 0; i--) {
    if ((b[i].close >= b[i].open ? 1 : -1) !== sign) break;
    consec += sign;
  }
  const volsum = tail.reduce((s, z) => s + z.volume, 0);
  if (!volsum) throw Error("zero_volume");
  const wr =
    (-100 * (Math.max(...b.slice(-14).map((z) => z.high)) - x.close)) /
    (Math.max(...b.slice(-14).map((z) => z.high)) -
      Math.min(...b.slice(-14).map((z) => z.low)));
  const bbpos = (x.close - bblo) / (bbhi - bblo),
    rs = last(rsi),
    st = last(k);
  const ob = clamp(
    (rs - 50) / 50 +
      (bbpos - 0.5) +
      ((st - 50) / 50) * 0.4 +
      (wr > -50 ? (-wr - 50) / 50 : (wr + 50) / 50) * 0.3,
    -1,
    1,
  );
  const deltas = b.map((z, i) => {
    if (i < 19) return NaN;
    const a = b.slice(i - 19, i + 1);
    return (
      z.close -
      ((Math.max(...a.map((t) => t.high)) + Math.min(...a.map((t) => t.low))) /
        2 +
        mean(a.map((t) => t.close))) /
        2
    );
  });
  const lin = (a: number[]) => {
    const avg = mean(a);
    const slope = a.reduce((s, z, i) => s + (i - 9.5) * (z - avg), 0) / 665;
    return avg + slope * 9.5;
  };
  return {
    o: x.open,
    c: x.close,
    h: x.high,
    l: x.low,
    ret: 100 * (x.close / x.open - 1),
    atr: last(atr),
    ap,
    rsi: rs,
    prevRsi: rsi.at(-2)!,
    adx: last(adx),
    ema5: last(e5),
    ema20: last(e20),
    ema50: last(e50),
    bbpos,
    bbmid,
    bblo,
    bbhi,
    bbwidth: (100 * (bbhi - bblo)) / bbmid,
    kcpos: (x.close - last(e20) + 1.5 * last(atr)) / (3 * last(atr)),
    stoch: st,
    wr,
    ob,
    cmf:
      tail.reduce(
        (s, z) =>
          s +
          (z.high === z.low
            ? 0
            : (2 * z.close - z.high - z.low) / (z.high - z.low)) *
            z.volume,
        0,
      ) / volsum,
    vwapdev:
      100 *
      (x.close /
        (tail.reduce(
          (s, z) => s + ((z.high + z.low + z.close) / 3) * z.volume,
          0,
        ) /
          volsum) -
        1),
    vol: x.volume / last(ema(v, 20)),
    prevVol: b.at(-2)!.volume / ema(v, 20).at(-2)!,
    dev: 100 * (x.close / last(e20) - 1),
    consec,
    body: Math.abs(x.close - x.open) / range,
    upper: (x.high - Math.max(x.open, x.close)) / range,
    lower: (Math.min(x.open, x.close) - x.low) / range,
    buy: (x.close - x.low) / range,
    buy5: mean(
      b
        .slice(-5)
        .map((z) =>
          z.high === z.low ? 0.5 : (z.close - z.low) / (z.high - z.low),
        ),
    ),
    hlpos: (x.close - ll) / (hh - ll),
    up50: b.slice(-50).filter((z) => z.close >= z.open).length / 50,
    regime: mean(atr.slice(-20)) / mean(atr.slice(-50)),
    hist: last(hist),
    prevHist: hist.at(-2)!,
    squeeze: lin(deltas.slice(-20)),
    prevSqueeze: lin(deltas.slice(-21, -1)),
  };
}
export type Features = ReturnType<typeof features>;
export function closedBars(rows: Candle[], duration: number, cutoff: number) {
  const a = rows
    .filter((x) => x.time + duration * 1000 <= cutoff)
    .sort((a, b) => a.time - b.time);
  if (!a.length || a.at(-1)!.time + duration * 1000 !== cutoff)
    throw Error("missing_expected_tail");
  if (
    a
      .slice(-50)
      .some(
        (x, i, all) => i > 0 && x.time - all[i - 1].time !== duration * 1000,
      )
  )
    throw Error("non_contiguous_history");
  return a;
}
export function micro(rows: Candle[], start: number, duration: 300 | 900) {
  const a = rows
    .filter((x) => x.time >= start && x.time < start + duration * 1000)
    .sort((a, b) => a.time - b.time);
  if (
    a.length !== duration / 60 ||
    a.some((x, i) => x.time !== start + i * 60000)
  )
    throw Error("missing_micro_bars");
  const z = a.at(-1)!;
  if (z.high <= z.low) throw Error("flat_micro_bar");
  const round = (x: number, n: number) => Number(x.toFixed(n));
  return {
    lastUp: z.close >= z.open,
    last2Up: z.close >= z.open && a.at(-2)!.close >= a.at(-2)!.open,
    head: round(
      100 * (z.close / ((z.open + z.high + z.low + z.close) / 4) - 1),
      6,
    ),
    pos: round((z.close - z.low) / (z.high - z.low), 4),
    ret: round(100 * (z.close / z.open - 1), 5),
  };
}
