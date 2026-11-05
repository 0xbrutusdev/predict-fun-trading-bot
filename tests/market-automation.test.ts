import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authoritativePayout,
  parsePredictContract,
  registrationEligibility,
  type MarketAutomationPolicy,
} from "../src/market-automation.js";
import { Store } from "../src/store.js";
import { Collector } from "../src/collector.js";

const start = Date.parse("2026-11-05T12:00:00.000Z");
const raw = {
  id: 29076,
  title: "BTC/USDT Up or Down - November 5, 7:00-7:15AM ET",
  question: "BTC/USDT Up or Down - November 5, 7:00-7:15AM ET",
  description: "Official rules. If equal, resolves 50-50.",
  tradingStatus: "OPEN",
  status: "REGISTERED",
  isVisible: true,
  isNegRisk: false,
  isYieldBearing: false,
  feeRateBps: 200,
  conditionId: "0xcondition",
  oracleQuestionId: "0xquestion",
  resolverAddress: "0xresolver",
  outcomes: [
    { name: "Up", indexSet: 1, onChainId: "111", status: "OPEN" },
    { name: "Down", indexSet: 2, onChainId: "222", status: "OPEN" },
  ],
  boostStartsAt: new Date(start).toISOString(),
  boostEndsAt: new Date(start + 900000 - 1000).toISOString(),
  categorySlug: "btc-updown-15m-test",
  decimalPrecision: 2,
  marketVariant: "CRYPTO_UP_DOWN",
  variantData: {
    type: "CRYPTO_UP_DOWN",
    priceFeedProvider: "CHAINLINK",
    startPrice: 100000,
    endPrice: null,
    priceFeedId: "btc-usdt-feed",
    priceFeedSymbol: "BTC_USDT",
  },
};
const policy: MarketAutomationPolicy = {
  enabled: true,
  symbols: ["BTC", "ETH"],
  durations: [300, 900],
  providers: ["CHAINLINK"],
  lookaheadMs: 1800000,
};

test("Predict market contract maps exact window, outcomes, precision and rules", () => {
  const parsed = parsePredictContract(raw);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(
    {
      id: parsed.market.id,
      symbol: parsed.market.symbol,
      duration: parsed.market.duration,
      start: parsed.market.start,
      end: parsed.market.end,
      upToken: parsed.market.upToken,
      downToken: parsed.market.downToken,
      tick: parsed.market.tick,
      provider: parsed.market.resolutionProvider,
      feed: parsed.market.priceFeedId,
    },
    {
      id: "29076",
      symbol: "BTC",
      duration: 900,
      start,
      end: start + 900000,
      upToken: "111",
      downToken: "222",
      tick: 0.01,
      provider: "CHAINLINK",
      feed: "btc-usdt-feed",
    },
  );
  assert.match(parsed.market.rulesHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    registrationEligibility(parsed.market, policy, start - 60000),
    { eligible: true },
  );
});

test("automation rejects unapproved or ambiguous market contracts", () => {
  const provider = parsePredictContract({
    ...raw,
    variantData: { ...raw.variantData, priceFeedProvider: "PYTH" },
  });
  assert.equal(provider.ok, true);
  if (provider.ok)
    assert.deepEqual(registrationEligibility(provider.market, policy, start), {
      eligible: false,
      reason: "provider_not_approved",
    });
  assert.deepEqual(
    parsePredictContract({
      ...raw,
      outcomes: [raw.outcomes[0], { ...raw.outcomes[1], onChainId: "111" }],
    }),
    { ok: false, reason: "invalid_outcome_tokens" },
  );
  assert.equal(
    parsePredictContract({ ...raw, boostStartsAt: "not-a-time" }).ok,
    false,
  );
});

test("authoritative payout requires resolved matching outcome identities", () => {
  const parsed = parsePredictContract(raw);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const resolved = {
    ...raw,
    tradingStatus: "CLOSED",
    status: "RESOLVED",
    resolution: { name: "Up", onChainId: "111", status: "WON" },
    outcomes: [
      { ...raw.outcomes[0], status: "WON" },
      { ...raw.outcomes[1], status: "LOST" },
    ],
    variantData: { ...raw.variantData, endPrice: 100001 },
  };
  assert.deepEqual(authoritativePayout(resolved, parsed.market), {
    payout: [1, 0],
    source: "https://api.predict.fun/v1/markets/29076",
  });
  assert.equal(
    authoritativePayout(
      { ...resolved, resolution: { ...resolved.resolution, onChainId: "222" } },
      parsed.market,
    ),
    null,
  );
  assert.equal(
    authoritativePayout(
      {
        ...resolved,
        outcomes: resolved.outcomes.map((outcome) => ({
          ...outcome,
          status: "WON",
        })),
      },
      parsed.market,
    ),
    null,
  );
});

test("collector automatically registers, rolls over and settles an approved market", async () => {
  const store = new Store(":memory:"),
    collector = new Collector(store, "test-key", policy);
  let resolved = false,
    contractChanged = false;
  (collector as any).request = async (path: string) => {
    if (path.startsWith("/markets?"))
      return { data: resolved ? [] : [raw], cursor: null };
    if (path === "/markets/29076") {
      if (contractChanged)
        return { data: { ...raw, description: "Changed venue rules" } };
      if (!resolved) return { data: raw };
      return {
        data: {
          ...raw,
          tradingStatus: "CLOSED",
          status: "RESOLVED",
          resolution: { name: "Down", onChainId: "222", status: "WON" },
          outcomes: [
            { ...raw.outcomes[0], status: "LOST" },
            { ...raw.outcomes[1], status: "WON" },
          ],
          variantData: { ...raw.variantData, endPrice: 99999 },
        },
      };
    }
    if (path === "/markets/29076/orderbook")
      return {
        data: {
          asks: [[0.6, 10]],
          bids: [[0.4, 10]],
          updateTimestampMs: Date.now(),
        },
      };
    throw Error(`unexpected request ${path}`);
  };
  try {
    await collector.refresh(start + 1000);
    const registered = await store.get<any>("market", "29076");
    assert.equal(registered.source, "predict-auto-v1");
    assert.equal(registered.status, "OPEN");
    assert.equal((await store.get<any>("automation", "market"))!.registered, 1);
    contractChanged = true;
    await collector.refresh(start + 2000);
    assert.equal(
      (await store.get<any>("market", "29076"))!.blockedReason,
      "rules_changed",
    );
    contractChanged = false;
    resolved = true;
    await collector.refresh(start + 900000 + 5000);
    const settled = await store.get<any>("market", "29076");
    assert.equal(settled.status, "RESOLVED");
    assert.deepEqual(settled.payout, [0, 1]);
    assert.equal(
      settled.resolutionSource,
      "https://api.predict.fun/v1/markets/29076",
    );
  } finally {
    await collector.stop();
    await store.close();
  }
});

test("automatic registration is opt-in and preserves manual workflow defaults", async () => {
  const store = new Store(":memory:"),
    collector = new Collector(store, "test-key");
  (collector as any).request = async (path: string) => {
    if (path.startsWith("/markets?")) return { data: [raw], cursor: null };
    throw Error(`unexpected request ${path}`);
  };
  try {
    await collector.refresh(start + 1000);
    assert.equal(await store.get("market", "29076"), undefined);
    assert.equal(
      (await store.get<any>("automation", "market"))!.enabled,
      false,
    );
  } finally {
    await collector.stop();
    await store.close();
  }
});

test("Predict requests retry throttling and transient server failures", async () => {
  const store = new Store(":memory:"),
    waits: number[] = [];
  let calls = 0;
  const collector = new Collector(
    store,
    "test-key",
    undefined,
    async () => {
      calls++;
      return calls < 3
        ? new Response("temporary", { status: calls === 1 ? 429 : 503 })
        : Response.json({ success: true, data: [] });
    },
    async (ms) => {
      waits.push(ms);
    },
  );
  try {
    assert.deepEqual(await collector.request("/markets"), {
      success: true,
      data: [],
    });
    assert.equal(calls, 3);
    assert.deepEqual(waits, [500, 1000]);
  } finally {
    await collector.stop();
    await store.close();
  }
});
