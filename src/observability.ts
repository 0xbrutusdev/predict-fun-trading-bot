import type { Store } from "./store.js";
import type { Book, Candle, Market } from "./domain.js";
export type RuntimeStatus = {
  startedAt: number;
  lastTickAt: number | null;
  lastTickMs: number | null;
  engineErrors: number;
  lastEngineErrorAt: number | null;
  collectorEnabled: boolean;
};
export function observability(
  store: Store,
  runtime?: RuntimeStatus,
  now = Date.now(),
) {
  const markets = store
    .list<Market>("market")
    .filter((m) => m.status === "OPEN" && m.start <= now && m.end > now);
  const stale = markets.filter((m) => {
    const b = store.get<Book[]>("books", m.id)?.at(-1);
    return (
      !b ||
      now - b.receivedAt > 1000 ||
      now - b.updatedAt > 1000 ||
      b.receivedAt > now + 250
    );
  });
  const reasons: string[] = [];
  if (
    !runtime ||
    runtime.lastTickAt === null ||
    now - runtime.lastTickAt > 5000
  )
    reasons.push("engine_heartbeat_missing");
  if (runtime?.lastEngineErrorAt && now - runtime.lastEngineErrorAt < 60000)
    reasons.push("recent_engine_error");
  if (!runtime?.collectorEnabled) reasons.push("collector_disabled");
  if (!markets.length) reasons.push("no_active_registered_markets");
  if (stale.length) reasons.push("stale_order_books");
  const rows = store.db
    .prepare(
      "SELECT seq,time,type,json FROM events WHERE type NOT IN ('book','candles') ORDER BY seq DESC LIMIT 50",
    )
    .all() as { seq: number; time: number; type: string; json: string }[];
  const latestCollectorError = store.db
    .prepare(
      "SELECT time FROM events WHERE type='collector.error' ORDER BY seq DESC LIMIT 1",
    )
    .get() as { time: number } | undefined;
  if (latestCollectorError && now - latestCollectorError.time < 60000)
    reasons.push("recent_collector_error");
  const candleFeeds = store.db
    .prepare("SELECT id,json FROM documents WHERE kind='candles'")
    .all() as { id: string; json: string }[];
  const feeds = new Map(
    candleFeeds.map((row) => [row.id, JSON.parse(row.json) as Candle[]]),
  );
  const missingFeeds = new Set<string>();
  for (const market of markets)
    for (const duration of [60, market.duration, 3600]) {
      const key = `${market.symbol}:${duration}`,
        bars = feeds.get(key);
      const minimum = duration === 60 ? market.duration / 60 : 200;
      if (
        !bars ||
        bars.length < minimum ||
        now - (bars.at(-1)!.time + duration * 1000) > duration * 1000 + 30000
      )
        missingFeeds.add(key);
    }
  if (missingFeeds.size) reasons.push("insufficient_or_stale_candles");
  return {
    time: now,
    readiness: reasons.length ? "degraded" : "ready",
    reasons,
    runtime: runtime ?? null,
    activeMarkets: markets.length,
    staleBooks: stale.length,
    missingCandleFeeds: [...missingFeeds],
    candleFeeds: candleFeeds.map((row) => {
      const bars = JSON.parse(row.json) as Candle[];
      return {
        id: row.id,
        bars: bars.length,
        latest: bars.at(-1)?.time ?? null,
      };
    }),
    events: rows.map(({ json, ...row }) => ({
      ...row,
      data: JSON.parse(json),
    })),
  };
}
