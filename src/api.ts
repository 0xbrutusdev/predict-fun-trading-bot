import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { Store } from "./store.js";
import { slots, blocked } from "./strategies.js";
import { settle, type Account } from "./execution.js";
import { money, type Market } from "./domain.js";
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
) {
  if (token.length < 32)
    throw Error("API_TOKEN must contain at least 32 characters");
  const app = Fastify({
    bodyLimit: 262144,
    logger: { redact: ["req.headers.authorization"] },
  });
  await app.register(cors, {
    origin,
    methods: ["GET", "POST", "PUT", "PATCH"],
  });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  const equal = (x: string, y: string) =>
    Buffer.byteLength(x) === Buffer.byteLength(y) &&
    timingSafeEqual(Buffer.from(x), Buffer.from(y));
  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health" || req.method === "OPTIONS") return;
    const value = (req.headers.authorization || "").replace(/^Bearer /, "");
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
  const account = (req: any) =>
    store.get<Account>("account", id.parse(req.params.id)) ??
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
      storage: "sqlite-single-writer",
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
      };
      store.transaction(() => {
        store.put("account", a.id, a);
        store.event("account.created", { accountId: a.id });
      });
      return { data: a };
    },
    accountBody,
  );
  route("GET", "/v1/accounts", "List accounts", () => ({
    data: store.list<Account>("account"),
  }));
  route(
    "GET",
    "/v1/accounts/:id",
    "Account settings and available paper cash",
    (req: any) => ({ data: account(req) }),
  );
  route(
    "PATCH",
    "/v1/accounts/:id",
    "Configure paper engine and risk limits",
    (req: any) => {
      const a = account(req),
        next = { ...a, ...riskBody.parse(req.body) };
      if (next.maxMarketRisk > next.maxTotalRisk)
        fail("market_risk_exceeds_total", 400);
      store.transaction(() => {
        store.put("account", a.id, next);
        store.event("account.updated", { accountId: a.id, changes: req.body });
      });
      return { data: next };
    },
    riskBody,
  );
  const selection = z
    .object({ enabledSlots: z.array(z.string()).max(20) })
    .strict();
  route(
    "PUT",
    "/v1/accounts/:id/strategies",
    "Select enabled strategy slots",
    (req: any) => {
      const a = account(req),
        b = selection.parse(req.body);
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
      store.put("config", a.id, b);
      store.event("strategy.updated", { accountId: a.id, ...b });
      return { data: b };
    },
    selection,
  );
  route(
    "GET",
    "/v1/accounts/:id/strategies",
    "Read account slot selection",
    (req: any) => {
      const a = account(req);
      return {
        data: store.get("config", a.id) ?? {
          enabledSlots: slots
            .filter((s) => !blocked[s.strategy])
            .map((s) => s.id),
        },
      };
    },
  );
  route(
    "GET",
    "/v1/accounts/:id/features",
    "Latest causal features and qualifying signals",
    (req: any) => {
      const a = account(req);
      return {
        data: store
          .list<any>("features")
          .filter((x) => x.accountId === a.id)
          .slice(-50),
      };
    },
  );
  route(
    "GET",
    "/v1/accounts/:id/positions",
    "Open positions and committed capital",
    (req: any) => {
      const a = account(req);
      const rows = store.db
        .prepare(
          "SELECT market,direction,SUM(quantity) quantity,SUM(cost) cost,SUM(fee) fees FROM fills WHERE account=? AND payout IS NULL GROUP BY market,direction",
        )
        .all(a.id) as any[];
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
    (req: any) => {
      const a = account(req),
        p = page(req);
      const rows = store.db
        .prepare(
          "SELECT rowid cursor,* FROM fills WHERE account=? AND rowid>? ORDER BY rowid LIMIT ?",
        )
        .all(a.id, p.after, p.limit) as any[];
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
    (req: any) => {
      const a = account(req),
        r = store.db
          .prepare(
            "SELECT COALESCE(SUM(pnl),0) pnl,COALESCE(SUM(fee),0) fees,COALESCE(SUM(CASE WHEN payout IS NULL THEN cost+fee ELSE 0 END),0) committed,COUNT(*) fills FROM fills WHERE account=?",
          )
          .get(a.id) as any;
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
  route("GET", "/v1/markets", "Registered markets and book freshness", () => ({
    data: store.list<Market>("market").map((m) => {
      const b = store.get<any[]>("books", m.id)?.at(-1);
      return { ...m, bookAgeMs: b ? Date.now() - b.receivedAt : null };
    }),
  }));
  route(
    "GET",
    "/v1/markets/discovery",
    "Unapproved venue market metadata",
    () => ({ data: store.get("discovery", "latest") ?? null }),
  );
  route(
    "POST",
    "/v1/markets",
    "Register verified paper market metadata",
    (req: any) => {
      const m = marketBody.parse(req.body);
      if (store.get("market", m.id)) fail("market_already_registered", 409);
      store.put("market", m.id, m);
      store.event("market.registered", m);
      return { data: m };
    },
    marketBody,
  );
  route(
    "GET",
    "/v1/markets/:id/book",
    "Latest normalized YES-oriented order book",
    (req: any) => ({
      data: store.get<any[]>("books", id.parse(req.params.id))?.at(-1) ?? null,
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
    (req: any) => {
      const m =
          store.get<Market>("market", id.parse(req.params.id)) ??
          fail("market_not_found"),
        b = resolution.parse(req.body);
      if (Date.now() < m.end || Math.abs(b.payout[0] + b.payout[1] - 1) > 1e-9)
        fail("invalid_resolution", 400);
      if (m.payout && JSON.stringify(m.payout) !== JSON.stringify(b.payout))
        fail("resolution_conflict", 409);
      settle(store, { ...m, status: "RESOLVED", payout: b.payout });
      store.event("resolution.evidence", { marketId: m.id, source: b.source });
      return { data: { ...m, status: "RESOLVED", payout: b.payout } };
    },
    resolution,
  );
  route("GET", "/v1/events", "Cursor-based event polling", (req: any) => {
    const p = page(req),
      rows = store.db
        .prepare("SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?")
        .all(p.after, p.limit) as any[];
    return {
      data: rows.map((x) => ({
        seq: x.seq,
        time: x.time,
        type: x.type,
        data: JSON.parse(x.json),
      })),
      meta: { nextCursor: rows.at(-1)?.seq ?? p.after },
    };
  });
  route(
    "POST",
    "/v1/kill-switch",
    "Pause all accounts without changing holdings",
    () => {
      store.transaction(() => {
        for (const a of store.list<Account>("account"))
          store.put("account", a.id, { ...a, enabled: false });
        store.event("risk.kill_switch", {});
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
  });
  const slotSchema = z.object({
    id: z.string(),
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
    "get /v1/accounts/{id}/strategies": selection,
    "put /v1/accounts/{id}/strategies": selection,
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
