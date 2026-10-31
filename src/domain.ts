export type Direction = "up" | "down";
export type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
export type Level = [number, number];
export type Book = {
  marketId: string;
  receivedAt: number;
  updatedAt: number;
  asks: Level[];
  bids: Level[];
};
export type Market = {
  id: string;
  symbol: string;
  duration: 300 | 900;
  start: number;
  end: number;
  upToken: string;
  downToken: string;
  yesIsUp: boolean;
  status: "OPEN" | "CLOSED" | "RESOLVED";
  feeBps: number;
  tick: number;
  rulesHash: string;
  payout?: [number, number];
};
export type Signal = {
  strategy: string;
  direction: Direction;
  confidence: number;
};
export type Intent = {
  id: string;
  accountId: string;
  marketId: string;
  direction: Direction;
  quantity: number;
  limit: number;
  feeBps: number;
  status: string;
  filled: number;
  cost: number;
  fees: number;
  netShares: number;
};
export function asksFor(
  book: Book,
  market: Market,
  direction: Direction,
): Level[] {
  const yes = (direction === "up") === market.yesIsUp;
  return (
    yes
      ? book.asks
      : book.bids.map(([p, q]): Level => [
          Math.round((1 - p) / market.tick) * market.tick,
          q,
        ])
  )
    .filter(([p, q]) => p > 0 && p < 1 && q > 0)
    .sort((a, b) => a[0] - b[0]);
}
// Integer micro-USDT ledger. Exchange signing uses SDK bigint base units separately.
export const units = (x: number) => Math.round(x * 1_000_000);
export const money = (x: number) => x / 1_000_000;
