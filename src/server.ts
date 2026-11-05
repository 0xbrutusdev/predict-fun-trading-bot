import { Store } from "./store.js";
import { createApp } from "./api.js";
import { Engine } from "./engine.js";
import { Collector } from "./collector.js";
import type { RuntimeStatus } from "./observability.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import type { MarketAutomationPolicy } from "./market-automation.js";

// Load local configuration when the app is started directly (for example with
// `tsx src/server.ts`). Existing process environment variables take precedence.
for (const envFile of [".env", ".env.local"]) {
  if (existsSync(envFile)) loadEnvFile(envFile);
}

const runtime: RuntimeStatus = {
  startedAt: Date.now(),
  lastTickAt: null,
  lastTickMs: null,
  engineErrors: 0,
  lastEngineErrorAt: null,
  collectorEnabled: process.env.COLLECTOR_ENABLED === "true",
  writerLeaseHeld: false,
};
const mongoUri = process.env.MONGODB_URI,
  mongoDatabase = process.env.MONGODB_DB_NAME ?? "predict_fun_trading_bot";
if (!mongoUri) throw Error("MONGODB_URI is required");
const store = await Store.connect(mongoUri, mongoDatabase);
const app = await createApp(
  store,
  process.env.API_TOKEN ?? "",
  process.env.ALLOWED_ORIGIN,
  process.env.API_READ_TOKEN,
  runtime,
);
const engine = new Engine(store);
const workerId = randomUUID();
const list = (value: string | undefined, fallback: string[]) =>
  value
    ? value
        .split(",")
        .map((item) => item.trim().toUpperCase())
        .filter(Boolean)
    : fallback;
const durations = list(process.env.AUTO_MARKET_DURATIONS, ["300", "900"])
  .map(Number)
  .filter((value): value is 300 | 900 => value === 300 || value === 900);
const lookahead = Number(process.env.AUTO_MARKET_LOOKAHEAD_MS ?? 1800000);
const marketPolicy: MarketAutomationPolicy = {
  enabled: process.env.AUTO_MARKETS_ENABLED === "true",
  symbols: list(process.env.AUTO_MARKET_SYMBOLS, ["BTC", "ETH"]),
  durations,
  providers: list(process.env.AUTO_MARKET_PROVIDERS, ["CHAINLINK"]),
  lookaheadMs:
    Number.isSafeInteger(lookahead) && lookahead >= 0
      ? lookahead
      : 30 * 60 * 1000,
};
const collector = new Collector(
  store,
  process.env.PREDICT_API_KEY ?? "",
  marketPolicy,
);
if (process.env.COLLECTOR_ENABLED === "true") collector.start();
let ticking = false;
const timer = setInterval(async () => {
  if (ticking) return;
  ticking = true;
  const started = performance.now();
  try {
    runtime.writerLeaseHeld = await store.acquireLease(
      "paper-execution",
      workerId,
      Date.now(),
      5000,
    );
    if (!runtime.writerLeaseHeld) return;
    await engine.step();
    runtime.lastTickAt = Date.now();
  } catch (e) {
    runtime.engineErrors++;
    runtime.lastEngineErrorAt = Date.now();
    app.log.error(e);
  } finally {
    runtime.lastTickMs = performance.now() - started;
    ticking = false;
  }
}, 250);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await collector.stop();
  await store.releaseLease("paper-execution", workerId);
  await app.close();
  await store.close();
};
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
await app.listen({
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
});
