import { createHash } from "node:crypto";
import type { Market } from "./domain.js";

export type MarketAutomationPolicy = {
  enabled: boolean;
  symbols: string[];
  durations: Array<300 | 900>;
  providers: string[];
  lookaheadMs: number;
};

type RecordValue = Record<string, any>;
type ParseResult = { ok: true; market: Market } | { ok: false; reason: string };

const record = (value: unknown): RecordValue | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : null;
const time = (value: unknown) => {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
};
const normalized = (values: string[]) =>
  new Set(values.map((value) => value.trim().toUpperCase()));

export function parsePredictContract(input: unknown): ParseResult {
  const raw = record(input),
    variant = record(raw?.variantData);
  if (
    !raw ||
    raw.marketVariant !== "CRYPTO_UP_DOWN" ||
    variant?.type !== "CRYPTO_UP_DOWN"
  )
    return { ok: false, reason: "unsupported_market_variant" };
  const id =
      typeof raw.id === "number" && Number.isSafeInteger(raw.id)
        ? String(raw.id)
        : text(raw.id),
    start = time(raw.boostStartsAt),
    inclusiveEnd = time(raw.boostEndsAt);
  if (!id || start === null || inclusiveEnd === null || inclusiveEnd < start)
    return { ok: false, reason: "invalid_market_window" };
  const end = inclusiveEnd + 1000,
    duration = (end - start) / 1000;
  if ((duration !== 300 && duration !== 900) || start % (duration * 1000) !== 0)
    return { ok: false, reason: "unsupported_or_unaligned_duration" };
  const symbolText = text(variant.priceFeedSymbol)?.toUpperCase(),
    symbol = symbolText?.match(
      /^(BTC|ETH|SOL|DOGE)(?:_|-|\/)(?:USD|USDT)$/,
    )?.[1];
  if (!symbol) return { ok: false, reason: "unsupported_price_feed_symbol" };
  const outcomes = Array.isArray(raw.outcomes) ? raw.outcomes.map(record) : [],
    up = outcomes.find(
      (outcome) => text(outcome?.name)?.toLowerCase() === "up",
    ),
    down = outcomes.find(
      (outcome) => text(outcome?.name)?.toLowerCase() === "down",
    ),
    upToken = text(up?.onChainId),
    downToken = text(down?.onChainId);
  if (
    outcomes.length !== 2 ||
    !upToken ||
    !downToken ||
    upToken === downToken ||
    !/^\d+$/.test(upToken) ||
    !/^\d+$/.test(downToken)
  )
    return { ok: false, reason: "invalid_outcome_tokens" };
  const feeBps = Number(raw.feeRateBps),
    precision = Number(raw.decimalPrecision),
    conditionId = text(raw.conditionId),
    oracleQuestionId = text(raw.oracleQuestionId),
    provider = text(variant.priceFeedProvider)?.toUpperCase(),
    feedId = text(variant.priceFeedId),
    startPrice = Number(variant.startPrice);
  if (
    !Number.isInteger(feeBps) ||
    feeBps < 0 ||
    feeBps > 1000 ||
    !Number.isInteger(precision) ||
    precision < 1 ||
    precision > 6 ||
    !conditionId ||
    !oracleQuestionId ||
    !provider ||
    !feedId ||
    !Number.isFinite(startPrice) ||
    startPrice <= 0
  )
    return { ok: false, reason: "incomplete_market_contract" };
  const question = text(raw.question),
    description = text(raw.description);
  if (!question || !description)
    return { ok: false, reason: "missing_market_rules" };
  const rules = {
    id,
    question,
    description,
    start,
    end,
    upToken,
    downToken,
    feeBps,
    precision,
    conditionId,
    oracleQuestionId,
    provider,
    feedId,
    symbol,
    startPrice,
    isNegRisk: raw.isNegRisk === true,
    isYieldBearing: raw.isYieldBearing === true,
  };
  const rulesHash = createHash("sha256")
    .update(JSON.stringify(rules))
    .digest("hex");
  const status: Market["status"] =
      raw.status === "RESOLVED"
        ? "RESOLVED"
        : raw.tradingStatus === "OPEN"
          ? "OPEN"
          : "CLOSED",
    endPrice = Number(variant.endPrice);
  return {
    ok: true,
    market: {
      id,
      symbol,
      duration,
      start,
      end,
      upToken,
      downToken,
      yesIsUp: true,
      status,
      feeBps,
      tick: 10 ** -precision,
      rulesHash,
      source: "predict-auto-v1",
      conditionId,
      oracleQuestionId,
      resolutionProvider: provider,
      priceFeedId: feedId,
      startPrice,
      ...(Number.isFinite(endPrice) && endPrice > 0 ? { endPrice } : {}),
      venueVisible: raw.isVisible === true,
      isNegRisk: raw.isNegRisk === true,
      isYieldBearing: raw.isYieldBearing === true,
      question,
      rulesText: description,
      categorySlug: text(raw.categorySlug) ?? undefined,
    },
  };
}

export function registrationEligibility(
  market: Market,
  policy: MarketAutomationPolicy,
  now = Date.now(),
): { eligible: true } | { eligible: false; reason: string } {
  if (!policy.enabled)
    return { eligible: false, reason: "automation_disabled" };
  if (market.status !== "OPEN")
    return { eligible: false, reason: "market_not_open" };
  if (!market.venueVisible)
    return { eligible: false, reason: "market_not_visible" };
  if (!normalized(policy.symbols).has(market.symbol))
    return { eligible: false, reason: "symbol_not_approved" };
  if (!policy.durations.includes(market.duration))
    return { eligible: false, reason: "duration_not_approved" };
  if (
    !market.resolutionProvider ||
    !normalized(policy.providers).has(market.resolutionProvider)
  )
    return { eligible: false, reason: "provider_not_approved" };
  if (market.end <= now) return { eligible: false, reason: "market_expired" };
  if (market.start > now + policy.lookaheadMs)
    return { eligible: false, reason: "outside_registration_lookahead" };
  return { eligible: true };
}

export function authoritativePayout(
  input: unknown,
  registered: Market,
): { payout: [number, number]; source: string } | null {
  const parsed = parsePredictContract(input),
    raw = record(input);
  if (!parsed.ok || !raw || parsed.market.status !== "RESOLVED") return null;
  if (
    parsed.market.id !== registered.id ||
    parsed.market.start !== registered.start ||
    parsed.market.end !== registered.end ||
    parsed.market.upToken !== registered.upToken ||
    parsed.market.downToken !== registered.downToken ||
    parsed.market.conditionId !== registered.conditionId ||
    parsed.market.rulesHash !== registered.rulesHash
  )
    return null;
  const outcomes = (raw.outcomes as unknown[]).map(record),
    up = outcomes.find((outcome) => outcome?.onChainId === registered.upToken),
    down = outcomes.find(
      (outcome) => outcome?.onChainId === registered.downToken,
    ),
    winner = record(raw.resolution),
    upWon = up?.status === "WON" && down?.status === "LOST",
    downWon = down?.status === "WON" && up?.status === "LOST";
  if (upWon && winner?.onChainId === registered.upToken)
    return {
      payout: [1, 0],
      source: `https://api.predict.fun/v1/markets/${registered.id}`,
    };
  if (downWon && winner?.onChainId === registered.downToken)
    return {
      payout: [0, 1],
      source: `https://api.predict.fun/v1/markets/${registered.id}`,
    };
  return null;
}
