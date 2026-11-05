import { parseArgs } from "node:util";
import { Store } from "./store.js";
import { backfill, bars, type Duration } from "./history.js";
const { values } = parseArgs({
  options: {
    symbol: { type: "string", default: "BTC" },
    duration: { type: "string", default: "60" },
    days: { type: "string", default: "60" },
    end: { type: "string" },
    database: {
      type: "string",
      default: process.env.MONGODB_HISTORY_DB_NAME ?? "predict_fun_history",
    },
  },
});
const duration = Number(values.duration) as Duration,
  days = Number(values.days);
if (!bars[duration] || !Number.isInteger(days) || days < 1 || days > 365)
  throw Error("duration: 60/300/900/3600; days: 1..365");
const end = values.end
  ? Number(values.end)
  : Math.floor(Date.now() / (duration * 1000)) * duration * 1000;
if (!process.env.MONGODB_URI) throw Error("MONGODB_URI is required");
const store = await Store.connect(process.env.MONGODB_URI, values.database!);
try {
  const report = await backfill(store, {
    symbol: values.symbol!,
    duration,
    start: end - days * 86400000,
    end,
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.complete) process.exitCode = 2;
} finally {
  await store.close();
}
