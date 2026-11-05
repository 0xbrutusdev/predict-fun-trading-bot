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
  assert.equal(a.revision, 1);
  const initialConfig = (
    await app.inject({ url: `/v1/accounts/${a.id}/strategies`, headers })
  ).json().data;
  assert.equal(initialConfig.revision, 1);
  assert.ok(initialConfig.enabledSlots.length > 0);
  const updated = await app.inject({
    method: "PATCH",
    url: `/v1/accounts/${a.id}`,
    headers,
    payload: { fixedShares: 10, expectedRevision: 1 },
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().data.revision, 2);
  assert.equal(
    (
      await app.inject({
        method: "PATCH",
        url: `/v1/accounts/${a.id}`,
        headers,
        payload: { fixedShares: 20, expectedRevision: 1 },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await app.inject({ url: "/v1/markets/automation", headers })).json().data
      .enabled,
    false,
  );
  const manualMarket = await app.inject({
    method: "POST",
    url: "/v1/markets",
    headers,
    payload: {
      id: "manual-market",
      symbol: "BTC",
      duration: 300,
      start: 0,
      end: 300000,
      upToken: "11",
      downToken: "22",
      yesIsUp: true,
      status: "OPEN",
      feeBps: 200,
      tick: 0.01,
      rulesHash: "manual-review-v1",
    },
  });
  assert.equal(manualMarket.statusCode, 200);
  assert.equal(manualMarket.json().data.source, undefined);
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
  const selected = await app.inject({
    method: "PUT",
    url: `/v1/accounts/${a.id}/strategies`,
    headers,
    payload: { enabledSlots: ["1"], expectedRevision: 1 },
  });
  assert.equal(selected.statusCode, 200);
  assert.equal(selected.json().data.revision, 2);
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: `/v1/accounts/${a.id}/strategies`,
        headers,
        payload: { enabledSlots: ["2"], expectedRevision: 1 },
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
test("authenticated dashboard traffic is not exhausted by the anonymous IP quota", async () => {
  const store = new Store(":memory:"),
    token = "q".repeat(32),
    app = await createApp(store, token),
    headers = { authorization: `Bearer ${token}` };
  try {
    for (let request = 0; request < 130; request++)
      assert.notEqual(
        (await app.inject({ url: "/v1/status", headers })).statusCode,
        429,
      );
  } finally {
    await app.close();
    store.close();
  }
});
