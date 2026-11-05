import { randomUUID } from "node:crypto";
import { Store } from "./store.js";
import {
  asksFor,
  units,
  money,
  type Book,
  type Market,
  type Direction,
} from "./domain.js";
export type Account = {
  id: string;
  name: string;
  walletAddress?: string;
  mode: "paper";
  enabled: boolean;
  initialEquity: number;
  cash: number;
  maxMarketRisk: number;
  maxTotalRisk: number;
  dailyLossLimit: number;
  fixedShares: number;
  depthFraction: number;
  paperFeeBps: number;
  createdAt: number;
  revision?: number;
};
export type Phase = "t1" | "retry" | "t2" | "t3" | "late" | "done";
export function checkpoint(duration: 300 | 900, phase: Phase) {
  return phase === "t1"
    ? duration === 300
      ? 3
      : 75
    : phase === "retry"
      ? 7
      : phase === "t2"
        ? 120
        : 210;
}
export function decide(
  duration: 300 | 900,
  phase: Phase,
  asks: number[],
  priorFill: boolean,
): { buy: boolean; next: Phase } {
  if (phase === "done") return { buy: false, next: "done" };
  if (
    asks.length !== 3 ||
    asks.some((p) => !Number.isFinite(p) || p <= 0 || p >= 1)
  )
    return {
      buy: false,
      next:
        duration === 300
          ? phase === "t1"
            ? "retry"
            : phase === "retry"
              ? "late"
              : "done"
          : phase === "t1"
            ? "t2"
            : phase === "t2"
              ? "t3"
              : "done",
    };
  const p = [...asks].sort((a, b) => a - b)[1];
  if (duration === 300) {
    if (phase === "late")
      return { buy: asks.every((p) => p >= 0.45 && p < 0.9), next: "done" };
    if (asks.some((p) => p >= 0.95)) return { buy: false, next: "done" };
    return {
      buy: false,
      next: p < 0.55 && p >= 0.35 ? "late" : phase === "t1" ? "retry" : "late",
    };
  }
  if (phase === "t1") {
    if (p < 0.05) return { buy: false, next: "t2" };
    if (p < 0.59) return { buy: false, next: "t3" };
    if (p < 0.6) return { buy: false, next: "t2" };
    if (p < 0.76) return { buy: true, next: "t2" };
    return { buy: false, next: p < 0.95 ? "t2" : "done" };
  }
  if (phase === "t2") return { buy: p >= 0.72 && p < 0.95, next: "t3" };
  return { buy: !priorFill && p >= 0.82 && p < 0.92, next: "done" };
}
export async function paperFill(
  store: Store,
  accountId: string,
  m: Market,
  b: Book,
  d: Direction,
  target: number,
  limit: number,
  key: string,
  now: number,
) {
  return store.transaction(async () => {
    if (
      ![target, limit, now, b.receivedAt, b.updatedAt].every(Number.isFinite) ||
      target <= 0 ||
      limit <= 0 ||
      limit >= 1
    )
      throw Error("invalid_order_input");
    if (await store.get("execution", key))
      return { status: "duplicate", quantity: 0 };
    const a = await store.get<Account>("account", accountId);
    if (!a || !a.enabled) throw Error("account_disabled");
    if (await store.hasUnknownSettlementTime(accountId))
      throw Error("historical_settlement_time_unknown");
    if (
      b.marketId !== m.id ||
      m.status !== "OPEN" ||
      now >= m.end ||
      now < m.start ||
      b.receivedAt > now ||
      b.updatedAt > now ||
      now - b.receivedAt > 1000 ||
      now - b.updatedAt > 1000
    )
      throw Error("market_or_book_ineligible");
    const rows = await store.listUnresolvedFills(a.id);
    if (rows.some((x) => x.market === m.id && x.direction !== d))
      throw Error("direction_conflict");
    const total = rows.reduce((s, x) => s + x.cost + x.fee, 0),
      marketRisk = rows
        .filter((x) => x.market === m.id)
        .reduce((s, x) => s + x.cost + x.fee, 0);
    const day = Math.floor(now / 86400000) * 86400000;
    const pnl = await store.sumSettledPnl(a.id, day, now);
    if (pnl <= -units(a.initialEquity * a.dailyLossLimit))
      throw Error("daily_loss_limit");
    const budget = Math.min(
      units(a.cash),
      units(a.initialEquity * a.dailyLossLimit) + pnl - total,
      units(a.initialEquity * a.maxTotalRisk) - total,
      units(a.initialEquity * a.maxMarketRisk) - marketRisk,
    );
    const prior = rows
      .filter((x) => x.market === m.id && x.direction === d)
      .reduce((s, x) => s + x.quantity, 0);
    const depthKey = `${m.id}:${d}:${b.updatedAt}`;
    const consumed =
      (await store.get<Record<string, number>>("depth", depthKey)) || {};
    let left = Math.max(0, target - prior),
      qty = 0,
      cost = 0;
    const takes: Record<string, number> = {};
    for (const [price, size] of asksFor(b, m, d)) {
      if (price > limit || left <= 0) break;
      const take = Math.min(
        left,
        Math.max(0, size * a.depthFraction - (consumed[String(price)] || 0)),
        Math.max(
          0,
          (money(budget) / (1 + a.paperFeeBps / 10000) - money(cost)) / price,
        ),
      );
      const spend = units(take * price);
      qty += take;
      cost += spend;
      left -= take;
      takes[String(price)] = (takes[String(price)] || 0) + take;
    }
    // Conservative explicit paper fee assumption, not a claim about venue fees.
    const fee = Math.ceil((cost * a.paperFeeBps) / 10000);
    if (cost + fee > budget || cost < units(1) || qty <= 0) {
      await store.put("execution", key, { status: "no_fill", time: now });
      return { status: "no_fill", quantity: 0 };
    }
    for (const [price, take] of Object.entries(takes))
      consumed[price] = (consumed[price] || 0) + take;
    await store.put("depth", depthKey, consumed);
    const id = randomUUID();
    await store.insertFill({
      id,
      account: a.id,
      market: m.id,
      direction: d,
      quantity: qty,
      cost,
      fee,
      time: now,
    });
    a.cash = money(units(a.cash) - cost - fee);
    await store.put("account", a.id, a);
    const result = {
      status: "filled",
      quantity: qty,
      cost: money(cost),
      fee: money(fee),
      id,
    };
    await store.put("execution", key, result);
    await store.event(
      "paper.fill",
      { ...result, accountId: a.id, marketId: m.id },
      now,
    );
    return result;
  });
}
export async function settle(store: Store, m: Market, now = Date.now()) {
  if (
    !m.payout ||
    m.status !== "RESOLVED" ||
    now < m.end ||
    m.payout.length !== 2 ||
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(m.end) ||
    m.payout.some((x) => !Number.isFinite(x) || x < 0 || x > 1) ||
    Math.abs(m.payout[0] + m.payout[1] - 1) > 1e-9
  )
    throw Error("invalid_resolution");
  await store.transaction(async () => {
    const previous = await store.get<Market>("market", m.id);
    if (
      previous &&
      (previous.start !== m.start ||
        previous.end !== m.end ||
        previous.upToken !== m.upToken ||
        previous.downToken !== m.downToken)
    )
      throw Error("resolution_market_mismatch");
    if (
      previous?.payout &&
      JSON.stringify(previous.payout) !== JSON.stringify(m.payout)
    )
      throw Error("resolution_conflict");
    const rows = await store.unsettledMarketFills(m.id);
    for (const f of rows) {
      const payout = units(
        f.quantity * m.payout![f.direction === "up" ? 0 : 1],
      );
      const a = (await store.get<Account>("account", f.account))!;
      a.cash = money(units(a.cash) + payout);
      await store.put("account", a.id, a);
      await store.settleFill(f.id, payout, payout - f.cost - f.fee, now);
      await store.event(
        "paper.settlement",
        {
          fillId: f.id,
          payout: money(payout),
          pnl: money(payout - f.cost - f.fee),
        },
        now,
      );
    }
    await store.put("market", m.id, m);
  });
}
