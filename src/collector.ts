import WebSocket from "ws";
import { archiveCandles, parseCandles } from "./history.js";
import { Store } from "./store.js";
import type { Book, Candle, Market } from "./domain.js";
import { settle } from "./execution.js";
import {
  authoritativePayout,
  parsePredictContract,
  registrationEligibility,
  type MarketAutomationPolicy,
} from "./market-automation.js";

const disabledAutomation: MarketAutomationPolicy = {
  enabled: false,
  symbols: ["BTC", "ETH"],
  durations: [300, 900],
  providers: ["CHAINLINK"],
  lookaheadMs: 30 * 60 * 1000,
};
export class Collector {
  private ws?: WebSocket;
  private abort = new AbortController();
  private tasks = new Set<Promise<void>>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private lastMessage = Date.now();
  private schedule(fn: () => void, ms: number) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.stopped) fn();
    }, ms);
    this.timers.add(timer);
  }
  private stopped = false;
  private backoff = 1000;
  private requestId = 0;
  private subscribed = new Set<string>();
  private restAt = 0;
  constructor(
    private store: Store,
    private key: string,
    private marketPolicy: MarketAutomationPolicy = disabledAutomation,
    private fetcher: typeof fetch = fetch,
    private wait: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}
  private async eventOnce(
    id: string,
    fingerprint: string,
    type: string,
    data: unknown,
    now: number,
  ) {
    const previous = await this.store.get<{ fingerprint: string }>(
      "automation_event",
      id,
    );
    if (previous?.fingerprint === fingerprint) return;
    await this.store.put("automation_event", id, { fingerprint, time: now });
    await this.store.event(type, data, now);
  }
  async request(path: string) {
    const wait = Math.max(0, this.restAt - Date.now());
    this.restAt = Math.max(Date.now(), this.restAt) + 350;
    if (wait) await this.wait(wait);
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await this.fetcher(`https://api.predict.fun/v1${path}`, {
        headers: { "x-api-key": this.key },
        signal: AbortSignal.any([
          AbortSignal.timeout(10000),
          this.abort.signal,
        ]),
      });
      if (response.ok) return response.json() as Promise<any>;
      if (attempt === 3 || (response.status !== 429 && response.status < 500))
        throw Error(`predict_http_${response.status}`);
      const retryAfter = Number(response.headers.get("retry-after"));
      await this.wait(
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 500 * 2 ** attempt,
      );
    }
    throw Error("predict_request_exhausted");
  }
  async recordBook(b: Book) {
    if (
      !Number.isSafeInteger(b.receivedAt) ||
      !Number.isSafeInteger(b.updatedAt) ||
      !Array.isArray(b.asks) ||
      !Array.isArray(b.bids) ||
      b.updatedAt > b.receivedAt + 250 ||
      [...b.asks, ...b.bids].some(
        (x) =>
          !Array.isArray(x) ||
          x.length !== 2 ||
          !x.every(Number.isFinite) ||
          x[0] < 0 ||
          x[0] > 1 ||
          x[1] < 0,
      )
    )
      throw Error("invalid_book");
    const history = (await this.store.get<Book[]>("books", b.marketId)) || [];
    if (
      history.length &&
      (b.updatedAt < history.at(-1)!.updatedAt ||
        b.receivedAt < history.at(-1)!.receivedAt)
    )
      return;
    await this.store.put("books", b.marketId, [...history, b].slice(-1000));
    await this.store.event("book", b, b.receivedAt);
  }
  start() {
    if (!this.key) throw Error("PREDICT_API_KEY_required");
    this.connect();
    this.repeat(() => this.refresh(), 15000);
    this.repeat(async () => {
      if (Date.now() - this.lastMessage > 45000) this.ws?.terminate();
    }, 15000);
    this.repeat(() => this.candles(), 30000);
  }
  private repeat(fn: () => Promise<void>, ms: number) {
    const tick = async () => {
      if (this.stopped) return;
      try {
        await fn();
      } catch (e) {
        if (!this.stopped)
          await this.store.event("collector.error", { reason: String(e) });
      }
      if (!this.stopped) this.schedule(launch, ms);
    };
    const launch = () => {
      const task = tick();
      this.tasks.add(task);
      void task.finally(() => this.tasks.delete(task));
    };
    launch();
  }
  private connect() {
    if (this.stopped) return;
    this.ws = new WebSocket("wss://ws.predict.fun/ws", {
      headers: { "x-api-key": this.key },
      handshakeTimeout: 10000,
    });
    this.ws.on("open", () => {
      this.backoff = 1000;
      this.lastMessage = Date.now();
      this.subscribed.clear();
      void this.subscribe();
    });
    this.ws.on("message", async (raw) => {
      if (this.stopped) return;
      this.lastMessage = Date.now();
      try {
        const m = JSON.parse(raw.toString());
        if (m.topic === "heartbeat") {
          this.ws?.send(JSON.stringify({ method: "heartbeat", data: m.data }));
          return;
        }
        if (m.topic?.startsWith("predictOrderbook/")) {
          const b = m.data;
          await this.recordBook({
            marketId: String(b.marketId),
            asks: b.asks,
            bids: b.bids,
            updatedAt: b.updateTimestampMs,
            receivedAt: Date.now(),
          });
        } else if (m.topic?.startsWith("predictTradingStatus/")) {
          const id = m.topic.split("/")[1],
            market = await this.store.get<Market>("market", id);
          if (
            market &&
            market.status !== "RESOLVED" &&
            !market.blockedReason &&
            market.end > Date.now()
          ) {
            market.status = m.data.tradingStatus === "OPEN" ? "OPEN" : "CLOSED";
            await this.store.put("market", id, market);
          }
        } else await this.store.event("predict.event", m);
      } catch (e) {
        await this.store.event("collector.error", { reason: String(e) });
      }
    });
    this.ws.on(
      "error",
      () =>
        !this.stopped &&
        void this.store.event("collector.error", { reason: "websocket_error" }),
    );
    this.ws.on("close", () => {
      if (!this.stopped) {
        this.schedule(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 30000);
      }
    });
  }
  private async subscribe() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    for (const m of (await this.store.list<Market>("market")).filter(
      (m) => m.end > Date.now(),
    ))
      for (const prefix of [
        "predictOrderbook",
        "predictTradingStatus",
        "predictMarketStatus",
      ]) {
        const topic = `${prefix}/${m.id}`;
        if (!this.subscribed.has(topic)) {
          this.ws.send(
            JSON.stringify({
              method: "subscribe",
              requestId: ++this.requestId,
              params: [topic],
            }),
          );
          this.subscribed.add(topic);
        }
      }
  }
  async refresh(now = Date.now()) {
    const discovered: unknown[] = [],
      cursors = new Set<string>();
    let after: string | undefined;
    for (let page = 0; page < 5; page++) {
      const payload = await this.request(
        `/markets?first=100&status=OPEN&marketVariant=CRYPTO_UP_DOWN${after ? `&after=${encodeURIComponent(after)}` : ""}`,
      );
      if (!Array.isArray(payload.data)) throw Error("invalid_market_discovery");
      discovered.push(...payload.data);
      const cursor = typeof payload.cursor === "string" ? payload.cursor : "";
      if (!cursor || cursors.has(cursor) || payload.data.length === 0) break;
      cursors.add(cursor);
      after = cursor;
    }
    const diagnostics: Array<{
      marketId: string;
      eligible: boolean;
      reason?: string;
    }> = [];
    let registered = 0;
    for (const candidate of discovered) {
      const parsed = parsePredictContract(candidate),
        marketId = String((candidate as any)?.id ?? "unknown");
      if (!parsed.ok) {
        diagnostics.push({
          marketId,
          eligible: false,
          reason: parsed.reason,
        });
        continue;
      }
      const eligibility = registrationEligibility(
        parsed.market,
        this.marketPolicy,
        now,
      );
      diagnostics.push({
        marketId: parsed.market.id,
        eligible: eligibility.eligible,
        ...(!eligibility.eligible ? { reason: eligibility.reason } : {}),
      });
      if (!eligibility.eligible) continue;
      const existing = await this.store.get<Market>("market", parsed.market.id);
      if (!existing) {
        const market = { ...parsed.market, registeredAt: now };
        await this.store.transaction(async () => {
          await this.store.put("market", market.id, market);
          await this.store.event("market.auto_registered", market, now);
        });
        registered++;
      } else if (
        existing.source === "predict-auto-v1" &&
        existing.rulesHash !== parsed.market.rulesHash
      ) {
        await this.store.put("market", existing.id, {
          ...existing,
          status: "CLOSED",
          blockedReason: "rules_changed",
        });
        await this.eventOnce(
          `rules:${existing.id}`,
          parsed.market.rulesHash,
          "market.rules_changed",
          {
            marketId: existing.id,
            expected: existing.rulesHash,
            observed: parsed.market.rulesHash,
          },
          now,
        );
      }
    }
    await this.store.put("discovery", "latest", {
      time: now,
      data: discovered,
      diagnostics,
    });
    await this.store.put("automation", "market", {
      ...this.marketPolicy,
      lastRefreshAt: now,
      discovered: discovered.length,
      eligible: diagnostics.filter((item) => item.eligible).length,
      registered,
      rejected: diagnostics.filter((item) => !item.eligible).length,
    });
    await this.store.event(
      "discovery",
      { count: discovered.length, diagnostics },
      now,
    );
    await this.subscribe();
    for (const market of (await this.store.list<Market>("market")).filter(
      (market) =>
        market.source === "predict-auto-v1" && market.status !== "RESOLVED",
    )) {
      let payload: any;
      try {
        payload = await this.request(
          `/markets/${encodeURIComponent(market.id)}`,
        );
      } catch (error) {
        await this.eventOnce(
          `reconcile:${market.id}`,
          String(error),
          "market.reconcile_failed",
          { marketId: market.id, reason: String(error) },
          now,
        );
        continue;
      }
      const parsed = parsePredictContract(payload.data);
      if (!parsed.ok) {
        await this.store.put("market", market.id, {
          ...market,
          status: "CLOSED",
          blockedReason: "invalid_market_contract",
        });
        await this.eventOnce(
          `contract:${market.id}`,
          parsed.reason,
          "market.contract_invalid",
          { marketId: market.id, reason: parsed.reason },
          now,
        );
        continue;
      }
      if (parsed.market.rulesHash !== market.rulesHash) {
        await this.store.put("market", market.id, {
          ...market,
          status: "CLOSED",
          blockedReason: "rules_changed",
        });
        await this.eventOnce(
          `rules:${market.id}`,
          parsed.market.rulesHash,
          "market.rules_changed",
          {
            marketId: market.id,
            expected: market.rulesHash,
            observed: parsed.market.rulesHash,
          },
          now,
        );
        continue;
      }
      const payout = authoritativePayout(payload.data, market);
      if (payout && now >= market.end) {
        const resolved = {
          ...market,
          status: "RESOLVED" as const,
          payout: payout.payout,
          resolutionSource: payout.source,
          endPrice: parsed.market.endPrice,
          blockedReason: undefined,
        };
        await settle(this.store, resolved, now);
        await this.store.event(
          "resolution.evidence",
          { marketId: market.id, source: payout.source, automatic: true },
          now,
        );
      } else if (parsed.market.status !== "OPEN") {
        await this.store.put("market", market.id, {
          ...market,
          status: "CLOSED",
        });
        await this.eventOnce(
          `resolution:${market.id}`,
          String((payload.data as any)?.status ?? "unknown"),
          "resolution.pending",
          { marketId: market.id, reason: "authoritative_payout_unavailable" },
          now,
        );
      }
    }
    for (const m of (await this.store.list<Market>("market")).filter(
      (m) => m.status === "OPEN" && m.end > now,
    )) {
      try {
        const { data } = await this.request(
          `/markets/${encodeURIComponent(m.id)}/orderbook`,
        );
        await this.recordBook({
          marketId: m.id,
          asks: data.asks,
          bids: data.bids,
          updatedAt: data.updateTimestampMs,
          receivedAt: Date.now(),
        });
      } catch (error) {
        await this.eventOnce(
          `book:${m.id}`,
          String(error),
          "market.book_refresh_failed",
          { marketId: m.id, reason: String(error) },
          now,
        );
      }
    }
  }
  async candles() {
    for (const symbol of ["BTC", "ETH", "SOL", "DOGE"])
      for (const [duration, bar] of [
        [60, "1m"],
        [300, "5m"],
        [900, "15m"],
        [3600, "1H"],
      ] as const) {
        if (this.stopped) return;
        const r = await fetch(
          `https://www.okx.com/api/v5/market/candles?instId=${symbol}-USDT-SWAP&bar=${bar}&limit=300`,
          {
            signal: AbortSignal.any([
              AbortSignal.timeout(10000),
              this.abort.signal,
            ]),
          },
        );
        if (!r.ok) throw Error(`okx_http_${r.status}`);
        const body = (await r.json()) as any;
        if (body.code !== "0") throw Error("okx_error");
        const observedAt = Date.now();
        const rows = parseCandles(body.data, duration, observedAt);
        await this.store.transaction(() =>
          archiveCandles(this.store, symbol, duration, rows, observedAt),
        );
        const prior =
          (await this.store.get<Candle[]>(
            "candles",
            `${symbol}:${duration}`,
          )) || [];
        const combined = [
          ...new Map([...prior, ...rows].map((x) => [x.time, x])).values(),
        ]
          .sort((a, b) => a.time - b.time)
          .slice(-86400);
        await this.store.put("candles", `${symbol}:${duration}`, combined);
        await this.store.event(
          "candles",
          { symbol, duration, rows },
          observedAt,
        );
        await new Promise((r) => setTimeout(r, 120));
      }
  }
  async stop() {
    this.stopped = true;
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.abort.abort();
    this.ws?.terminate();
    await Promise.allSettled([...this.tasks]);
  }
}
