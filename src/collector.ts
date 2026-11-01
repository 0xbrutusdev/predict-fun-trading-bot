import WebSocket from "ws";
import { archiveCandles, parseCandles } from "./history.js";
import { Store } from "./store.js";
import type { Book, Candle, Market } from "./domain.js";
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
  ) {}
  async request(path: string) {
    const wait = Math.max(0, this.restAt - Date.now());
    this.restAt = Math.max(Date.now(), this.restAt) + 350;
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const r = await fetch(`https://api.predict.fun/v1${path}`, {
      headers: { "x-api-key": this.key },
      signal: AbortSignal.any([AbortSignal.timeout(10000), this.abort.signal]),
    });
    if (!r.ok) throw Error(`predict_http_${r.status}`);
    return r.json() as Promise<any>;
  }
  recordBook(b: Book) {
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
    const history = this.store.get<Book[]>("books", b.marketId) || [];
    if (
      history.length &&
      (b.updatedAt < history.at(-1)!.updatedAt ||
        b.receivedAt < history.at(-1)!.receivedAt)
    )
      return;
    this.store.put("books", b.marketId, [...history, b].slice(-1000));
    this.store.event("book", b, b.receivedAt);
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
          this.store.event("collector.error", { reason: String(e) });
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
      this.subscribe();
    });
    this.ws.on("message", (raw) => {
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
          this.recordBook({
            marketId: String(b.marketId),
            asks: b.asks,
            bids: b.bids,
            updatedAt: b.updateTimestampMs,
            receivedAt: Date.now(),
          });
        } else if (m.topic?.startsWith("predictTradingStatus/")) {
          const id = m.topic.split("/")[1],
            market = this.store.get<Market>("market", id);
          if (
            market &&
            market.status !== "RESOLVED" &&
            market.end > Date.now()
          ) {
            market.status = m.data.tradingStatus === "OPEN" ? "OPEN" : "CLOSED";
            this.store.put("market", id, market);
          }
        } else this.store.event("predict.event", m);
      } catch (e) {
        this.store.event("collector.error", { reason: String(e) });
      }
    });
    this.ws.on(
      "error",
      () =>
        !this.stopped &&
        this.store.event("collector.error", { reason: "websocket_error" }),
    );
    this.ws.on("close", () => {
      if (!this.stopped) {
        this.schedule(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 30000);
      }
    });
  }
  private subscribe() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    for (const m of this.store
      .list<Market>("market")
      .filter((m) => m.end > Date.now()))
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
  async refresh() {
    const payload = await this.request(
      "/markets?first=100&marketVariant=CRYPTO_UP_DOWN",
    );
    this.store.put("discovery", "latest", {
      time: Date.now(),
      data: payload.data,
      cursor: payload.cursor,
    });
    this.store.event("discovery", payload);
    this.subscribe();
    for (const m of this.store
      .list<Market>("market")
      .filter((m) => m.status === "OPEN" && m.end > Date.now())) {
      const { data } = await this.request(
        `/markets/${encodeURIComponent(m.id)}/orderbook`,
      );
      this.recordBook({
        marketId: m.id,
        asks: data.asks,
        bids: data.bids,
        updatedAt: data.updateTimestampMs,
        receivedAt: Date.now(),
      });
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
        this.store.transaction(() =>
          archiveCandles(this.store, symbol, duration, rows, observedAt),
        );
        const prior =
          this.store.get<Candle[]>("candles", `${symbol}:${duration}`) || [];
        const combined = [
          ...new Map([...prior, ...rows].map((x) => [x.time, x])).values(),
        ]
          .sort((a, b) => a.time - b.time)
          .slice(-86400);
        this.store.put("candles", `${symbol}:${duration}`, combined);
        this.store.event("candles", { symbol, duration, rows }, observedAt);
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
