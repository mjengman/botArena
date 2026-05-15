import { useState, useRef, useEffect, useCallback } from "react";
import { createSimulation } from "../../engine/simulation.ts";
import type { ArenaEvent, BotInstance, Dataset, MetricSnapshot } from "../../engine/types.ts";
import { sampleDataset } from "../../data/sampleDataset.ts";
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
  dataset: Dataset,
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

function buildSim(mc: MatchConfig, sourceDataset: Dataset) {
  const dataset = buildDataset(mc, sourceDataset);
  const simConfig = buildSimConfig(mc);
  const botSpecs = buildBotSpecs(mc);
  const sim = createSimulation(simConfig, dataset, botSpecs);
  return { sim, dataset };
}

/** Reset dataStartIdx / dataEndIdx to span the full source dataset. */
function resetDateRange(mc: MatchConfig, source: Dataset): MatchConfig {
  return { ...mc, dataStartIdx: 0, dataEndIdx: source.candles.length - 1 };
}

export function useSimulation() {
  const [matchConfig, setMatchConfig] = useState<MatchConfig>(() => defaultMatchConfig());
  const [configOpen, setConfigOpen] = useState(false);

  // The source dataset for the current session — sampleDataset by default,
  // replaced by a CSV import when the user loads one.
  const sourceDatasetRef = useRef<Dataset>(sampleDataset);

  const builtRef = useRef(buildSim(matchConfig, sourceDatasetRef.current));
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
      const { sim, dataset } = buildSim(newConfig, sourceDatasetRef.current);
      simRef.current = sim;
      datasetRef.current = dataset;
      setMatchConfig(newConfig);
      setSelectedBotId(null);
      setState(extractUIState(sim, dataset));
      setConfigOpen(false);
    },
    [pause],
  );

  /**
   * Load an imported CSV dataset as the new source.
   * Resets the date range to span the full imported dataset and rebuilds the sim.
   * Closes the config panel if open.
   */
  const loadDataset = useCallback(
    (imported: Dataset) => {
      pause();
      sourceDatasetRef.current = imported;
      const newConfig = resetDateRange(matchConfig, imported);
      const { sim, dataset } = buildSim(newConfig, imported);
      simRef.current = sim;
      datasetRef.current = dataset;
      setMatchConfig(newConfig);
      setSelectedBotId(null);
      setState(extractUIState(sim, dataset));
      setConfigOpen(false);
    },
    [pause, matchConfig],
  );

  /**
   * Revert to the built-in synthetic dataset.
   * Resets date range and rebuilds the sim.
   */
  const clearImportedDataset = useCallback(() => {
    pause();
    sourceDatasetRef.current = sampleDataset;
    const newConfig = resetDateRange(matchConfig, sampleDataset);
    const { sim, dataset } = buildSim(newConfig, sampleDataset);
    simRef.current = sim;
    datasetRef.current = dataset;
    setMatchConfig(newConfig);
    setSelectedBotId(null);
    setState(extractUIState(sim, dataset));
  }, [pause, matchConfig]);

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
    loadDataset,
    clearImportedDataset,
    sourceDataset: sourceDatasetRef.current,
    dataset: datasetRef.current,
    config: buildSimConfig(matchConfig),
  };
}
