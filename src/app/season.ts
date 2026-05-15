import { createSimulation } from "../engine/simulation.ts";
import type { MetricSnapshot } from "../engine/types.ts";
import { type MatchConfig, buildSimConfig, buildBotSpecs, buildDataset } from "./matchConfig.ts";

export interface SeasonWindow {
  index: number;
  startDate: string;
  endDate: string;
  candleCount: number;
  standings: MetricSnapshot[];
}

export interface AggregateStanding {
  botId: string;
  botName: string;
  wins: number;
  avgReturn: number;
  totalReturn: number;    // compounded across windows: product of (1 + r) - 1
  avgMaxDrawdown: number;
  avgProfitFactor: number;
  matchCount: number;
}

export interface SeasonResult {
  id: string;
  ranAt: string;
  windowCount: number;
  windows: SeasonWindow[];
  aggregate: AggregateStanding[];
}

export function buildWindowDefs(
  mc: MatchConfig,
  windowCount: number,
): Array<{ startIdx: number; endIdx: number }> {
  const totalCandles = mc.dataEndIdx - mc.dataStartIdx + 1;
  const windowSize = Math.floor(totalCandles / windowCount);
  return Array.from({ length: windowCount }, (_, i) => ({
    startIdx: mc.dataStartIdx + i * windowSize,
    endIdx: i === windowCount - 1 ? mc.dataEndIdx : mc.dataStartIdx + (i + 1) * windowSize - 1,
  }));
}

export function runSeason(mc: MatchConfig, windowCount: number): SeasonResult {
  const defs = buildWindowDefs(mc, windowCount);

  const windows: SeasonWindow[] = defs.map((def, i) => {
    const windowConfig = { ...mc, dataStartIdx: def.startIdx, dataEndIdx: def.endIdx };
    const dataset = buildDataset(windowConfig);
    const sim = createSimulation(buildSimConfig(windowConfig), dataset, buildBotSpecs(windowConfig));
    sim.runToEnd();
    return {
      index: i,
      startDate: dataset.manifest.startDate,
      endDate: dataset.manifest.endDate,
      candleCount: dataset.manifest.candleCount,
      standings: sim.getStandings(),
    };
  });

  return {
    id: `season-${Date.now()}`,
    ranAt: new Date().toISOString(),
    windowCount,
    windows,
    aggregate: computeAggregate(windows),
  };
}

function computeAggregate(windows: SeasonWindow[]): AggregateStanding[] {
  const botMap = new Map<
    string,
    { name: string; returns: number[]; drawdowns: number[]; profitFactors: number[]; wins: number }
  >();

  for (const w of windows) {
    for (const s of w.standings) {
      if (!botMap.has(s.botId)) {
        botMap.set(s.botId, { name: s.botName, returns: [], drawdowns: [], profitFactors: [], wins: 0 });
      }
      const entry = botMap.get(s.botId)!;
      entry.returns.push(s.totalReturn);
      entry.drawdowns.push(s.maxDrawdown);
      // Only include profit factor for windows where the bot had closed trades;
      // bots with no closed trades contribute a misleading 0 that skews the average.
      if ((s.closedTradeCount ?? 0) > 0) {
        // Cap Infinity profit factor at 10 for averaging purposes
        entry.profitFactors.push(isFinite(s.profitFactor) ? s.profitFactor : 10);
      }
      if (s.rank === 1) entry.wins++;
    }
  }

  const standings: AggregateStanding[] = [];
  for (const [botId, data] of botMap) {
    const n = data.returns.length;
    standings.push({
      botId,
      botName: data.name,
      wins: data.wins,
      avgReturn: data.returns.reduce((s, r) => s + r, 0) / n,
      totalReturn: data.returns.reduce((acc, r) => acc * (1 + r), 1) - 1,
      avgMaxDrawdown: data.drawdowns.reduce((s, d) => s + d, 0) / n,
      // NaN when no window had closed trades — rendered as "—" in the UI
      avgProfitFactor: data.profitFactors.length > 0
        ? data.profitFactors.reduce((s, p) => s + p, 0) / data.profitFactors.length
        : NaN,
      matchCount: n,
    });
  }

  // Sort by compounded return — the true season winner maximises compounded growth
  standings.sort((a, b) => b.totalReturn - a.totalReturn);
  return standings;
}
