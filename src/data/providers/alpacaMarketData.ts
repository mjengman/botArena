/**
 * Alpaca historical market data provider.
 *
 * Uses the Alpaca Data API v2 to fetch daily OHLCV bars.
 * Data API base URL is always https://data.alpaca.markets — separate from
 * the paper/live trading API. The same apiKey/apiSecret used for paper
 * trading also authenticates data requests.
 *
 * Adjustment: "split" — split-adjusted closing prices so historical price
 * series remain continuous across stock splits. Dividend adjustment is not
 * applied (use "all" in a future milestone if total-return accuracy matters).
 *
 * Feed: "iex" — Investors Exchange, Alpaca's free-tier data source.
 * IEX volume is partial-market volume (typically 2–5% of total market share)
 * and can skew volume-sensitive strategies. Full SIP consolidated data
 * requires an Alpaca premium subscription.
 *
 * Pagination: Alpaca returns up to 10,000 bars per page. For daily bars over
 * typical date ranges (1–5 years ≈ 252–1260 bars) a single page suffices.
 * The fetcher handles next_page_token for longer ranges.
 */

import type { Dataset, Candle } from "../../engine/types.ts";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface MarketDataRequest {
  symbol: string;
  startDate: string;
  endDate: string;
  timeframe: "1d";
  feed: "iex";
}

// ─── Validation ───────────────────────────────────────────────────────────────

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Calendar round-trip check — same pattern as csvImport.ts parseDate().
 * JS Date.UTC silently normalises impossible dates (e.g. Feb 31 → Mar 3),
 * so a regex match on its own is not sufficient. We reconstruct the date
 * from its UTC components and compare back to the parsed integers.
 *
 * Precondition: dateStr has already matched ISO_DATE_RE.
 */
function isCalendarValid(dateStr: string): boolean {
  const y = parseInt(dateStr.slice(0, 4), 10);
  const m = parseInt(dateStr.slice(5, 7), 10);
  const d = parseInt(dateStr.slice(8, 10), 10);
  const ts = Date.UTC(y, m - 1, d);
  const check = new Date(ts);
  return (
    check.getUTCFullYear() === y &&
    check.getUTCMonth() + 1 === m &&
    check.getUTCDate() === d
  );
}

/** Returns array of error messages. Empty array means the request is valid. */
export function validateMarketDataRequest(req: MarketDataRequest): string[] {
  const errors: string[] = [];

  if (!req.symbol || req.symbol.trim().length === 0) {
    errors.push("Symbol must not be empty.");
  }

  if (!ISO_DATE_RE.test(req.startDate)) {
    errors.push(`Start date "${req.startDate}" is not a valid YYYY-MM-DD date.`);
  } else if (!isCalendarValid(req.startDate)) {
    errors.push(`Start date "${req.startDate}" is not a real calendar date (e.g. Feb 31 does not exist).`);
  }

  if (!ISO_DATE_RE.test(req.endDate)) {
    errors.push(`End date "${req.endDate}" is not a valid YYYY-MM-DD date.`);
  } else if (!isCalendarValid(req.endDate)) {
    errors.push(`End date "${req.endDate}" is not a real calendar date (e.g. Feb 31 does not exist).`);
  }

  // Only compare dates if both passed syntax + calendar validation
  const startOk = ISO_DATE_RE.test(req.startDate) && isCalendarValid(req.startDate);
  const endOk   = ISO_DATE_RE.test(req.endDate)   && isCalendarValid(req.endDate);
  if (startOk && endOk) {
    if (req.startDate >= req.endDate) {
      errors.push("Start date must be before end date.");
    }
  }

  // Warn if end date is in the future
  const today = new Date().toISOString().slice(0, 10);
  if (endOk && req.endDate > today) {
    errors.push(`End date "${req.endDate}" is in the future. Use today or an earlier date.`);
  }

  return errors;
}

// ─── Alpaca bar shape ─────────────────────────────────────────────────────────

interface AlpacaBar {
  t: string;  // ISO datetime string
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

interface AlpacaBarsResponse {
  bars: AlpacaBar[];
  next_page_token: string | null;
  symbol: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toIsoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function buildGapMetadata(candles: Candle[]): { gapCount?: number; gapDates?: string[] } {
  if (candles.length < 2) return {};
  const DAY_MS = 86_400_000;
  const gapDates: string[] = [];
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i]!.timestamp - candles[i - 1]!.timestamp;
    if (delta > DAY_MS + 60_000) {
      gapDates.push(toIsoDate(candles[i - 1]!.timestamp));
    }
  }
  if (gapDates.length === 0) return {};
  return { gapCount: gapDates.length, gapDates };
}

// ─── Fetcher ──────────────────────────────────────────────────────────────────

/**
 * Fetch daily OHLCV bars from the Alpaca Data API and return a Dataset.
 *
 * Throws on HTTP errors, empty results, or network failures.
 */
export async function fetchAlpacaBars(
  req: MarketDataRequest,
  credentials: { apiKey: string; apiSecret: string },
): Promise<Dataset> {
  const BASE_URL = "https://data.alpaca.markets";
  const symbol = req.symbol.trim().toUpperCase();

  const allBars: AlpacaBar[] = [];
  let nextPageToken: string | null = null;

  do {
    const params = new URLSearchParams({
      timeframe: "1Day",
      feed: req.feed,
      adjustment: "split",
      start: req.startDate,
      end: req.endDate,
      limit: "10000",
    });
    if (nextPageToken) {
      params.set("page_token", nextPageToken);
    }

    const url = `${BASE_URL}/v2/stocks/${encodeURIComponent(symbol)}/bars?${params.toString()}`;

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          "APCA-API-KEY-ID": credentials.apiKey,
          "APCA-API-SECRET-KEY": credentials.apiSecret,
        },
      });
    } catch (err) {
      throw new Error(
        `Network error fetching bars for ${symbol}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!response.ok) {
      let bodyText = "";
      try {
        bodyText = await response.text();
      } catch {
        // ignore body read errors
      }
      const detail = bodyText ? ` — ${bodyText}` : "";
      throw new Error(
        `Alpaca API error ${response.status} fetching bars for ${symbol}${detail}`,
      );
    }

    let data: AlpacaBarsResponse;
    try {
      data = (await response.json()) as AlpacaBarsResponse;
    } catch (err) {
      throw new Error(
        `Failed to parse Alpaca response for ${symbol}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    allBars.push(...(data.bars ?? []));
    nextPageToken = data.next_page_token ?? null;
  } while (nextPageToken !== null);

  if (allBars.length === 0) {
    throw new Error(
      `No bars returned for ${symbol} ${req.startDate}–${req.endDate} — check symbol, date range, and credentials`,
    );
  }

  // Normalize to Candle[]
  const candles: Candle[] = allBars.map((bar) => ({
    timestamp: Date.parse(bar.t),
    open: bar.o,
    high: bar.h,
    low: bar.l,
    close: bar.c,
    volume: bar.v,
  }));

  // Sort ascending by timestamp
  candles.sort((a, b) => a.timestamp - b.timestamp);

  const gapMeta = buildGapMetadata(candles);

  const manifest = {
    symbol,
    timeframe: "1d",
    source: "alpaca",
    feed: "iex",
    startDate: toIsoDate(candles[0]!.timestamp),
    endDate: toIsoDate(candles[candles.length - 1]!.timestamp),
    candleCount: candles.length,
    ...gapMeta,
  };

  return { manifest, candles };
}
