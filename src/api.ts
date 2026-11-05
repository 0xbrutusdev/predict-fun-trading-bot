import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Store } from "./store.js";
import { slots, blocked } from "./strategies.js";
import { settle, type Account } from "./execution.js";
import { money, type Market } from "./domain.js";
import { observability, type RuntimeStatus } from "./observability.js";
const id = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[\w:-]+$/);
const finite = z.number().finite();
const accountBody = z
  .object({
    name: z.string().min(1).max(80),
    walletAddress: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .optional(),
    initialEquity: finite.min(100).max(1e9),
    fixedShares: finite.min(1).max(10000).default(15),
    paperFeeBps: finite.int().min(0).max(1000).default(200),
  })
  .strict();
const riskBody = z
  .object({
    enabled: z.boolean().optional(),
    maxMarketRisk: finite.min(0.0001).max(0.01).optional(),
    maxTotalRisk: finite.min(0.0001).max(0.05).optional(),
    dailyLossLimit: finite.min(0.0001).max(0.05).optional(),
    fixedShares: finite.min(1).max(10000).optional(),
    depthFraction: finite.min(0.001).max(0.1).optional(),
    expectedRevision: finite.int().nonnegative().optional(),
  })
  .strict();
const marketBody = z
  .object({
    id,
    symbol: z.enum(["BTC", "ETH", "SOL", "DOGE"]),
    duration: z.union([z.literal(300), z.literal(900)]),
    start: finite.int().nonnegative(),
    end: finite.int().positive(),
    upToken: z.string().regex(/^\d+$/),
    downToken: z.string().regex(/^\d+$/),
    yesIsUp: z.boolean(),
    status: z.enum(["OPEN", "CLOSED"]),
    feeBps: finite.int().min(0).max(1000),
    tick: finite.positive().max(0.1),
    rulesHash: z.string().min(1).max(256),
  })
  .strict()
  .refine(
    (x) => x.end - x.start === x.duration * 1000 && x.upToken !== x.downToken,
    "invalid_market_window_or_tokens",
  );
export async function createApp(
  store: Store,
  token: string,
  origin = "http://localhost:5173",
  readToken?: string,
  runtime?: RuntimeStatus,
) {
  if (readToken && (readToken.length < 32 || readToken === token))
    throw Error("API_READ_TOKEN must be distinct and at least 32 characters");
  if (token.length < 32)
    throw Error("API_TOKEN must contain at least 32 characters");
  const app = Fastify({
    genReqId: (req) => {
      const value = req.headers["x-request-id"];
      return typeof value === "string" && /^[a-f0-9-]{36}$/.test(value)
        ? value
        : randomUUID();
    },
    bodyLimit: 262144,
    logger: { redact: ["req.headers.authorization"] },
  });
  await app.register(cors, {
    origin,
    methods: ["GET", "POST", "PUT", "PATCH"],
  });
  const equal = (x: string, y: string) =>
    Buffer.byteLength(x) === Buffer.byteLength(y) &&
    timingSafeEqual(Buffer.from(x), Buffer.from(y));
  const credential = (authorization?: string) =>
    (authorization || "").replace(/^Bearer /, "");
  const knownCredential = (authorization?: string) => {
    const value = credential(authorization);
    return equal(value, token) || Boolean(readToken && equal(value, readToken));
  };
  await app.register(rateLimit, {
    max: (req) => (knownCredential(req.headers.authorization) ? 3000 : 120),
    timeWindow: "1 minute",
    keyGenerator: (req) => {
      const value = credential(req.headers.authorization);
      return knownCredential(req.headers.authorization)
        ? createHash("sha256").update(value).digest("hex")
        : req.ip;
    },
  });
  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health" || req.method === "OPTIONS") return;
    const value = credential(req.headers.authorization);
    const admin = equal(value, token),
      read = readToken && equal(value, readToken);
    if (!admin && !read)
      return reply.code(401).send({ error: { code: "unauthorized" } });
    if (!admin && req.method !== "GET")
      return reply.code(403).send({ error: { code: "read_only" } });
  });
  app.setErrorHandler((err, req, reply) => {
    const e = err as any;
    if (e instanceof z.ZodError)
      return reply
        .code(400)
        .send({ error: { code: "validation_error", details: e.issues } });
    if (e.statusCode)
      return reply.code(e.statusCode).send({ error: { code: e.message } });
    req.log.error(err);
    return reply.code(500).send({ error: { code: "internal_error" } });
  });
  const fail = (code: string, statusCode = 404) => {
    throw Object.assign(Error(code), { statusCode });
  };
  const account = async (req: any) =>
    (await store.get<Account>("account", id.parse(req.params.id))) ??
    fail("account_not_found");
  const page = (req: any) =>
    z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
        after: z.coerce.number().int().nonnegative().default(0),
      })
      .parse(req.query);
  const spec: any = {
    openapi: "3.1.0",
    info: {
      title: "Predict bot API",
      version: "1.0.0",
      description:
        "Single-owner paper trading control API. Financial amounts are USDT; timestamps are UTC epoch milliseconds. No private keys accepted. Bearer tokens are server-side secrets; use a frontend BFF.",
    },
    servers: [{ url: "/" }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    },
    paths: {},
  };
  const route = (
    method: "GET" | "POST" | "PATCH" | "PUT",
    url: string,
    summary: string,
    handler: any,
    body?: z.ZodType,
  ) => {
    const path = url.replace(/:([a-zA-Z]+)/g, "{$1}");
    const params = [...url.matchAll(/:([a-zA-Z]+)/g)].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    spec.paths[path] ??= {};
    spec.paths[path][method.toLowerCase()] = {
      summary,
      parameters: params,
      ...(body
        ? {
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: z.toJSONSchema(body, {
                    target: "draft-2020-12",
                    unrepresentable: "any",
                  }),
                },
              },
            },
          }
        : {}),
      responses: {
        200: {
          description: "Success; data envelope",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { data: {}, meta: { type: "object" } },
              },
            },
          },
        },
        400: { description: "Invalid input" },
        401: { description: "Authentication required" },
        403: { description: "Read-only credential" },
        404: { description: "Resource not found" },
        409: { description: "State conflict" },
        429: { description: "Rate limit" },
      },
    };
    app.route({
      method,
      url,
      handler: async (req, reply) => {
        if (body) (req as any).body = body.parse(req.body);
        return handler(req, reply);
      },
    });
  };
  app.get("/health", () => ({ status: "ok" }));
  route(
    "GET",
    "/v1/observability",
    "Worker readiness, freshness and recent operational events",
    async () => ({ data: await observability(store, runtime) }),
  );
  route("GET", "/v1/openapi.json", "OpenAPI contract", () => spec);
  route("GET", "/v1/status", "Bot capabilities and release gates", () => ({
    data: {
      mode: "paper",
      liveEnabled: false,
      liveBlockers: [
        "venue_immediate_order_semantics_unverified",
        "fee_contract_unverified",
        "out_of_sample_validation_required",
      ],
      storage: "mongodb",
      time: Date.now(),
    },
  }));
  route(
    "GET",
    "/v1/strategies",
    "Strategy slots, thresholds and source blockers",
    () => ({
      data: slots.map((s) => ({
        ...s,
        blockedReason: blocked[s.strategy] ?? null,
        confidenceIsProbability: false,
      })),
    }),
  );
  route(
    "POST",
    "/v1/accounts",
    "Create isolated paper account",
    async (req: any) => {
      const b = accountBody.parse(req.body);
      const a: Account = {
        ...b,
        id: randomUUID(),
        mode: "paper",
        enabled: false,
        cash: b.initialEquity,
        maxMarketRisk: 0.0025,
        maxTotalRisk: 0.01,
        dailyLossLimit: 0.01,
        depthFraction: 0.1,
        createdAt: Date.now(),
        revision: 1,
      };
      await store.transaction(async () => {
        await store.put("account", a.id, a);
        await store.put("config", a.id, {
          enabledSlots: slots
            .filter((slot) => !blocked[slot.strategy])
            .map((slot) => slot.id),
          revision: 1,
        });
        await store.event("account.created", { accountId: a.id });
      });
      return { data: a };
    },
    accountBody,
  );
  route("GET", "/v1/accounts", "List accounts", async () => ({
    data: await store.list<Account>("account"),
  }));
  route(
    "GET",
    "/v1/accounts/:id",
    "Account settings and available paper cash",
    async (req: any) => ({ data: await account(req) }),
  );
  route(
    "PATCH",
    "/v1/accounts/:id",
    "Configure paper engine and risk limits",
    async (req: any) => {
      const a = await account(req),
        { expectedRevision, ...changes } = riskBody.parse(req.body),
        revision = a.revision ?? 0;
      if (expectedRevision !== undefined && expectedRevision !== revision)
        fail("revision_conflict", 409);
      if (
        changes.enabled === true &&
        (await store.hasUnknownSettlementTime(a.id))
      )
        fail("historical_settlement_time_unknown", 409);
      const next = { ...a, ...changes, revision: revision + 1 };
      if (next.maxMarketRisk > next.maxTotalRisk)
        fail("market_risk_exceeds_total", 400);
      await store.transaction(async () => {
        await store.put("account", a.id, next);
        await store.event("account.updated", {
          accountId: a.id,
          revision: next.revision,
          changes,
        });
      });
      return { data: next };
    },
    riskBody,
  );
  const selection = z
    .object({
      enabledSlots: z.array(z.string()).max(20),
      expectedRevision: finite.int().nonnegative().optional(),
    })
    .strict();
  type StrategyConfig = { enabledSlots: string[]; revision: number };
  const strategyConfig = async (accountId: string): Promise<StrategyConfig> => {
    const current = await store.get<StrategyConfig>("config", accountId);
    if (current) return { ...current, revision: current.revision ?? 0 };
    const materialized = {
      enabledSlots: slots
        .filter((slot) => !blocked[slot.strategy])
        .map((slot) => slot.id),
      revision: 1,
    };
    await store.put("config", accountId, materialized);
    return materialized;
  };
  route(
    "PUT",
    "/v1/accounts/:id/strategies",
    "Select enabled strategy slots",
    async (req: any) => {
      const a = await account(req),
        b = selection.parse(req.body),
        current = await strategyConfig(a.id);
      if (
        b.expectedRevision !== undefined &&
        b.expectedRevision !== current.revision
      )
        fail("revision_conflict", 409);
      if (b.enabledSlots.some((s) => !slots.some((x) => x.id === s)))
        fail("unknown_slot", 400);
      if (
        b.enabledSlots.some(
          (s) => blocked[slots.find((x) => x.id === s)!.strategy],
        )
      )
        fail("source_feature_undefined", 409);
      if (new Set(b.enabledSlots).size !== b.enabledSlots.length)
        fail("duplicate_slot", 400);
      const next = {
        enabledSlots: b.enabledSlots,
        revision: current.revision + 1,
      };
      await store.put("config", a.id, next);
      await store.event("strategy.updated", { accountId: a.id, ...next });
      return { data: next };
    },
    selection,
  );
  route(
    "GET",
    "/v1/accounts/:id/strategies",
    "Read account slot selection",
    async (req: any) => {
      const a = await account(req);
      return {
        data: await strategyConfig(a.id),
      };
    },
  );
  route(
    "GET",
    "/v1/accounts/:id/features",
    "Latest causal features and qualifying signals",
    async (req: any) => {
      const a = await account(req);
      return {
        data: (await store.list<any>("features"))
          .filter((x) => x.accountId === a.id)
          .sort((x, y) => Number(y.time ?? 0) - Number(x.time ?? 0))
          .slice(0, 50),
      };
    },
  );
  route(
    "GET",
    "/v1/accounts/:id/positions",
    "Open positions and committed capital",
    async (req: any) => {
      const a = await account(req);
      const rows = await store.positions(a.id);
      return {
        data: rows.map((x) => ({
          ...x,
          cost: money(x.cost),
          fees: money(x.fees),
        })),
      };
    },
  );
  route(
    "GET",
    "/v1/accounts/:id/fills",
    "Paginated execution and settlement ledger",
    async (req: any) => {
      const a = await account(req),
        p = page(req);
      const rows = await store.fillsPage(a.id, p.after, p.limit);
      return {
        data: rows.map((x) => ({
          ...x,
          cost: money(x.cost),
          fee: money(x.fee),
          payout: x.payout === null ? null : money(x.payout),
          pnl: x.pnl === null ? null : money(x.pnl),
        })),
        meta: { nextCursor: rows.at(-1)?.cursor ?? p.after },
      };
    },
  );
  route(
    "GET",
    "/v1/accounts/:id/pnl",
    "Realized PnL and conservative open-risk valuation",
    async (req: any) => {
      const a = await account(req),
        r = await store.pnlSummary(a.id);
      return {
        data: {
          realizedPnl: money(r.pnl),
          fees: money(r.fees),
          cash: a.cash,
          committed: money(r.committed),
          conservativeEquity: a.cash,
          initialEquity: a.initialEquity,
          unrealizedPnl: null,
          unrealizedReason: "no_executable_liquidation_valuation",
          fills: r.fills,
          currency: "USDT",
        },
      };
    },
  );
  route(
    "GET",
    "/v1/markets",
    "Registered markets and book freshness",
    async () => {
      const data = [];
      for (const market of await store.list<Market>("market")) {
        const book = (await store.get<any[]>("books", market.id))?.at(-1);
        data.push({
          ...market,
          bookAgeMs: book ? Date.now() - book.receivedAt : null,
        });
      }
      return { data };
    },
  );
  route(
    "GET",
    "/v1/markets/discovery",
    "Unapproved venue market metadata",
    async () => ({ data: (await store.get("discovery", "latest")) ?? null }),
  );
  route(
    "GET",
    "/v1/markets/automation",
    "Automatic Predict market registration and settlement status",
    async () => ({
      data: (await store.get("automation", "market")) ?? {
        enabled: false,
        symbols: [],
        durations: [],
        providers: [],
        lastRefreshAt: null,
        discovered: 0,
        eligible: 0,
        registered: 0,
        rejected: 0,
      },
    }),
  );
  route(
    "POST",
    "/v1/markets",
    "Register verified paper market metadata",
    async (req: any) => {
      const m = marketBody.parse(req.body);
      if (await store.get("market", m.id))
        fail("market_already_registered", 409);
      await store.put("market", m.id, m);
      await store.event("market.registered", m);
      return { data: m };
    },
    marketBody,
  );
  route(
    "GET",
    "/v1/markets/:id/book",
    "Latest normalized YES-oriented order book",
    async (req: any) => ({
      data:
        (await store.get<any[]>("books", id.parse(req.params.id)))?.at(-1) ??
        null,
    }),
  );
  const resolution = z
    .object({
      payout: z.tuple([finite.min(0).max(1), finite.min(0).max(1)]),
      source: z.string().url(),
    })
    .strict();
  route(
    "POST",
    "/v1/markets/:id/resolution",
    "Record authoritative paper settlement",
    async (req: any) => {
      const m =
          (await store.get<Market>("market", id.parse(req.params.id))) ??
          fail("market_not_found"),
        b = resolution.parse(req.body);
      if (Date.now() < m.end || Math.abs(b.payout[0] + b.payout[1] - 1) > 1e-9)
        fail("invalid_resolution", 400);
      if (m.payout && JSON.stringify(m.payout) !== JSON.stringify(b.payout))
        fail("resolution_conflict", 409);
      await settle(store, { ...m, status: "RESOLVED", payout: b.payout });
      await store.event("resolution.evidence", {
        marketId: m.id,
        source: b.source,
      });
      return { data: { ...m, status: "RESOLVED", payout: b.payout } };
    },
    resolution,
  );
  route("GET", "/v1/events", "Cursor-based event polling", async (req: any) => {
    const p = page(req),
      rows = await store.eventsPage(p.after, p.limit);
    return {
      data: rows,
      meta: { nextCursor: rows.at(-1)?.seq ?? p.after },
    };
  });
  route(
    "POST",
    "/v1/kill-switch",
    "Pause all accounts without changing holdings",
    async () => {
      await store.transaction(async () => {
        for (const a of await store.list<Account>("account"))
          await store.put("account", a.id, { ...a, enabled: false });
        await store.event("risk.kill_switch", {});
      });
      return { data: { paused: true } };
    },
    z.object({}).strict(),
  );
  const accountSchema = accountBody.extend({
    id: z.string(),
    mode: z.literal("paper"),
    enabled: z.boolean(),
    cash: finite,
    maxMarketRisk: finite,
    maxTotalRisk: finite,
    dailyLossLimit: finite,
    depthFraction: finite,
    createdAt: finite,
    revision: finite.int().nonnegative().optional(),
  });
  const slotSchema = z.object({
    id: z.string(),
    key: z.string(),
    symbol: z.string(),
    duration: finite,
    strategy: z.string(),
    threshold: finite,
    blockedReason: z.string().nullable(),
    confidenceIsProbability: z.literal(false),
  });
  const pnlSchema = z.object({
    realizedPnl: finite,
    fees: finite,
    cash: finite,
    committed: finite,
    conservativeEquity: finite,
    initialEquity: finite,
    unrealizedPnl: z.null(),
    unrealizedReason: z.string(),
    fills: finite,
    currency: z.literal("USDT"),
  });
  const fillSchema = z.object({
    cursor: finite,
    id: z.string(),
    account: z.string(),
    market: z.string(),
    direction: z.enum(["up", "down"]),
    quantity: finite,
    cost: finite,
    fee: finite,
    payout: finite.nullable(),
    pnl: finite.nullable(),
    time: finite,
    settled_at: finite.nullable(),
  });
  const responseModels: Record<string, z.ZodType> = {
    "get /v1/accounts": z.array(accountSchema),
    "post /v1/accounts": accountSchema,
    "get /v1/accounts/{id}": accountSchema,
    "patch /v1/accounts/{id}": accountSchema,
    "get /v1/strategies": z.array(slotSchema),
    "get /v1/accounts/{id}/pnl": pnlSchema,
    "get /v1/accounts/{id}/fills": z.array(fillSchema),
    "get /v1/accounts/{id}/strategies": z.object({
      enabledSlots: z.array(z.string()),
      revision: finite.int().nonnegative(),
    }),
    "put /v1/accounts/{id}/strategies": z.object({
      enabledSlots: z.array(z.string()),
      revision: finite.int().nonnegative(),
    }),
    "get /v1/accounts/{id}/positions": z.array(
      z.object({
        market: z.string(),
        direction: z.enum(["up", "down"]),
        quantity: finite,
        cost: finite,
        fees: finite,
      }),
    ),
    "get /v1/events": z.array(
      z.object({
        seq: finite,
        time: finite,
        type: z.string(),
        data: z.unknown(),
      }),
    ),
    "get /v1/markets/{id}/book": z
      .object({
        marketId: z.string(),
        receivedAt: finite,
        updatedAt: finite,
        asks: z.array(z.tuple([finite, finite])),
        bids: z.array(z.tuple([finite, finite])),
      })
      .nullable(),
  };
  for (const [key, model] of Object.entries(responseModels)) {
    const [method, path] = key.split(" ");
    spec.paths[path][method].responses[200].content["application/json"].schema =
      z.toJSONSchema(
        z.object({
          data: model,
          meta: z.object({ nextCursor: finite }).optional(),
        }),
        { target: "draft-2020-12" },
      );
  }
  for (const path of ["/v1/events", "/v1/accounts/{id}/fills"])
    spec.paths[path].get.parameters.push(
      {
        name: "after",
        in: "query",
        schema: { type: "integer", minimum: 0, default: 0 },
      },
      {
        name: "limit",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
    );
  return app;
}
