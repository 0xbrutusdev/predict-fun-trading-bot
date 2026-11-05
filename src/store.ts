import { AsyncLocalStorage } from "node:async_hooks";
import {
  MongoClient,
  ServerApiVersion,
  type ClientSession,
  type Collection,
  type Db,
  type Document,
} from "mongodb";
import type { Candle } from "./domain.js";

export type FillRow = {
  id: string;
  cursor: number;
  account: string;
  market: string;
  direction: string;
  quantity: number;
  cost: number;
  fee: number;
  payout: number | null;
  pnl: number | null;
  settled_at: number | null;
  time: number;
};
export type EventRow = {
  seq: number;
  time: number;
  type: string;
  data: unknown;
};
type CandleObservation = {
  symbol: string;
  duration: number;
  barTime: number;
  observedAt: number;
  value: Candle;
};
type MemoryState = {
  documents: Map<string, { kind: string; id: string; value: unknown }>;
  events: EventRow[];
  fills: FillRow[];
  candles: Map<string, CandleObservation>;
  leases: Map<string, { owner: string; expiresAt: number }>;
  counters: Map<string, number>;
};

const copy = <T>(value: T): T =>
  value === undefined ? value : structuredClone(value);
const documentKey = (kind: string, id: string) => `${kind}\u0000${id}`;
const candleKey = (
  symbol: string,
  duration: number,
  barTime: number,
  observedAt: number,
) => `${symbol}\u0000${duration}\u0000${barTime}\u0000${observedAt}`;

export class Store {
  private client?: MongoClient;
  private database?: Db;
  private sessions = new AsyncLocalStorage<ClientSession>();
  private memory?: MemoryState;

  constructor(target: ":memory:") {
    if (target !== ":memory:")
      throw Error("Use Store.connect() for MongoDB persistence");
    this.memory = {
      documents: new Map(),
      events: [],
      fills: [],
      candles: new Map(),
      leases: new Map(),
      counters: new Map(),
    };
  }

  private static empty() {
    return Object.create(Store.prototype) as Store;
  }

  static async connect(uri: string, databaseName: string) {
    if (!/^mongodb(?:\+srv)?:\/\//.test(uri))
      throw Error("invalid_mongodb_uri");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(databaseName))
      throw Error("invalid_mongodb_database_name");
    const store = Store.empty();
    store.sessions = new AsyncLocalStorage<ClientSession>();
    store.client = new MongoClient(uri, {
      appName: "predict-fun-trading-bot",
      serverApi: { version: ServerApiVersion.v1, strict: true },
      retryReads: true,
      retryWrites: true,
      maxPoolSize: 20,
    });
    await store.client.connect();
    store.database = store.client.db(databaseName);
    await store.initializeSchema();
    await store.database.command({ ping: 1 });
    return store;
  }

  private collection<T extends Document>(name: string): Collection<T> {
    if (!this.database) throw Error("mongodb_not_connected");
    return this.database.collection<T>(name);
  }

  private session() {
    return this.sessions.getStore();
  }

  private async initializeSchema() {
    const db = this.database!;
    const required = [
      "documents",
      "events",
      "fills",
      "candle_observations",
      "leases",
      "counters",
    ];
    const existing = new Set(
      (await db.listCollections({}, { nameOnly: true }).toArray()).map(
        (item) => item.name,
      ),
    );
    for (const name of required)
      if (!existing.has(name)) await db.createCollection(name);
    await Promise.all([
      db
        .collection("documents")
        .createIndex({ kind: 1, id: 1 }, { unique: true }),
      db.collection("events").createIndex({ seq: 1 }, { unique: true }),
      db.collection("events").createIndex({ type: 1, time: -1 }),
      db.collection("fills").createIndex({ id: 1 }, { unique: true }),
      db.collection("fills").createIndex({ cursor: 1 }, { unique: true }),
      db.collection("fills").createIndex({ account: 1, time: 1 }),
      db.collection("fills").createIndex({ market: 1, payout: 1 }),
      db
        .collection("candle_observations")
        .createIndex(
          { symbol: 1, duration: 1, barTime: 1, observedAt: 1 },
          { unique: true },
        ),
      db.collection("leases").createIndex({ expiresAt: 1 }),
    ]);
  }

  private async nextCounter(name: string) {
    if (this.memory) {
      const value = (this.memory.counters.get(name) ?? 0) + 1;
      this.memory.counters.set(name, value);
      return value;
    }
    const row = await this.collection<{ _id: string; value: number }>(
      "counters",
    ).findOneAndUpdate(
      { _id: name },
      { $inc: { value: 1 } },
      { upsert: true, returnDocument: "after", session: this.session() },
    );
    return row!.value;
  }

  async get<T>(kind: string, id: string): Promise<T | undefined> {
    if (this.memory)
      return copy(
        this.memory.documents.get(documentKey(kind, id))?.value as
          T | undefined,
      );
    const row = await this.collection<{ kind: string; id: string; value: T }>(
      "documents",
    ).findOne({ kind, id }, { session: this.session() });
    return row ? copy(row.value) : undefined;
  }

  async put(kind: string, id: string, value: unknown) {
    if (this.memory) {
      this.memory.documents.set(documentKey(kind, id), {
        kind,
        id,
        value: copy(value),
      });
      return;
    }
    await this.collection("documents").replaceOne(
      { kind, id },
      { kind, id, value: copy(value) },
      { upsert: true, session: this.session() },
    );
  }

  async delete(kind: string, id: string) {
    if (this.memory) {
      this.memory.documents.delete(documentKey(kind, id));
      return;
    }
    await this.collection("documents").deleteOne(
      { kind, id },
      { session: this.session() },
    );
  }

  async schemaStatus() {
    if (this.memory)
      return {
        database: ":memory:",
        collections: [
          "documents",
          "events",
          "fills",
          "candle_observations",
          "leases",
          "counters",
        ],
      };
    const collections = await this.database!.listCollections(
      {},
      { nameOnly: true },
    ).toArray();
    const indexes: Record<string, string[]> = {};
    for (const collection of collections)
      indexes[collection.name] = (
        await this.database!.collection(collection.name).indexes()
      ).map((index) => index.name ?? "unnamed");
    return {
      database: this.database!.databaseName,
      collections: collections.map((item) => item.name).sort(),
      indexes,
    };
  }

  async list<T>(kind: string): Promise<T[]> {
    return (await this.listEntries<T>(kind)).map((item) => item.value);
  }

  async listEntries<T>(kind: string) {
    if (this.memory)
      return [...this.memory.documents.values()]
        .filter((item) => item.kind === kind)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((item) => ({ id: item.id, value: copy(item.value as T) }));
    return (
      await this.collection<{ kind: string; id: string; value: T }>("documents")
        .find({ kind }, { session: this.session() })
        .sort({ id: 1 })
        .toArray()
    ).map((item) => ({ id: item.id, value: copy(item.value) }));
  }

  async event(type: string, data: unknown, time = Date.now()) {
    const seq = await this.nextCounter("events");
    if (this.memory)
      this.memory.events.push({ seq, time, type, data: copy(data) });
    else
      await this.collection("events").insertOne(
        { seq, time, type, data: copy(data) },
        { session: this.session() },
      );
    return seq;
  }

  async transaction<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.memory) {
      const snapshot = copy({
        documents: [...this.memory.documents],
        events: this.memory.events,
        fills: this.memory.fills,
        candles: [...this.memory.candles],
        leases: [...this.memory.leases],
        counters: [...this.memory.counters],
      });
      try {
        return await fn();
      } catch (error) {
        this.memory.documents = new Map(snapshot.documents);
        this.memory.events = snapshot.events;
        this.memory.fills = snapshot.fills;
        this.memory.candles = new Map(snapshot.candles);
        this.memory.leases = new Map(snapshot.leases);
        this.memory.counters = new Map(snapshot.counters);
        throw error;
      }
    }
    const session = this.client!.startSession();
    try {
      return await session.withTransaction(
        () => this.sessions.run(session, async () => await fn()),
        {
          readConcern: { level: "majority" },
          writeConcern: { w: "majority" },
        },
      );
    } finally {
      await session.endSession();
    }
  }

  async hasUnknownSettlementTime(accountId: string) {
    if (this.memory)
      return this.memory.fills.some(
        (fill) =>
          fill.account === accountId &&
          fill.payout !== null &&
          fill.settled_at === null,
      );
    return Boolean(
      await this.collection<FillRow>("fills").findOne(
        { account: accountId, payout: { $ne: null }, settled_at: null },
        { projection: { _id: 1 }, session: this.session() },
      ),
    );
  }

  async acquireLease(name: string, owner: string, now: number, ttlMs: number) {
    if (
      !name ||
      !owner ||
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1000
    )
      throw Error("invalid_lease");
    if (this.memory) {
      const current = this.memory.leases.get(name);
      if (current && current.owner !== owner && current.expiresAt > now)
        return false;
      this.memory.leases.set(name, { owner, expiresAt: now + ttlMs });
      return true;
    }
    try {
      const result = await this.collection<{
        _id: string;
        owner: string;
        expiresAt: number;
      }>("leases").findOneAndUpdate(
        { _id: name, $or: [{ owner }, { expiresAt: { $lte: now } }] },
        { $set: { owner, expiresAt: now + ttlMs } },
        { upsert: true, returnDocument: "after" },
      );
      return result?.owner === owner;
    } catch (error: any) {
      if (error?.code === 11000) return false;
      throw error;
    }
  }

  async releaseLease(name: string, owner: string) {
    if (this.memory) {
      if (this.memory.leases.get(name)?.owner === owner)
        this.memory.leases.delete(name);
      return;
    }
    await this.collection<{ _id: string; owner: string; expiresAt: number }>(
      "leases",
    ).deleteOne({ _id: name, owner });
  }

  private async findFills(filter: Record<string, any>): Promise<FillRow[]> {
    if (this.memory)
      return this.memory.fills.filter((fill) =>
        Object.entries(filter).every(([key, expected]) => {
          const actual = (fill as any)[key];
          if (expected && typeof expected === "object") {
            if ("$ne" in expected && actual === expected.$ne) return false;
            if ("$gte" in expected && actual < expected.$gte) return false;
            if ("$lte" in expected && actual > expected.$lte) return false;
            return true;
          }
          return actual === expected;
        }),
      );
    return this.collection<FillRow>("fills")
      .find(filter, { session: this.session() })
      .sort({ cursor: 1 })
      .toArray();
  }

  async sumFilledQuantity(account: string, market: string, direction: string) {
    return (await this.findFills({ account, market, direction })).reduce(
      (sum, row) => sum + row.quantity,
      0,
    );
  }
  async listUnresolvedFills(account: string) {
    return this.findFills({ account, payout: null });
  }
  async sumSettledPnl(account: string, start: number, end: number) {
    return (
      await this.findFills({
        account,
        payout: { $ne: null },
        settled_at: { $gte: start, $lte: end },
      })
    ).reduce((sum, row) => sum + (row.pnl ?? 0), 0);
  }
  async insertFill(
    fill: Omit<FillRow, "cursor" | "payout" | "pnl" | "settled_at">,
  ) {
    const row: FillRow = {
      ...fill,
      cursor: await this.nextCounter("fills"),
      payout: null,
      pnl: null,
      settled_at: null,
    };
    if (this.memory) this.memory.fills.push(copy(row));
    else
      await this.collection("fills").insertOne(row, {
        session: this.session(),
      });
    return copy(row);
  }
  async unsettledMarketFills(market: string) {
    return this.findFills({ market, payout: null });
  }
  async settleFill(id: string, payout: number, pnl: number, settledAt: number) {
    if (this.memory) {
      const row = this.memory.fills.find((fill) => fill.id === id);
      if (row) Object.assign(row, { payout, pnl, settled_at: settledAt });
    } else
      await this.collection("fills").updateOne(
        { id, payout: null },
        { $set: { payout, pnl, settled_at: settledAt } },
        { session: this.session() },
      );
  }
  async positions(account: string) {
    const groups = new Map<string, any>();
    for (const row of await this.findFills({ account, payout: null })) {
      const key = `${row.market}\u0000${row.direction}`,
        group = groups.get(key) ?? {
          market: row.market,
          direction: row.direction,
          quantity: 0,
          cost: 0,
          fees: 0,
        };
      group.quantity += row.quantity;
      group.cost += row.cost;
      group.fees += row.fee;
      groups.set(key, group);
    }
    return [...groups.values()];
  }
  async fillsPage(account: string, after: number, limit: number) {
    if (this.memory)
      return this.memory.fills
        .filter((fill) => fill.account === account && fill.cursor > after)
        .sort((a, b) => a.cursor - b.cursor)
        .slice(0, limit)
        .map(copy);
    return this.collection<FillRow>("fills")
      .find({ account, cursor: { $gt: after } }, { session: this.session() })
      .sort({ cursor: 1 })
      .limit(limit)
      .toArray();
  }
  async pnlSummary(account: string) {
    return (await this.findFills({ account })).reduce(
      (summary, row) => {
        summary.pnl += row.pnl ?? 0;
        summary.fees += row.fee;
        if (row.payout === null) summary.committed += row.cost + row.fee;
        summary.fills++;
        return summary;
      },
      { pnl: 0, fees: 0, committed: 0, fills: 0 },
    );
  }
  async eventsPage(after: number, limit: number) {
    if (this.memory)
      return this.memory.events
        .filter((event) => event.seq > after)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit)
        .map(copy);
    return this.collection<EventRow>("events")
      .find({ seq: { $gt: after } })
      .sort({ seq: 1 })
      .limit(limit)
      .toArray();
  }
  async recentEvents(excludedTypes: string[], limit: number) {
    if (this.memory)
      return this.memory.events
        .filter((event) => !excludedTypes.includes(event.type))
        .sort((a, b) => b.seq - a.seq)
        .slice(0, limit)
        .map(copy);
    return this.collection<EventRow>("events")
      .find({ type: { $nin: excludedTypes } })
      .sort({ seq: -1 })
      .limit(limit)
      .toArray();
  }
  async latestEventTime(type: string) {
    if (this.memory)
      return this.memory.events
        .filter((event) => event.type === type)
        .sort((a, b) => b.seq - a.seq)[0]?.time;
    return (
      await this.collection<EventRow>("events").findOne(
        { type },
        { sort: { seq: -1 }, projection: { time: 1 } },
      )
    )?.time;
  }
  async allFills() {
    return this.findFills({});
  }
  async deleteFill(id: string) {
    if (this.memory) {
      this.memory.fills = this.memory.fills.filter((fill) => fill.id !== id);
      return;
    }
    await this.collection("fills").deleteOne({ id });
  }
  async deleteEventsByCheckId(id: string) {
    if (this.memory) {
      this.memory.events = this.memory.events.filter(
        (event) => (event.data as any)?.id !== id,
      );
      return;
    }
    await this.collection("events").deleteMany({ "data.id": id });
  }

  async archiveCandle(
    symbol: string,
    duration: number,
    row: Candle,
    observedAt: number,
  ) {
    if (this.memory) {
      const key = candleKey(symbol, duration, row.time, observedAt);
      if (!this.memory.candles.has(key))
        this.memory.candles.set(key, {
          symbol,
          duration,
          barTime: row.time,
          observedAt,
          value: copy(row),
        });
    } else
      await this.collection("candle_observations").updateOne(
        { symbol, duration, barTime: row.time, observedAt },
        { $setOnInsert: { value: copy(row) } },
        { upsert: true, session: this.session() },
      );
  }
  async candleHistory(
    symbol: string,
    duration: number,
    start: number,
    end: number,
    availableAt: number,
  ) {
    const rows: CandleObservation[] = this.memory
      ? [...this.memory.candles.values()].filter(
          (row) =>
            row.symbol === symbol &&
            row.duration === duration &&
            row.barTime >= start &&
            row.barTime < end &&
            row.observedAt <= availableAt,
        )
      : await this.collection<CandleObservation>("candle_observations")
          .find({
            symbol,
            duration,
            barTime: { $gte: start, $lt: end },
            observedAt: { $lte: availableAt },
          })
          .sort({ barTime: 1, observedAt: -1 })
          .toArray();
    const latest = new Map<number, CandleObservation>();
    for (const row of rows)
      if (
        !latest.has(row.barTime) ||
        latest.get(row.barTime)!.observedAt < row.observedAt
      )
        latest.set(row.barTime, row);
    return [...latest.values()]
      .sort((a, b) => a.barTime - b.barTime)
      .map((row) => copy(row.value));
  }

  async close() {
    await this.client?.close();
  }
}
