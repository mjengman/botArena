import type { Dataset } from "../engine/types.ts";

// 504 trading-day synthetic OHLCV series for "ARENA" (2-year daily).
// Generated from a seeded geometric Brownian motion so it is deterministic
// and carries enough volatility to test strategies meaningfully.

function generateCandles(): Dataset["candles"] {
  const START_PRICE = 100;
  const DRIFT = 0.0003;      // ~7.5% annualised
  const VOLATILITY = 0.012;  // ~19% annualised
  const START_DATE = new Date("2022-01-03");
  const DAY_MS = 86_400_000;

  // Mulberry32 seeded PRNG
  let seed = 0xdeadbeef;
  function rand(): number {
    seed += 0x6d2b79f5;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  }

  function boxMullerNormal(): number {
    const u1 = rand();
    const u2 = rand();
    return Math.sqrt(-2 * Math.log(u1 + 1e-12)) * Math.cos(2 * Math.PI * u2);
  }

  const candles: Dataset["candles"] = [];
  let price = START_PRICE;
  let date = new Date(START_DATE);
  let tradingDay = 0;

  while (tradingDay < 504) {
    const day = date.getDay();
    // Skip weekends
    if (day === 0 || day === 6) {
      date = new Date(date.getTime() + DAY_MS);
      continue;
    }

    const daily = DRIFT + VOLATILITY * boxMullerNormal();
    const open = price;
    const close = Math.max(0.01, price * Math.exp(daily));
    const intraday = VOLATILITY * 0.6 * Math.abs(boxMullerNormal());
    const high = Math.max(open, close) * (1 + intraday);
    const low = Math.min(open, close) * (1 - intraday);
    const volume = Math.floor(1_000_000 * (0.5 + rand()));

    candles.push({
      timestamp: date.getTime(),
      open: +open.toFixed(4),
      high: +high.toFixed(4),
      low: +low.toFixed(4),
      close: +close.toFixed(4),
      volume,
    });

    price = close;
    date = new Date(date.getTime() + DAY_MS);
    tradingDay++;
  }

  return candles;
}

const candles = generateCandles();

export const sampleDataset: Dataset = {
  manifest: {
    symbol: "ARENA",
    timeframe: "1d",
    source: "synthetic-gbm-seed-0xdeadbeef",
    startDate: new Date(candles[0]!.timestamp).toISOString().slice(0, 10),
    endDate: new Date(candles[candles.length - 1]!.timestamp).toISOString().slice(0, 10),
    candleCount: candles.length,
  },
  candles,
};
