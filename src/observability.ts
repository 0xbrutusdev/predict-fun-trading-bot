import type { Store } from "./store.js";
import type { Book, Candle, Market } from "./domain.js";
export type RuntimeStatus = {
  startedAt: number;
  lastTickAt: number | null;
  lastTickMs: number | null;
  engineErrors: number;
  lastEngineErrorAt: number | null;
  collectorEnabled: boolean;
  writerLeaseHeld?: boolean;
};
export async function observability(
  store: Store,
  runtime?: RuntimeStatus,
  now = Date.now(),
) {
  const markets = (await store.list<Market>("market")).filter(
    (m) => m.status === "OPEN" && m.start <= now && m.end > now,
  );
  const stale: Market[] = [];
  for (const m of markets) {
    const b = (await store.get<Book[]>("books", m.id))?.at(-1);
    if (
      !b ||
      now - b.receivedAt > 1000 ||
      now - b.updatedAt > 1000 ||
      b.receivedAt > now + 250
    )
      stale.push(m);
  }
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
  if (runtime?.writerLeaseHeld === false) reasons.push("writer_lease_missing");
  if (!markets.length) reasons.push("no_active_registered_markets");
  if (stale.length) reasons.push("stale_order_books");
  const rows = await store.recentEvents(["book", "candles"], 50);
  const latestCollectorError = await store.latestEventTime("collector.error");
  if (latestCollectorError && now - latestCollectorError < 60000)
    reasons.push("recent_collector_error");
  const candleFeeds = await store.listEntries<Candle[]>("candles");
  const feeds = new Map(candleFeeds.map((row) => [row.id, row.value]));
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
      const bars = row.value;
      return {
        id: row.id,
        bars: bars.length,
        latest: bars.at(-1)?.time ?? null,
      };
    }),
    events: rows,
  };
}
