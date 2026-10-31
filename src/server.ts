import { Store } from "./store.js";
import { createApp } from "./api.js";
import { Engine } from "./engine.js";
import { Collector } from "./collector.js";
const store = new Store(process.env.DATABASE_PATH ?? "data/bot.db");
const app = await createApp(
  store,
  process.env.API_TOKEN ?? "",
  process.env.ALLOWED_ORIGIN,
  process.env.API_READ_TOKEN,
);
const engine = new Engine(store);
const collector = new Collector(store, process.env.PREDICT_API_KEY ?? "");
if (process.env.COLLECTOR_ENABLED === "true") collector.start();
const timer = setInterval(() => {
  try {
    engine.step();
  } catch (e) {
    app.log.error(e);
  }
}, 250);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  collector.stop();
  await app.close();
  store.close();
};
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
await app.listen({
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
});
