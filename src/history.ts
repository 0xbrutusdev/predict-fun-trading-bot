import { Store } from "./store.js";
import type { Candle } from "./domain.js";
export const bars = { 60: "1m", 300: "5m", 900: "15m", 3600: "1H" } as const;
export type Duration = keyof typeof bars;
export function parseCandles(
  payload: unknown,
  duration: Duration,
  observedAt: number,
): Candle[] {
  if (!Array.isArray(payload) || !Number.isSafeInteger(observedAt))
    throw Error("invalid_candle_payload");
  return payload
    .filter((x) => Array.isArray(x) && x[8] === "1")
    .map((x) => {
      const [time, open, high, low, close, volume] = x.slice(0, 6).map(Number);
      if (
        ![time, open, high, low, close, volume].every(Number.isFinite) ||
        !Number.isSafeInteger(time) ||
        time < 0 ||
        time % (duration * 1000) !== 0 ||
        time + duration * 1000 > observedAt ||
        low <= 0 ||
        high < low ||
        open < low ||
        open > high ||
        close < low ||
        close > high ||
        volume < 0
      )
        throw Error("invalid_closed_candle");
      return { time, open, high, low, close, volume };
    });
}
export async function archiveCandles(
  store: Store,
  symbol: string,
  duration: Duration,
  rows: Candle[],
  observedAt: number,
) {
  for (const row of rows)
    await store.archiveCandle(symbol, duration, row, observedAt);
}
export async function historyAt(
  store: Store,
  symbol: string,
  duration: Duration,
  start: number,
  end: number,
  availableAt: number,
): Promise<Candle[]> {
  return store.candleHistory(symbol, duration, start, end, availableAt);
}
type Options = {
  symbol: string;
  duration: Duration;
  start: number;
  end: number;
  maxPages?: number;
};
type Dependencies = {
  request?: (url: string) => Promise<{ code: string; data: unknown }>;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
};
export async function backfill(
  store: Store,
  o: Options,
  deps: Dependencies = {},
) {
  if (
    !["BTC", "ETH", "SOL", "DOGE"].includes(o.symbol) ||
    !bars[o.duration] ||
    ![o.start, o.end].every(Number.isSafeInteger) ||
    o.start < 0 ||
    o.end <= o.start ||
    o.start % (o.duration * 1000) ||
    o.end % (o.duration * 1000)
  )
    throw Error("invalid_history_range");
  const now = deps.now ?? Date.now;
  if (o.end > now()) throw Error("history_range_not_closed");
  const wait = deps.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const request =
    deps.request ??
    (async (url: string) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw Error(`okx_history_http_${response.status}`);
      return response.json() as Promise<{ code: string; data: unknown }>;
    });
  const id = `${o.symbol}:${o.duration}:${o.start}:${o.end}`;
  const job = (await store.get<{ cursor: number; pages: number }>(
    "history_job",
    id,
  )) ?? { cursor: o.end, pages: 0 };
  let pages = 0;
  while (job.cursor > o.start && pages < (o.maxPages ?? 5000)) {
    const url = `https://www.okx.com/api/v5/market/history-candles?instId=${o.symbol}-USDT-SWAP&bar=${bars[o.duration]}&after=${job.cursor}&limit=100`;
    let payload: Awaited<ReturnType<typeof request>> | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const p = await request(url);
        if (p.code !== "0") throw Error(`okx_history_code_${p.code}`);
        payload = p;
        break;
      } catch (e) {
        if (attempt === 3) throw e;
        await wait(500 * 2 ** attempt);
      }
    }
    const receivedAt = now(),
      rows = parseCandles(payload!.data, o.duration, receivedAt).filter(
        (x) => x.time < job.cursor && x.time >= o.start && x.time < o.end,
      );
    if (!rows.length) break;
    const cursor = Math.min(...rows.map((x) => x.time));
    if (cursor >= job.cursor) throw Error("non_advancing_history_cursor");
    await store.transaction(async () => {
      await archiveCandles(store, o.symbol, o.duration, rows, receivedAt);
      job.cursor = cursor;
      job.pages++;
      await store.put("history_job", id, job);
      await store.event(
        "candles.backfill",
        { symbol: o.symbol, duration: o.duration, rows, jobId: id },
        receivedAt,
      );
    });
    pages++;
    await wait(250);
  }
  const rows = await historyAt(
      store,
      o.symbol,
      o.duration,
      o.start,
      o.end,
      now(),
    ),
    expected = (o.end - o.start) / (o.duration * 1000),
    present = new Set(rows.map((x) => x.time));
  let missing = 0;
  const firstMissing: number[] = [];
  for (let t = o.start; t < o.end; t += o.duration * 1000)
    if (!present.has(t)) {
      missing++;
      if (firstMissing.length < 20) firstMissing.push(t);
    }
  const report = {
    id,
    symbol: o.symbol,
    duration: o.duration,
    start: o.start,
    end: o.end,
    expected,
    received: rows.length,
    missing,
    firstMissing,
    complete: missing === 0,
    pages: job.pages,
    cursor: job.cursor,
  };
  await store.put("history_report", id, report);
  return report;
}
