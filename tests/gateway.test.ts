import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.js";
import { createApp } from "../src/api.js";
import {
  login,
  logout,
  proxy,
  session,
  authenticated,
  allowed,
} from "../web/lib/gateway.js";

test("Next gateway integrates with real worker: login, scopes, account, strategies, PnL and pause", async () => {
  const store = new Store(":memory:"),
    token = "t".repeat(40),
    key = "k".repeat(40);
  const app = await createApp(store, token);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as { port: number };
  const c = { url: `http://127.0.0.1:${address.port}`, token, key };
  const req = (
    path: string,
    method = "GET",
    body?: unknown,
    cookie = `predict_session=${session(key)}`,
  ) =>
    new Request(`http://localhost:3001/api/bot/${path}`, {
      method,
      headers: {
        cookie,
        origin: "http://localhost:3001",
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    assert.equal(
      (await proxy(req("accounts", "GET", undefined, ""), "accounts", c))
        .status,
      401,
    );
    const signed = await login(req("", "POST", { key }), c);
    assert.match(
      signed.headers.get("set-cookie")!,
      /HttpOnly; SameSite=Strict/,
    );
    assert.equal(
      (await login(req("", "POST", { key: "wrong" }), c)).status,
      401,
    );
    const cross = new Request("http://localhost:3001/api/session", {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ key }),
    });
    assert.equal((await login(cross, c)).status, 403);
    assert.equal((await logout(cross, c)).status, 403);
    assert.equal(
      authenticated(
        req(
          "",
          "GET",
          undefined,
          `predict_session=${session(key, Date.now() - 9 * 3600_000)}`,
        ),
        c,
      ),
      false,
    );
    assert.equal(
      authenticated(
        req("", "GET", undefined, `predict_session=${session(key)}tampered`),
        c,
      ),
      false,
    );
    assert.equal(allowed("../health", "GET"), false);
    assert.equal(allowed("markets", "POST"), false);
    const created = await proxy(
      req("accounts", "POST", { name: "integration", initialEquity: 10000 }),
      "accounts",
      c,
    );
    assert.equal(created.status, 200);
    const { data: a } = await created.json();
    assert.equal(a.enabled, false);
    const path = `accounts/${a.id}`;
    assert.equal(
      (await proxy(req(path, "PATCH", { enabled: true }), path, c)).status,
      200,
    );
    const blocked = `${path}/strategies`;
    assert.equal(
      (await proxy(req(blocked, "PUT", { enabledSlots: ["13"] }), blocked, c))
        .status,
      409,
    );
    assert.equal(
      (await proxy(req(blocked, "PUT", { enabledSlots: ["1"] }), blocked, c))
        .status,
      200,
    );
    assert.equal(
      (await (await proxy(req(`${path}/pnl`), `${path}/pnl`, c)).json()).data
        .cash,
      10000,
    );
    const health = await (
      await proxy(req("observability"), "observability", c)
    ).json();
    assert.equal(health.data.readiness, "degraded");
    assert.ok(health.data.reasons.includes("engine_heartbeat_missing"));
    assert.equal(
      (await proxy(req("kill-switch", "POST", {}), "kill-switch", c)).status,
      200,
    );
    assert.equal(
      (await (await proxy(req(path), path, c)).json()).data.enabled,
      false,
    );
    assert.equal(
      (await proxy(req("accounts"), "accounts", { key })).status,
      503,
    );
    assert.equal(
      (
        await proxy(req("accounts"), "accounts", c, async () => {
          throw Error("secret upstream detail");
        })
      ).status,
      502,
    );
    const forbidden = new Request(`http://localhost:3001/api/bot/${path}`, {
      method: "PATCH",
      headers: {
        cookie: `predict_session=${session(key)}`,
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: '{"enabled":true}',
    });
    assert.equal((await proxy(forbidden, path, c)).status, 403);
    const readOnly = await createApp(store, token, undefined, "r".repeat(40));
    await readOnly.listen({ host: "127.0.0.1", port: 0 });
    try {
      const rc = {
        ...c,
        url: `http://127.0.0.1:${(readOnly.server.address() as { port: number }).port}`,
        token: "r".repeat(40),
      };
      assert.equal(
        (await proxy(req(path, "PATCH", { enabled: true }), path, rc)).status,
        403,
      );
    } finally {
      await readOnly.close();
    }
  } finally {
    await app.close();
    store.close();
  }
});
