import { createRequire } from "node:module";
// SDK ships CommonJS declarations; use the same ethers conditional export.
const { Wallet, JsonRpcProvider, parseUnits } = createRequire(import.meta.url)(
  "ethers",
) as typeof import("ethers", { with: { "resolution-mode": "require" } });
import { OrderBuilder, ChainId, Side } from "@predictdotfun/sdk";
/** Server-side signing probe. Not wired to public API; never accepts secrets from browser clients. */
export async function prepareSignedLimit(input: {
  privateKey: string;
  rpcUrl: string;
  predictAccount?: `0x${string}`;
  tokenId: string;
  price: string;
  quantity: string;
  feeRateBps: number;
  expiresAt: Date;
  isNegRisk: boolean;
  isYieldBearing: boolean;
  testnet: boolean;
}) {
  const wallet = new Wallet(
    input.privateKey,
    new JsonRpcProvider(input.rpcUrl),
  );
  const builder = await OrderBuilder.make(
    input.testnet ? ChainId.BnbTestnet : ChainId.BnbMainnet,
    wallet,
    { predictAccount: input.predictAccount },
  );
  const amounts = builder.getLimitOrderAmounts({
    side: Side.BUY,
    pricePerShareWei: parseUnits(input.price, 18),
    quantityWei: parseUnits(input.quantity, 18),
  });
  const order = builder.buildOrder("LIMIT", {
    side: Side.BUY,
    tokenId: input.tokenId,
    makerAmount: amounts.makerAmount,
    takerAmount: amounts.takerAmount,
    feeRateBps: input.feeRateBps,
    expiresAt: input.expiresAt,
  });
  const typed = builder.buildTypedData(order, {
    isNegRisk: input.isNegRisk,
    isYieldBearing: input.isYieldBearing,
  });
  return {
    data: {
      order: {
        ...(await builder.signTypedDataOrder(typed)),
        hash: builder.buildTypedDataHash(typed),
      },
      pricePerShare: amounts.pricePerShare,
      strategy: "LIMIT",
    },
  };
}
export function assertLiveSubmissionAllowed(): never {
  throw Error(
    "LIVE_BLOCKED: verified immediate-order semantics, exact fee ledger, reconciliation and research promotion evidence required",
  );
}
