import type {
  BotInstance,
  BotSpec,
  Dataset,
  MetricSnapshot,
  SimulationConfig,
  SimulationSnapshot,
} from "./types.ts";
import { EventLog } from "./events.ts";
import { executeOrder } from "./execution.ts";
import { applyFill, makePortfolioSnapshot, resetTradeIdCounter } from "./portfolio.ts";
import { rankBots } from "./metrics.ts";

export interface Simulation {
  step(): boolean;       // advance one candle; returns false when complete
  runToEnd(): void;
  reset(): void;
  getSnapshot(): SimulationSnapshot;
  getStandings(): MetricSnapshot[];
  getEvents(): ReturnType<EventLog["getAll"]>;
}

export function createSimulation(
  config: SimulationConfig,
  dataset: Dataset,
  botSpecs: BotSpec[],
): Simulation {
  let candleIndex = 0;
  let isComplete = false;
  const log = new EventLog();

  let bots = initBots(botSpecs, config.startingCash);

  function initBots(specs: BotSpec[], cash: number): BotInstance[] {
    return specs.map((spec) => ({
      spec,
      cash,
      positions: new Map(),
      realizedPnl: 0,
      state: { ...(spec.params ?? spec.strategy.defaultParams ?? {}) },
      trades: [],
      fillHistory: [],
      equityHistory: [],
      exposedCandles: 0,
      portfolio: {
        cash,
        positions: [],
        equity: cash,
        realizedPnl: 0,
        unrealizedPnl: 0,
        exposure: 0,
      },
    }));
  }

  function currentPrice(): Record<string, number> {
    const c = dataset.candles[candleIndex - 1];
    return c ? { [dataset.manifest.symbol]: c.close } : {};
  }

  function step(): boolean {
    if (isComplete) return false;

    if (candleIndex === 0) {
      log.emit("MATCH_START", dataset.candles[0]?.timestamp ?? 0, 0, null, {
        symbol: dataset.manifest.symbol,
        candleCount: dataset.candles.length,
        botCount: bots.length,
        startingCash: config.startingCash,
      });
    }

    if (candleIndex >= dataset.candles.length) {
      finalizeMatch();
      return false;
    }

    const candle = dataset.candles[candleIndex]!;
    const visibleCandles = dataset.candles.slice(0, candleIndex + 1);

    log.emit("CANDLE_OPEN", candle.timestamp, candleIndex, null, {
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    });

    for (const bot of bots) {
      const portfolio = makePortfolioSnapshot(bot, {
        [dataset.manifest.symbol]: candle.close,
      });
      bot.portfolio = portfolio;

      const ctx = {
        symbol: dataset.manifest.symbol,
        candle,
        candleIndex,
        allCandles: visibleCandles as readonly (typeof candle)[],
        portfolio,
        botState: bot.state,
        config,
        seed: config.seed ^ hashString(bot.spec.id),
      };

      let intent: ReturnType<typeof bot.spec.strategy.fn>;
      try {
        intent = bot.spec.strategy.fn(ctx);
      } catch (err) {
        log.emit("WARNING", candle.timestamp, candleIndex, bot.spec.id, {
          message: `Strategy threw: ${String(err)}`,
        });
        continue;
      }

      if (!intent) continue;

      log.emit("ORDER_INTENT", candle.timestamp, candleIndex, bot.spec.id, {
        side: intent.side,
        symbol: intent.symbol,
        size: intent.size,
      });

      const result = executeOrder(intent, bot, portfolio, candle, config);

      if (result.ok) {
        applyFill(bot, result.fill);
        bot.portfolio = makePortfolioSnapshot(bot, {
          [dataset.manifest.symbol]: candle.close,
        });
        log.emit("ORDER_FILL", candle.timestamp, candleIndex, bot.spec.id, {
          side: result.fill.side,
          symbol: result.fill.symbol,
          quantity: result.fill.quantity,
          price: result.fill.price,
          fee: result.fill.fee,
          cashAfter: bot.cash,
          equityAfter: bot.portfolio.equity,
        });
        log.emit("PORTFOLIO_UPDATE", candle.timestamp, candleIndex, bot.spec.id, {
          cash: bot.portfolio.cash,
          equity: bot.portfolio.equity,
          exposure: bot.portfolio.exposure,
        });
      } else {
        log.emit("ORDER_REJECTED", candle.timestamp, candleIndex, bot.spec.id, {
          reason: result.reason,
          side: intent.side,
          symbol: intent.symbol,
        });
      }
    }

    // Record mark-to-market equity and exposure for every bot at candle close
    for (const bot of bots) {
      const snap = makePortfolioSnapshot(bot, { [dataset.manifest.symbol]: candle.close });
      bot.equityHistory.push(snap.equity);
      bot.portfolio = snap;
      if (bot.positions.size > 0) bot.exposedCandles++;
    }

    candleIndex++;

    if (candleIndex >= dataset.candles.length) {
      finalizeMatch();
      return false;
    }

    return true;
  }

  function finalizeMatch(): void {
    if (isComplete) return;
    isComplete = true;
    const lastCandle = dataset.candles[dataset.candles.length - 1];
    const ts = lastCandle?.timestamp ?? 0;
    const standings = rankBots(bots, config.startingCash, currentPrice(), dataset.candles.length);
    log.emit("MATCH_END", ts, candleIndex, null, {
      standings: standings.map((s) => ({
        rank: s.rank,
        botId: s.botId,
        botName: s.botName,
        totalReturn: s.totalReturn,
        finalEquity: s.finalEquity,
      })),
    });
  }

  function runToEnd(): void {
    while (step()) { /* advance */ }
  }

  function reset(): void {
    candleIndex = 0;
    isComplete = false;
    log.reset();
    resetTradeIdCounter();
    bots = initBots(botSpecs, config.startingCash);
  }

  function getSnapshot(): SimulationSnapshot {
    const candle = dataset.candles[Math.max(0, candleIndex - 1)];
    return {
      candleIndex,
      timestamp: candle?.timestamp ?? 0,
      bots,
      events: [...log.getAll()],
      isComplete,
    };
  }

  function getStandings(): MetricSnapshot[] {
    return rankBots(bots, config.startingCash, currentPrice(), dataset.candles.length);
  }

  return { step, runToEnd, reset, getSnapshot, getStandings, getEvents: () => log.getAll() };
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}
