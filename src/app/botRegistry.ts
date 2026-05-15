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

// ─── StrategyMeta ─────────────────────────────────────────────────────────────

export interface StrategyParamMeta {
  /** Must match a key in `ParamDef`. */
  key: string;
  /** Human-readable label shown in the inspector. */
  label: string;
  /** What this parameter controls and how it affects behaviour. */
  description: string;
  /** Optional unit string shown alongside the value (e.g. "candles", "%"). */
  unit?: string;
}

/**
 * Display-only strategy metadata for the BotInspector Strategy section.
 * Does not affect engine logic, execution, or test determinism.
 *
 * Future: `evolutionLineage` and `changeLog` fields are reserved for
 * strategy versioning and evolution tracking (not implemented in v0.1).
 */
export interface StrategyMeta {
  /** One-sentence plain-English description of what this strategy does. */
  summary: string;
  /** When the bot buys (entry condition). */
  entryRule: string;
  /** When the bot sells (exit condition). */
  exitRule: string;
  /** Descriptions for each tunable parameter. */
  params: StrategyParamMeta[];
  /** Known weaknesses, edge cases, or assumptions to be aware of. */
  riskNotes?: string;
  // Future stubs (not used in v0.1):
  // evolutionLineage?: string[];
  // changeLog?: Array<{ version: string; date: string; description: string }>;
}

// ─── BotDef ───────────────────────────────────────────────────────────────────

export interface BotDef {
  id: string;
  name: string;
  strategy: StrategyDefinition;
  paramDefs: ParamDef[];
  meta: StrategyMeta;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

export const BOT_REGISTRY: BotDef[] = [
  {
    id: "bah",
    name: "Buy & Hold",
    strategy: buyAndHold,
    paramDefs: [],
    meta: {
      summary: "Buys 99% of starting equity on the very first candle and holds until the match ends.",
      entryRule: "Buy on candle 1 if no position is held.",
      exitRule: "Never sells — holds through the entire match.",
      params: [],
      riskNotes:
        "Fully exposed to drawdown for the entire period. No stop-loss, no profit-taking. " +
        "Performs well in strong uptrends; suffers in sideways or declining markets. " +
        "Useful as a passive benchmark: any active strategy should beat it on risk-adjusted terms.",
    },
  },
  {
    id: "mac",
    name: "MA Crossover",
    strategy: movingAverageCrossover,
    paramDefs: [
      { key: "shortPeriod", label: "Short Period", min: 2, max: 50, step: 1, defaultValue: 10 },
      { key: "longPeriod", label: "Long Period", min: 5, max: 200, step: 1, defaultValue: 30 },
    ],
    meta: {
      summary:
        "A classic trend-following strategy that uses two simple moving averages. " +
        "It buys when the fast average crosses above the slow average (uptrend signal) " +
        "and sells when it crosses back below.",
      entryRule:
        "Buy (full equity allocation) when the short-period SMA crosses above the long-period SMA.",
      exitRule:
        "Close position when the short-period SMA crosses below the long-period SMA.",
      params: [
        {
          key: "shortPeriod",
          label: "Short Period",
          description:
            "Number of candles for the fast moving average. Smaller values react faster to price changes " +
            "but generate more noise and false signals.",
          unit: "candles",
        },
        {
          key: "longPeriod",
          label: "Long Period",
          description:
            "Number of candles for the slow moving average. Must be greater than the short period. " +
            "Larger values filter out short-term noise but delay entry and exit signals.",
          unit: "candles",
        },
      ],
      riskNotes:
        "Whipsaws frequently in sideways/choppy markets — generates many small losses. " +
        "Requires at least `longPeriod` candles of history before any signal is possible. " +
        "Works best on trending instruments over long periods.",
    },
  },
  {
    id: "mom",
    name: "Momentum",
    strategy: momentum,
    paramDefs: [
      { key: "period", label: "Period", min: 5, max: 100, step: 1, defaultValue: 20 },
      { key: "threshold", label: "Threshold", min: 0.001, max: 0.2, step: 0.001, defaultValue: 0.02 },
    ],
    meta: {
      summary:
        "Bets that recent winners keep winning. Enters when the price return over a lookback " +
        "window exceeds a threshold, exits when momentum fades.",
      entryRule:
        "Buy when the return over the last `period` candles exceeds `threshold` (e.g. +2%).",
      exitRule:
        "Close position when the momentum return falls below `threshold`.",
      params: [
        {
          key: "period",
          label: "Period",
          description:
            "Lookback window for computing momentum: (close[now] − close[now−period]) / close[now−period]. " +
            "Longer periods capture bigger trends; shorter periods react to recent moves.",
          unit: "candles",
        },
        {
          key: "threshold",
          label: "Threshold",
          description:
            "Minimum fractional return required to trigger a buy signal. " +
            "E.g. 0.02 = the price must have risen at least 2% over the lookback period.",
          unit: "fraction",
        },
      ],
      riskNotes:
        "Prone to buying near the top of a move — momentum is often highest just before a reversal. " +
        "Performance degrades significantly in mean-reverting or volatile markets. " +
        "Requires `period` candles of warm-up before any signal fires.",
    },
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
    meta: {
      summary:
        "Bets that prices revert to their rolling mean after a deviation. " +
        "Buys on statistically significant dips and sells when the price recovers.",
      entryRule:
        "Buy when price is more than `zBuy` standard deviations below its `period`-candle rolling mean " +
        "(i.e. z-score ≤ −zBuy).",
      exitRule:
        "Close position when the z-score rises back above `zSell` (typically 0 = at the mean).",
      params: [
        {
          key: "period",
          label: "Period",
          description:
            "Lookback window for computing the rolling mean and standard deviation. " +
            "Shorter periods are more sensitive to recent volatility; longer periods require bigger deviations to signal.",
          unit: "candles",
        },
        {
          key: "zBuy",
          label: "Z-Buy",
          description:
            "How many standard deviations below the mean the price must fall before a buy signal fires. " +
            "Higher values (e.g. 2.0) signal rarer, deeper dips; lower values signal more frequently.",
          unit: "σ",
        },
        {
          key: "zSell",
          label: "Z-Sell",
          description:
            "Z-score at which the position is closed. 0 = exit at the rolling mean. " +
            "Positive values wait for a full recovery; negative values exit while still below the mean.",
          unit: "σ",
        },
      ],
      riskNotes:
        "Performs poorly in strongly trending markets — a falling price that keeps falling looks like " +
        "a deeper and deeper dip, causing repeated buys into a declining asset (averaging down). " +
        "Standard deviation can be unstable on short lookback windows or with low-volume data.",
    },
  },
  {
    id: "rnd",
    name: "Random",
    strategy: randomBaseline,
    paramDefs: [
      { key: "buyProb", label: "Buy Prob", min: 0.01, max: 0.5, step: 0.01, defaultValue: 0.05 },
      { key: "sellProb", label: "Sell Prob", min: 0.01, max: 0.5, step: 0.01, defaultValue: 0.1 },
    ],
    meta: {
      summary:
        "A seeded random baseline. On each candle it independently rolls the dice to decide " +
        "whether to buy or sell. Provides a floor benchmark: any real strategy should beat it consistently.",
      entryRule: "Each candle: buy with probability `buyProb` (if flat).",
      exitRule:  "Each candle: sell with probability `sellProb` (if holding).",
      params: [
        {
          key: "buyProb",
          label: "Buy Probability",
          description:
            "Probability of issuing a buy order on any given candle when flat. " +
            "At 0.05, the bot buys roughly once every 20 candles on average.",
          unit: "probability",
        },
        {
          key: "sellProb",
          label: "Sell Probability",
          description:
            "Probability of closing the position on any given candle when holding. " +
            "At 0.10, the bot exits roughly once every 10 candles on average.",
          unit: "probability",
        },
      ],
      riskNotes:
        "Deliberately uninformed. Its purpose is to set a statistical floor: " +
        "a strategy that cannot reliably beat this baseline is essentially guessing. " +
        "The seed is fixed per match for reproducibility.",
    },
  },
];
