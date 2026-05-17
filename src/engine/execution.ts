import type {
  BotInstance,
  Candle,
  ExecutionFill,
  OrderIntent,
  PortfolioSnapshot,
  SimulationConfig,
} from "./types.ts";
import { floorFractionalShares } from "./fractional.ts";

export type RejectionReason =
  | "INSUFFICIENT_CASH"
  | "NO_POSITION"
  | "ZERO_QUANTITY"
  | "INVALID_ALLOCATION"
  | "PRICE_ZERO";

export type ExecutionResult =
  | { ok: true; fill: ExecutionFill }
  | { ok: false; reason: RejectionReason };

export function executeOrder(
  intent: OrderIntent,
  bot: BotInstance,
  portfolio: PortfolioSnapshot,
  candle: Candle,
  config: SimulationConfig,
): ExecutionResult {
  const basePrice = candle.close;
  if (basePrice <= 0) return { ok: false, reason: "PRICE_ZERO" };

  // Apply slippage: buys pay more, sells receive less
  const slippageFraction = config.slippageBps / 10000;
  const fillPrice =
    intent.side === "buy"
      ? basePrice * (1 + slippageFraction)
      : basePrice * (1 - slippageFraction);

  let quantity: number;

  if (intent.side === "buy") {
    quantity = resolveBuyQuantity(intent, portfolio, fillPrice);
  } else {
    quantity = resolveSellQuantity(intent, bot, candle);
  }

  // Alpaca supports fractional stock/ETF quantities and notional market orders.
  // Floor to 9 decimal places so simulated buys never exceed available cash.
  quantity = floorFractionalShares(quantity);
  if (quantity <= 0) return { ok: false, reason: "ZERO_QUANTITY" };

  const feeFraction = config.feeBps / 10000;

  if (intent.side === "buy") {
    const totalCost = quantity * fillPrice * (1 + feeFraction);
    if (totalCost > portfolio.cash) {
      // Try to buy as many shares as cash allows
      quantity = floorFractionalShares(portfolio.cash / (fillPrice * (1 + feeFraction)));
      if (quantity <= 0) return { ok: false, reason: "INSUFFICIENT_CASH" };
    }
  }

  const fee = quantity * fillPrice * feeFraction;

  const fill: ExecutionFill = {
    side: intent.side,
    symbol: intent.symbol,
    quantity,
    price: fillPrice,
    fee,
    timestamp: candle.timestamp,
  };

  return { ok: true, fill };
}

function resolveBuyQuantity(
  intent: OrderIntent,
  portfolio: PortfolioSnapshot,
  fillPrice: number,
): number {
  const size = intent.size;
  if (size.type === "quantity") {
    return size.quantity;
  }
  if (size.type === "targetAllocation") {
    const fraction = Math.max(0, Math.min(1, size.fraction));
    const targetValue = portfolio.equity * fraction;
    return targetValue / fillPrice;
  }
  return 0;
}

function resolveSellQuantity(
  intent: OrderIntent,
  bot: BotInstance,
  _candle: Candle,
): number {
  const pos = bot.positions.get(intent.symbol);
  if (!pos || pos.quantity <= 0) return 0;

  const size = intent.size;
  if (size.type === "quantity") {
    return Math.min(size.quantity, pos.quantity);
  }
  if (size.type === "sellPercent") {
    const fraction = Math.max(0, Math.min(1, size.fraction));
    return pos.quantity * fraction;
  }
  if (size.type === "closePosition") {
    return pos.quantity;
  }
  return 0;
}
