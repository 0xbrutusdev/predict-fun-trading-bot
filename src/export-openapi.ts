import { mkdirSync, writeFileSync } from "node:fs";
import { createApp } from "./api.js";
import { Store } from "./store.js";
const store = new Store(":memory:");
const token = "schema-export-local-test-token-only";
const app = await createApp(store, token);
try {
  const result = await app.inject({
    url: "/v1/openapi.json",
    headers: { authorization: `Bearer ${token}` },
  });
  if (result.statusCode !== 200) throw Error("schema_generation_failed");
  mkdirSync("docs", { recursive: true });
  writeFileSync(
    "docs/openapi.json",
    JSON.stringify(result.json(), null, 2) + "\n",
  );
} finally {
  await app.close();
  store.close();
}
