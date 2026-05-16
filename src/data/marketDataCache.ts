/**
 * localStorage cache for fetched market datasets.
 *
 * Key format: bot-arena:mkt:alpaca:{SYMBOL}:1d:{startDate}:{endDate}:iex
 *
 * IMPORTANT: API keys are NEVER included in the cache key or stored value.
 * Only the normalized Dataset (symbol, candles, manifest) is persisted.
 */

import type { Dataset } from "../engine/types.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CacheEntry {
  fetchedAt: string;  // ISO datetime string
  dataset: Dataset;
}

// ─── Key helpers ──────────────────────────────────────────────────────────────

export function cacheKey(symbol: string, startDate: string, endDate: string): string {
  return `bot-arena:mkt:alpaca:${symbol.toUpperCase()}:1d:${startDate}:${endDate}:iex`;
}

const CACHE_PREFIX = "bot-arena:mkt:";

// ─── CRUD ─────────────────────────────────────────────────────────────────────

/** Returns null on cache miss or JSON parse error. */
export function getCachedDataset(
  symbol: string,
  startDate: string,
  endDate: string,
): CacheEntry | null {
  try {
    const key = cacheKey(symbol, startDate, endDate);
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as CacheEntry;
  } catch {
    return null;
  }
}

/** Silently swallows quota errors and other storage failures. */
export function setCachedDataset(
  symbol: string,
  startDate: string,
  endDate: string,
  dataset: Dataset,
): void {
  try {
    const key = cacheKey(symbol, startDate, endDate);
    const entry: CacheEntry = {
      fetchedAt: new Date().toISOString(),
      dataset,
    };
    localStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // Swallow quota exceeded and other storage errors
  }
}

/** Removes all bot-arena:mkt: keys. Returns count of keys removed. */
export function clearMarketDataCache(): number {
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(CACHE_PREFIX)) {
      keysToRemove.push(k);
    }
  }
  for (const k of keysToRemove) {
    localStorage.removeItem(k);
  }
  return keysToRemove.length;
}

/** Returns a summary of all cached entries for display in the UI. */
export function listCachedEntries(): Array<{
  key: string;
  fetchedAt: string;
  symbol: string;
  candleCount: number;
}> {
  const results: Array<{ key: string; fetchedAt: string; symbol: string; candleCount: number }> = [];

  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith(CACHE_PREFIX)) continue;

    try {
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      const entry = JSON.parse(raw) as CacheEntry;
      results.push({
        key: k,
        fetchedAt: entry.fetchedAt,
        symbol: entry.dataset.manifest.symbol,
        candleCount: entry.dataset.manifest.candleCount,
      });
    } catch {
      // Skip unparseable entries
    }
  }

  return results;
}
