// Isolated in-memory fixture; never opens the operator's trading database.
import { Store } from "../src/store.js";
import { createApp } from "../src/api.js";
const store = new Store(":memory:");
const app = await createApp(
  store,
  "integration-worker-token-00000000000000000",
);
await app.listen({ host: "127.0.0.1", port: 3100 });
async function close() {
  await app.close();
  await store.close();
  process.exit(0);
}
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
