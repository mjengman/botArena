import { useState, useRef, useEffect, useCallback } from "react";
import { createSimulation } from "../../engine/simulation.ts";
import type { ArenaEvent, BotInstance, MetricSnapshot } from "../../engine/types.ts";
import { type Speed, SPEED_DELAY } from "../constants.ts";
import {
  type MatchConfig,
  defaultMatchConfig,
  buildSimConfig,
  buildBotSpecs,
  buildDataset,
} from "../matchConfig.ts";

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

function extractUIState(
  sim: ReturnType<typeof createSimulation>,
  dataset: ReturnType<typeof buildDataset>,
): UIState {
  const snap = sim.getSnapshot();
  const standings = sim.getStandings();
  const events = [...sim.getEvents()];
  const candle = dataset.candles[Math.max(0, snap.candleIndex - 1)];
  const currentDate = candle
    ? new Date(candle.timestamp).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      })
    : "—";

  return {
    candleIndex: snap.candleIndex,
    candleTotal: dataset.candles.length,
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

function buildSim(mc: MatchConfig) {
  const dataset = buildDataset(mc);
  const simConfig = buildSimConfig(mc);
  const botSpecs = buildBotSpecs(mc);
  const sim = createSimulation(simConfig, dataset, botSpecs);
  return { sim, dataset };
}

export function useSimulation() {
  const [matchConfig, setMatchConfig] = useState<MatchConfig>(() => defaultMatchConfig());
  const [configOpen, setConfigOpen] = useState(false);

  const builtRef = useRef(buildSim(matchConfig));
  const simRef = useRef(builtRef.current.sim);
  const datasetRef = useRef(builtRef.current.dataset);

  const [state, setState] = useState<UIState>(() =>
    extractUIState(simRef.current, datasetRef.current),
  );
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
    setState(extractUIState(simRef.current, datasetRef.current));
    if (!running) pause();
  }, [pause]);

  const play = useCallback(() => {
    if (simRef.current.getSnapshot().isComplete) return;
    if (speed === "max") {
      simRef.current.runToEnd();
      setState(extractUIState(simRef.current, datasetRef.current));
      return;
    }
    setIsPlaying(true);
  }, [speed]);

  const reset = useCallback(() => {
    pause();
    simRef.current.reset();
    setState(extractUIState(simRef.current, datasetRef.current));
  }, [pause]);

  const applyConfig = useCallback(
    (newConfig: MatchConfig) => {
      pause();
      const { sim, dataset } = buildSim(newConfig);
      simRef.current = sim;
      datasetRef.current = dataset;
      setMatchConfig(newConfig);
      setSelectedBotId(null);
      setState(extractUIState(sim, dataset));
      setConfigOpen(false);
    },
    [pause],
  );

  // Play loop
  useEffect(() => {
    if (!isPlaying) return;

    if (speed === "max") {
      simRef.current.runToEnd();
      setState(extractUIState(simRef.current, datasetRef.current));
      setIsPlaying(false);
      return;
    }

    const delay = SPEED_DELAY[speed];
    intervalRef.current = setInterval(() => {
      const running = simRef.current.step();
      setState(extractUIState(simRef.current, datasetRef.current));
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
    matchConfig,
    configOpen,
    play,
    pause,
    step,
    reset,
    setSpeed,
    selectBot: setSelectedBotId,
    openConfig: () => setConfigOpen(true),
    closeConfig: () => setConfigOpen(false),
    applyConfig,
    dataset: datasetRef.current,
    config: buildSimConfig(matchConfig),
  };
}
