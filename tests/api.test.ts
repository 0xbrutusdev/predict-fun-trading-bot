import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { createApp } from "../src/api.js";
test("authenticated API validates account configuration, read scopes, and publishes contract", async () => {
  const s = new Store(":memory:"),
    token = "a".repeat(32),
    app = await createApp(s, token, undefined, "b".repeat(32)),
    headers = { authorization: `Bearer ${token}` };
  assert.equal((await app.inject("/v1/accounts")).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/accounts",
        headers: { authorization: `Bearer ${"b".repeat(32)}` },
        payload: {},
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/v1/accounts",
        headers,
        payload: { name: "x", initialEquity: 1000, privateKey: "secret" },
      })
    ).statusCode,
    400,
  );
  const res = await app.inject({
    method: "POST",
    url: "/v1/accounts",
    headers,
    payload: { name: "test", initialEquity: 10000 },
  });
  assert.equal(res.statusCode, 200);
  const a = res.json().data;
  assert.equal(a.enabled, false);
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: `/v1/accounts/${a.id}/strategies`,
        headers,
        payload: { enabledSlots: ["13"] },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await app.inject({ url: `/v1/accounts/${a.id}/pnl`, headers })).json().data
      .cash,
    10000,
  );
  assert.ok(
    (await app.inject({ url: "/v1/openapi.json", headers })).json().paths[
      "/v1/accounts/{id}/pnl"
    ],
  );
  await app.close();
  s.close();
});
