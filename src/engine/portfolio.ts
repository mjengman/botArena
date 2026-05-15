import type {
  BotInstance,
  ExecutionFill,
  Position,
  PortfolioSnapshot,
} from "./types.ts";

let tradeIdCounter = 0;

export function makePortfolioSnapshot(bot: BotInstance, marketPrice: Record<string, number>): PortfolioSnapshot {
  const positions: Position[] = [];
  let positionValue = 0;
  let unrealizedPnl = 0;

  for (const [symbol, pos] of bot.positions) {
    if (pos.quantity > 0) {
      positions.push({ ...pos });
      const price = marketPrice[symbol] ?? pos.avgCost;
      const mktVal = pos.quantity * price;
      positionValue += mktVal;
      unrealizedPnl += mktVal - pos.quantity * pos.avgCost;
    }
  }

  const equity = bot.cash + positionValue;
  return {
    cash: bot.cash,
    positions,
    equity,
    realizedPnl: bot.realizedPnl,
    unrealizedPnl,
    exposure: equity > 0 ? positionValue / equity : 0,
  };
}

export function applyFill(bot: BotInstance, fill: ExecutionFill): void {
  if (fill.side === "buy") {
    applyBuy(bot, fill);
  } else {
    applySell(bot, fill);
  }
  bot.fillHistory.push(fill);
}

function applyBuy(bot: BotInstance, fill: ExecutionFill): void {
  const cost = fill.quantity * fill.price + fill.fee;
  bot.cash -= cost;

  const existing = bot.positions.get(fill.symbol);
  if (existing) {
    const totalQty = existing.quantity + fill.quantity;
    const totalCost = existing.quantity * existing.avgCost + fill.quantity * fill.price;
    existing.quantity = totalQty;
    existing.avgCost = totalCost / totalQty;
  } else {
    bot.positions.set(fill.symbol, {
      symbol: fill.symbol,
      quantity: fill.quantity,
      avgCost: fill.price,
    });
  }

  // Open (or add to) a trade record
  const openTrade = bot.trades.find(
    (t) => t.symbol === fill.symbol && t.status === "open",
  );
  if (openTrade) {
    // Average into the open trade
    const totalQty = openTrade.entryQuantity + fill.quantity;
    openTrade.entryPrice =
      (openTrade.entryPrice * openTrade.entryQuantity + fill.price * fill.quantity) / totalQty;
    openTrade.entryQuantity = totalQty;
  } else {
    bot.trades.push({
      id: `trade-${++tradeIdCounter}`,
      symbol: fill.symbol,
      entryTimestamp: fill.timestamp,
      entryPrice: fill.price,
      entryQuantity: fill.quantity,
      status: "open",
    });
  }
}

function applySell(bot: BotInstance, fill: ExecutionFill): void {
  const proceeds = fill.quantity * fill.price - fill.fee;
  bot.cash += proceeds;

  const pos = bot.positions.get(fill.symbol);
  if (!pos) return;

  const pnl = (fill.price - pos.avgCost) * fill.quantity - fill.fee;
  bot.realizedPnl += pnl;

  pos.quantity -= fill.quantity;
  if (pos.quantity <= 0) {
    bot.positions.delete(fill.symbol);
  }

  // Update or close the open trade record
  const openTrade = bot.trades.find(
    (t) => t.symbol === fill.symbol && t.status === "open",
  );
  if (openTrade) {
    openTrade.realizedPnl = (openTrade.realizedPnl ?? 0) + pnl;
    const remainingQty = (openTrade.entryQuantity - fill.quantity);
    if (remainingQty <= 0) {
      // Full exit
      openTrade.exitTimestamp = fill.timestamp;
      openTrade.exitPrice = fill.price;
      openTrade.exitQuantity = fill.quantity;
      openTrade.status = "closed";
    } else {
      // Partial exit: shrink entry quantity to what remains
      openTrade.entryQuantity = remainingQty;
    }
  }
}

export function resetTradeIdCounter(): void {
  tradeIdCounter = 0;
}
