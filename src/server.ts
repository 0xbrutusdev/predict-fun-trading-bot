import { Store } from "./store.js";
import { createApp } from "./api.js";
import { Engine } from "./engine.js";
import { Collector } from "./collector.js";
import type { RuntimeStatus } from "./observability.js";
const runtime: RuntimeStatus = {
  startedAt: Date.now(),
  lastTickAt: null,
  lastTickMs: null,
  engineErrors: 0,
  lastEngineErrorAt: null,
  collectorEnabled: process.env.COLLECTOR_ENABLED === "true",
};
const store = new Store(process.env.DATABASE_PATH ?? "data/bot.db");
const app = await createApp(
  store,
  process.env.API_TOKEN ?? "",
  process.env.ALLOWED_ORIGIN,
  process.env.API_READ_TOKEN,
  runtime,
);
const engine = new Engine(store);
const collector = new Collector(store, process.env.PREDICT_API_KEY ?? "");
if (process.env.COLLECTOR_ENABLED === "true") collector.start();
const timer = setInterval(() => {
  const started = performance.now();
  try {
    engine.step();
    runtime.lastTickAt = Date.now();
  } catch (e) {
    runtime.engineErrors++;
    runtime.lastEngineErrorAt = Date.now();
    app.log.error(e);
  } finally {
    runtime.lastTickMs = performance.now() - started;
  }
}, 250);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await collector.stop();
  await app.close();
  store.close();
};
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
await app.listen({
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
});
