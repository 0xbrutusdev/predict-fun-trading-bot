import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { Store } from "./store.js";
import { Collector } from "./collector.js";
import { Engine } from "./engine.js";
import { settle } from "./execution.js";
// Input JSONL uses the same receive-time event envelope as /v1/events.
// Account and approved-market events are explicit replay setup, never inferred from future data.
export async function replay(path: string, store: Store) {
  const engine = new Engine(store),
    collector = new Collector(store, "");
  let previous = 0,
    count = 0;
  for await (const line of createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  })) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    if (!Number.isSafeInteger(e.time) || e.time < previous)
      throw Error("events_must_be_receive_time_ordered");
    previous = e.time;
    switch (e.type) {
      case "setup.account":
        if (await store.get("account", e.data.id))
          throw Error("duplicate_account_setup");
        await store.put("account", e.data.id, e.data);
        break;
      case "setup.market":
        if (await store.get("market", e.data.id))
          throw Error("duplicate_market_setup");
        await store.put("market", e.data.id, e.data);
        break;
      case "book":
        await collector.recordBook({ ...e.data, receivedAt: e.time });
        break;
      case "candles": {
        const key = `${e.data.symbol}:${e.data.duration}`,
          old = (await store.get<any[]>("candles", key)) || [];
        await store.put(
          "candles",
          key,
          [
            ...new Map(
              [...old, ...e.data.rows].map((x) => [x.time, x]),
            ).values(),
          ].sort((a, b) => a.time - b.time),
        );
        break;
      }
      case "resolution":
        await settle(store, e.data, e.time);
        break;
      case "clock":
        break;
      default:
        continue;
    }
    await engine.step(e.time);
    count++;
  }
  return {
    events: count,
    accounts: await store.list("account"),
    fills: await store.allFills(),
  };
}
if (
  process.argv[1]?.endsWith("replay.ts") ||
  process.argv[1]?.endsWith("replay.js")
) {
  if (!process.argv[2]) throw Error("usage: replay <events.jsonl>");
  const store = new Store(":memory:");
  try {
    console.log(JSON.stringify(await replay(process.argv[2], store), null, 2));
  } finally {
    await store.close();
  }
}
