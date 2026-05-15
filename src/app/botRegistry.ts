import type { StrategyDefinition } from "../engine/types.ts";
import { buyAndHold } from "../strategies/buyAndHold.ts";
import { movingAverageCrossover } from "../strategies/movingAverageCrossover.ts";
import { momentum } from "../strategies/momentum.ts";
import { meanReversion } from "../strategies/meanReversion.ts";
import { randomBaseline } from "../strategies/randomBaseline.ts";

export interface ParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
}

export interface BotDef {
  id: string;
  name: string;
  strategy: StrategyDefinition;
  paramDefs: ParamDef[];
}

export const BOT_REGISTRY: BotDef[] = [
  {
    id: "bah",
    name: "Buy & Hold",
    strategy: buyAndHold,
    paramDefs: [],
  },
  {
    id: "mac",
    name: "MA Crossover",
    strategy: movingAverageCrossover,
    paramDefs: [
      { key: "shortPeriod", label: "Short Period", min: 2, max: 50, step: 1, defaultValue: 10 },
      { key: "longPeriod", label: "Long Period", min: 5, max: 200, step: 1, defaultValue: 30 },
    ],
  },
  {
    id: "mom",
    name: "Momentum",
    strategy: momentum,
    paramDefs: [
      { key: "period", label: "Period", min: 5, max: 100, step: 1, defaultValue: 20 },
      { key: "threshold", label: "Threshold", min: 0.001, max: 0.2, step: 0.001, defaultValue: 0.02 },
    ],
  },
  {
    id: "mr",
    name: "Mean Reversion",
    strategy: meanReversion,
    paramDefs: [
      { key: "period", label: "Period", min: 5, max: 100, step: 1, defaultValue: 20 },
      { key: "zBuy", label: "Z-Buy", min: 0.1, max: 4, step: 0.1, defaultValue: 1.5 },
      { key: "zSell", label: "Z-Sell", min: -2, max: 2, step: 0.1, defaultValue: 0 },
    ],
  },
  {
    id: "rnd",
    name: "Random",
    strategy: randomBaseline,
    paramDefs: [
      { key: "buyProb", label: "Buy Prob", min: 0.01, max: 0.5, step: 0.01, defaultValue: 0.05 },
      { key: "sellProb", label: "Sell Prob", min: 0.01, max: 0.5, step: 0.01, defaultValue: 0.1 },
    ],
  },
];
