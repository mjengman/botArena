import { createSimulation } from "../engine/simulation.ts";
import { sampleDataset } from "../data/sampleDataset.ts";
import { buyAndHold } from "../strategies/buyAndHold.ts";
import { movingAverageCrossover } from "../strategies/movingAverageCrossover.ts";
import { momentum } from "../strategies/momentum.ts";
import { meanReversion } from "../strategies/meanReversion.ts";
import { randomBaseline } from "../strategies/randomBaseline.ts";
import type { BotSpec, SimulationConfig } from "../engine/types.ts";

const config: SimulationConfig = {
  startingCash: 10_000,
  feeBps: 5,      // 0.05%
  slippageBps: 3, // 0.03%
  seed: 42,
};

const botSpecs: BotSpec[] = [
  { id: "bah",  name: "Buy & Hold",     strategy: buyAndHold },
  { id: "mac",  name: "MA Crossover",   strategy: movingAverageCrossover },
  { id: "mom",  name: "Momentum",       strategy: momentum },
  { id: "mr",   name: "Mean Reversion", strategy: meanReversion },
  { id: "rnd",  name: "Random",         strategy: randomBaseline },
];

console.log("─".repeat(60));
console.log("  BOT ARENA — Match Runner");
console.log("─".repeat(60));
console.log(`  Dataset : ${sampleDataset.manifest.symbol} (${sampleDataset.manifest.timeframe})`);
console.log(`  Period  : ${sampleDataset.manifest.startDate} → ${sampleDataset.manifest.endDate}`);
console.log(`  Candles : ${sampleDataset.manifest.candleCount}`);
console.log(`  Cash    : $${config.startingCash.toLocaleString()}`);
console.log(`  Fee     : ${config.feeBps}bps  Slippage: ${config.slippageBps}bps`);
console.log("─".repeat(60));

const sim = createSimulation(config, sampleDataset, botSpecs);
const t0 = performance.now();
sim.runToEnd();
const elapsed = (performance.now() - t0).toFixed(1);

const standings = sim.getStandings();
const events = sim.getEvents();

console.log("\n  FINAL STANDINGS\n");
console.log(
  "  " +
  "Rank".padEnd(6) +
  "Bot".padEnd(20) +
  "Return".padStart(10) +
  "Equity".padStart(12) +
  "MaxDD".padStart(9) +
  "WinRate".padStart(9) +
  "Trades".padStart(8),
);
console.log("  " + "─".repeat(72));

for (const s of standings) {
  const ret = (s.totalReturn * 100).toFixed(2) + "%";
  const equity = "$" + s.finalEquity.toFixed(2);
  const dd = (s.maxDrawdown * 100).toFixed(2) + "%";
  const wr = (s.winRate * 100).toFixed(1) + "%";
  console.log(
    "  " +
    String(s.rank).padEnd(6) +
    s.botName.padEnd(20) +
    ret.padStart(10) +
    equity.padStart(12) +
    dd.padStart(9) +
    wr.padStart(9) +
    String(s.tradeCount).padStart(8),
  );
}

console.log("\n" + "─".repeat(60));
console.log(`  Events emitted : ${events.length}`);
console.log(`  Run time       : ${elapsed}ms`);
console.log("─".repeat(60) + "\n");
