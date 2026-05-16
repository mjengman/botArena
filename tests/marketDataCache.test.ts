// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import {
  cacheKey,
  getCachedDataset,
  setCachedDataset,
  clearMarketDataCache,
  listCachedEntries,
} from "../src/data/marketDataCache.ts";
import type { Dataset } from "../src/engine/types.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDataset(symbol = "SPY", candleCount = 3): Dataset {
  const candles = Array.from({ length: candleCount }, (_, i) => ({
    timestamp: Date.UTC(2023, 0, i + 3),
    open: 380,
    high: 382,
    low: 378,
    close: 381,
    volume: 50000,
  }));
  return {
    manifest: {
      symbol,
      timeframe: "1d",
      source: "alpaca",
      feed: "iex",
      startDate: "2023-01-03",
      endDate: `2023-01-0${2 + candleCount}`,
      candleCount,
    },
    candles,
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  // Clear all bot-arena:mkt: keys before each test
  clearMarketDataCache();
});

// ─── cacheKey ─────────────────────────────────────────────────────────────────

describe("cacheKey", () => {
  it("returns expected key format", () => {
    const key = cacheKey("SPY", "2023-01-01", "2023-12-31");
    expect(key).toBe("bot-arena:mkt:alpaca:SPY:1d:2023-01-01:2023-12-31:iex");
  });

  it("uppercases symbol in key", () => {
    const key = cacheKey("spy", "2023-01-01", "2023-12-31");
    expect(key).toBe("bot-arena:mkt:alpaca:SPY:1d:2023-01-01:2023-12-31:iex");
  });
});

// ─── getCachedDataset / setCachedDataset ──────────────────────────────────────

describe("getCachedDataset", () => {
  it("returns null on cache miss", () => {
    const result = getCachedDataset("AAPL", "2023-01-01", "2023-12-31");
    expect(result).toBeNull();
  });

  it("round-trips a dataset through set/get", () => {
    const dataset = makeDataset("SPY", 3);
    setCachedDataset("SPY", "2023-01-03", "2023-01-05", dataset);
    const entry = getCachedDataset("SPY", "2023-01-03", "2023-01-05");
    expect(entry).not.toBeNull();
    expect(entry!.dataset.manifest.symbol).toBe("SPY");
    expect(entry!.dataset.manifest.candleCount).toBe(3);
    expect(entry!.dataset.candles).toHaveLength(3);
  });

  it("returns null for corrupted JSON", () => {
    const key = cacheKey("SPY", "2023-01-01", "2023-12-31");
    localStorage.setItem(key, "{ not valid json");
    const result = getCachedDataset("SPY", "2023-01-01", "2023-12-31");
    expect(result).toBeNull();
  });

  it("stores fetchedAt as ISO string", () => {
    const dataset = makeDataset("SPY", 3);
    setCachedDataset("SPY", "2023-01-03", "2023-01-05", dataset);
    const entry = getCachedDataset("SPY", "2023-01-03", "2023-01-05");
    expect(entry).not.toBeNull();
    expect(typeof entry!.fetchedAt).toBe("string");
    expect(entry!.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ─── clearMarketDataCache ─────────────────────────────────────────────────────

describe("clearMarketDataCache", () => {
  it("removes all bot-arena:mkt: keys and returns count", () => {
    setCachedDataset("SPY", "2023-01-01", "2023-06-30", makeDataset("SPY", 2));
    setCachedDataset("AAPL", "2023-01-01", "2023-06-30", makeDataset("AAPL", 2));
    const count = clearMarketDataCache();
    expect(count).toBe(2);
    expect(getCachedDataset("SPY", "2023-01-01", "2023-06-30")).toBeNull();
    expect(getCachedDataset("AAPL", "2023-01-01", "2023-06-30")).toBeNull();
  });

  it("does not remove unrelated localStorage keys", () => {
    localStorage.setItem("some-other-key", "value");
    setCachedDataset("SPY", "2023-01-01", "2023-06-30", makeDataset("SPY", 2));
    clearMarketDataCache();
    expect(localStorage.getItem("some-other-key")).toBe("value");
    // Clean up
    localStorage.removeItem("some-other-key");
  });

  it("returns 0 when cache is already empty", () => {
    const count = clearMarketDataCache();
    expect(count).toBe(0);
  });
});

// ─── listCachedEntries ────────────────────────────────────────────────────────

describe("listCachedEntries", () => {
  it("returns empty array when cache is empty", () => {
    const entries = listCachedEntries();
    expect(entries).toHaveLength(0);
  });

  it("lists all cached entries with correct fields", () => {
    setCachedDataset("SPY", "2023-01-01", "2023-06-30", makeDataset("SPY", 5));
    setCachedDataset("AAPL", "2023-01-01", "2023-06-30", makeDataset("AAPL", 10));
    const entries = listCachedEntries();
    expect(entries).toHaveLength(2);
    const symbols = entries.map((e) => e.symbol).sort();
    expect(symbols).toEqual(["AAPL", "SPY"]);
    const spy = entries.find((e) => e.symbol === "SPY")!;
    expect(spy.candleCount).toBe(5);
    expect(typeof spy.fetchedAt).toBe("string");
    expect(typeof spy.key).toBe("string");
  });

  it("skips unparseable entries gracefully", () => {
    setCachedDataset("SPY", "2023-01-01", "2023-06-30", makeDataset("SPY", 3));
    // Inject a bad entry with the right prefix
    localStorage.setItem("bot-arena:mkt:bad-entry", "not-json");
    const entries = listCachedEntries();
    // Should still list SPY but not crash
    expect(entries.some((e) => e.symbol === "SPY")).toBe(true);
    // Clean up
    localStorage.removeItem("bot-arena:mkt:bad-entry");
  });
});
