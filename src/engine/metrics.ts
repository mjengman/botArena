import type { BotInstance, MetricSnapshot } from "./types.ts";

export function computeMetrics(
  bot: BotInstance,
  startCash: number,
  currentPrice: Record<string, number>,
  rank: number,
): MetricSnapshot {
  // Use per-candle equity history for accurate drawdown
  const equitySeries = bot.equityHistory.length > 0
    ? [startCash, ...bot.equityHistory]
    : [startCash];

  const maxDrawdown = computeMaxDrawdown(equitySeries);

  const closedTrades = bot.trades.filter((t) => t.status === "closed");
  const winningTrades = closedTrades.filter((t) => (t.realizedPnl ?? 0) > 0);
  const winRate = closedTrades.length > 0 ? winningTrades.length / closedTrades.length : 0;

  // Compute current equity using last known prices
  let positionValue = 0;
  let costBasis = 0;
  for (const [symbol, pos] of bot.positions) {
    const price = currentPrice[symbol] ?? pos.avgCost;
    positionValue += pos.quantity * price;
    costBasis += pos.quantity * pos.avgCost;
  }
  const finalEquity = bot.cash + positionValue;
  const unrealizedPnl = positionValue - costBasis;

  return {
    botId: bot.spec.id,
    botName: bot.spec.name,
    totalReturn: (finalEquity - startCash) / startCash,
    finalEquity,
    maxDrawdown,
    winRate,
    tradeCount: bot.trades.length,
    realizedPnl: bot.realizedPnl,
    unrealizedPnl,
    rank,
  };
}

function computeMaxDrawdown(equitySeries: number[]): number {
  let peak = equitySeries[0] ?? 0;
  let maxDD = 0;
  for (const equity of equitySeries) {
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

export function rankBots(
  bots: BotInstance[],
  startCash: number,
  currentPrice: Record<string, number>,
): MetricSnapshot[] {
  const metrics = bots.map((bot, i) =>
    computeMetrics(bot, startCash, currentPrice, i + 1),
  );
  metrics.sort((a, b) => b.totalReturn - a.totalReturn);
  metrics.forEach((m, i) => (m.rank = i + 1));
  return metrics;
}
