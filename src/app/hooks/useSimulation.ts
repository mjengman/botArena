import { useState, useRef, useEffect, useCallback } from "react";
import { createSimulation } from "../../engine/simulation.ts";
import { sampleDataset } from "../../data/sampleDataset.ts";
import { buyAndHold } from "../../strategies/buyAndHold.ts";
import { movingAverageCrossover } from "../../strategies/movingAverageCrossover.ts";
import { momentum } from "../../strategies/momentum.ts";
import { meanReversion } from "../../strategies/meanReversion.ts";
import { randomBaseline } from "../../strategies/randomBaseline.ts";
import type { ArenaEvent, BotInstance, MetricSnapshot, SimulationConfig } from "../../engine/types.ts";
import { type Speed, SPEED_DELAY, DEFAULT_START_CASH } from "../constants.ts";

const SIM_CONFIG: SimulationConfig = {
  startingCash: DEFAULT_START_CASH,
  feeBps: 5,
  slippageBps: 3,
  seed: 42,
};

const BOT_SPECS = [
  { id: "bah", name: "Buy & Hold", strategy: buyAndHold },
  { id: "mac", name: "MA Crossover", strategy: movingAverageCrossover },
  { id: "mom", name: "Momentum", strategy: momentum },
  { id: "mr", name: "Mean Reversion", strategy: meanReversion },
  { id: "rnd", name: "Random", strategy: randomBaseline },
];

export interface BotDetail {
  id: string;
  name: string;
  cash: number;
  equity: number;
  exposure: number;
  realizedPnl: number;
  unrealizedPnl: number;
  positions: BotInstance["portfolio"]["positions"];
  trades: BotInstance["trades"];
  params: Record<string, unknown>;
}

export interface EquityHistory {
  botId: string;
  botName: string;
  history: number[];
}

export interface UIState {
  candleIndex: number;
  candleTotal: number;
  currentDate: string;
  isComplete: boolean;
  standings: MetricSnapshot[];
  equityHistories: EquityHistory[];
  botDetails: BotDetail[];
  events: ArenaEvent[];
}

function extractUIState(sim: ReturnType<typeof createSimulation>): UIState {
  const snap = sim.getSnapshot();
  const standings = sim.getStandings();
  const events = [...sim.getEvents()];
  const candle = sampleDataset.candles[Math.max(0, snap.candleIndex - 1)];
  const currentDate = candle
    ? new Date(candle.timestamp).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "—";

  return {
    candleIndex: snap.candleIndex,
    candleTotal: sampleDataset.candles.length,
    currentDate,
    isComplete: snap.isComplete,
    standings: [...standings],
    equityHistories: snap.bots.map((b) => ({
      botId: b.spec.id,
      botName: b.spec.name,
      history: [...b.equityHistory],
    })),
    botDetails: snap.bots.map((b) => ({
      id: b.spec.id,
      name: b.spec.name,
      cash: b.cash,
      equity: b.portfolio.equity,
      exposure: b.portfolio.exposure,
      realizedPnl: b.realizedPnl,
      unrealizedPnl: b.portfolio.unrealizedPnl,
      positions: [...b.portfolio.positions],
      trades: [...b.trades],
      params: { ...b.state },
    })),
    events,
  };
}

export function useSimulation() {
  const simRef = useRef(createSimulation(SIM_CONFIG, sampleDataset, BOT_SPECS));
  const [state, setState] = useState<UIState>(() => extractUIState(simRef.current));
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>("1x");
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearLoop = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const pause = useCallback(() => {
    clearLoop();
    setIsPlaying(false);
  }, [clearLoop]);

  const step = useCallback(() => {
    const running = simRef.current.step();
    setState(extractUIState(simRef.current));
    if (!running) pause();
  }, [pause]);

  const play = useCallback(() => {
    if (simRef.current.getSnapshot().isComplete) return;
    if (speed === "max") {
      simRef.current.runToEnd();
      setState(extractUIState(simRef.current));
      return;
    }
    setIsPlaying(true);
  }, [speed]);

  const reset = useCallback(() => {
    pause();
    simRef.current.reset();
    setState(extractUIState(simRef.current));
  }, [pause]);

  // Play loop
  useEffect(() => {
    if (!isPlaying) return;
    const delay = SPEED_DELAY[speed as Exclude<Speed, "max">];
    intervalRef.current = setInterval(() => {
      const running = simRef.current.step();
      setState(extractUIState(simRef.current));
      if (!running) {
        clearLoop();
        setIsPlaying(false);
      }
    }, delay);
    return clearLoop;
  }, [isPlaying, speed, clearLoop]);

  return {
    state,
    isPlaying,
    speed,
    selectedBotId,
    play,
    pause,
    step,
    reset,
    setSpeed,
    selectBot: setSelectedBotId,
    dataset: sampleDataset,
    config: SIM_CONFIG,
  };
}
