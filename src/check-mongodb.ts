import { randomUUID } from "node:crypto";
import { Store } from "./store.js";

const uri = process.env.MONGODB_URI,
  databaseName = process.env.MONGODB_DB_NAME ?? "predict_fun_trading_bot";
if (!uri) throw Error("MONGODB_URI is required");

const store = await Store.connect(uri, databaseName),
  id = `db-check-${randomUUID()}`;
try {
  await store.transaction(async () => {
    await store.put("db_check", id, { status: "ok", time: Date.now() });
    await store.event("database.check", { id });
  });
  const stored = await store.get<{ status: string }>("db_check", id);
  if (stored?.status !== "ok") throw Error("mongodb_round_trip_failed");
  await store.insertFill({
    id,
    account: id,
    market: id,
    direction: "up",
    quantity: 2,
    cost: 1000000,
    fee: 10000,
    time: Date.now(),
  });
  if ((await store.fillsPage(id, 0, 10)).length !== 1)
    throw Error("mongodb_fill_cursor_failed");
  if ((await store.positions(id))[0]?.quantity !== 2)
    throw Error("mongodb_position_aggregation_failed");
  await store.settleFill(id, 2000000, 990000, Date.now());
  if ((await store.pnlSummary(id)).pnl !== 990000)
    throw Error("mongodb_settlement_ledger_failed");
  if (!(await store.acquireLease("database-check", id, Date.now(), 5000)))
    throw Error("mongodb_lease_failed");
  await store.releaseLease("database-check", id);
  await store.delete("db_check", id);
  await store.deleteFill(id);
  await store.deleteEventsByCheckId(id);
  const schema = await store.schemaStatus();
  console.log(
    JSON.stringify(
      {
        status: "ok",
        database: schema.database,
        collections: schema.collections,
        indexes: schema.indexes,
      },
      null,
      2,
    ),
  );
} finally {
  await store.close();
}
