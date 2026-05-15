import type { Dataset } from "../engine/types.ts";
import type { UIState } from "./hooks/useSimulation.ts";
import type { MatchConfig } from "./matchConfig.ts";

export function exportRun(state: UIState, matchConfig: MatchConfig, dataset: Dataset) {
  const record = {
    exportedAt: new Date().toISOString(),
    config: {
      startingCash: matchConfig.startingCash,
      feeBps: matchConfig.feeBps,
      slippageBps: matchConfig.slippageBps,
      seed: matchConfig.seed,
    },
    dataset: {
      symbol: dataset.manifest.symbol,
      timeframe: dataset.manifest.timeframe,
      source: dataset.manifest.source,
      startDate: dataset.manifest.startDate,
      endDate: dataset.manifest.endDate,
      candleCount: dataset.manifest.candleCount,
    },
    bots: matchConfig.activeBotIds.map((id) => ({
      id,
      params: matchConfig.botParams[id] ?? {},
    })),
    standings: state.standings.map((s) => ({
      botId: s.botId,
      botName: s.botName,
      totalReturn: s.totalReturn,
      finalEquity: s.finalEquity,
      maxDrawdown: s.maxDrawdown,
      winRate: s.winRate,
      tradeCount: s.tradeCount,
      closedTradeCount: s.closedTradeCount,
      profitFactor: s.profitFactor,
      avgTrade: s.avgTrade,
      exposureTime: s.exposureTime,
    })),
    eventCount: state.events.length,
  };

  const json = JSON.stringify(record, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bot-arena-run-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
