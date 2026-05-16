import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  validateMarketDataRequest,
  fetchAlpacaBars,
  type MarketDataRequest,
} from "../src/data/providers/alpacaMarketData.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(overrides: Partial<MarketDataRequest> = {}): MarketDataRequest {
  return {
    symbol: "SPY",
    startDate: "2023-01-01",
    endDate: "2023-12-31",
    timeframe: "1d",
    feed: "iex",
    ...overrides,
  };
}

const CREDS = { apiKey: "test-key", apiSecret: "test-secret" };

function makeBar(dateStr: string, price = 100, vol = 50000) {
  return { t: `${dateStr}T00:00:00Z`, o: price, h: price + 2, l: price - 2, c: price + 1, v: vol };
}

// ─── validateMarketDataRequest ────────────────────────────────────────────────

describe("validateMarketDataRequest", () => {
  it("returns empty array for a valid request", () => {
    const errors = validateMarketDataRequest(makeReq());
    expect(errors).toHaveLength(0);
  });

  it("returns error for empty symbol", () => {
    const errors = validateMarketDataRequest(makeReq({ symbol: "" }));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /symbol/i.test(e))).toBe(true);
  });

  it("returns error for whitespace-only symbol", () => {
    const errors = validateMarketDataRequest(makeReq({ symbol: "   " }));
    expect(errors.length).toBeGreaterThan(0);
  });

  it("returns error when startDate is after endDate", () => {
    const errors = validateMarketDataRequest(makeReq({ startDate: "2023-12-01", endDate: "2023-01-01" }));
    expect(errors.some((e) => /start/i.test(e))).toBe(true);
  });

  it("returns error when startDate equals endDate", () => {
    const errors = validateMarketDataRequest(makeReq({ startDate: "2023-06-01", endDate: "2023-06-01" }));
    expect(errors.some((e) => /start/i.test(e))).toBe(true);
  });

  it("returns error for invalid startDate format", () => {
    const errors = validateMarketDataRequest(makeReq({ startDate: "01/01/2023" }));
    expect(errors.some((e) => /start/i.test(e))).toBe(true);
  });

  it("returns error for invalid endDate format", () => {
    const errors = validateMarketDataRequest(makeReq({ endDate: "not-a-date" }));
    expect(errors.some((e) => /end/i.test(e))).toBe(true);
  });
});

// ─── fetchAlpacaBars — mocked fetch ───────────────────────────────────────────

describe("fetchAlpacaBars", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a Dataset with correct manifest for a typical response", async () => {
    const bars = [
      makeBar("2023-01-03", 380),
      makeBar("2023-01-04", 382),
      makeBar("2023-01-05", 385),
    ];

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ bars, next_page_token: null, symbol: "SPY" }),
    }));

    const dataset = await fetchAlpacaBars(makeReq(), CREDS);

    expect(dataset.manifest.symbol).toBe("SPY");
    expect(dataset.manifest.source).toBe("alpaca");
    expect(dataset.manifest.feed).toBe("iex");
    expect(dataset.manifest.timeframe).toBe("1d");
    expect(dataset.manifest.candleCount).toBe(3);
  });

  it("normalizes candle timestamps to Unix ms", async () => {
    const bars = [makeBar("2023-01-03", 380)];

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ bars, next_page_token: null, symbol: "SPY" }),
    }));

    const dataset = await fetchAlpacaBars(makeReq(), CREDS);
    const ts = dataset.candles[0]!.timestamp;
    expect(typeof ts).toBe("number");
    expect(ts).toBe(Date.parse("2023-01-03T00:00:00Z"));
  });

  it("sorts candles ascending by timestamp even if server returns out-of-order", async () => {
    const bars = [
      makeBar("2023-01-05", 385),
      makeBar("2023-01-03", 380),
      makeBar("2023-01-04", 382),
    ];

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ bars, next_page_token: null, symbol: "SPY" }),
    }));

    const dataset = await fetchAlpacaBars(makeReq(), CREDS);
    expect(dataset.candles[0]!.timestamp).toBeLessThan(dataset.candles[1]!.timestamp);
    expect(dataset.candles[1]!.timestamp).toBeLessThan(dataset.candles[2]!.timestamp);
  });

  it("handles pagination — calls fetch twice when next_page_token is present", async () => {
    const bars1 = [makeBar("2023-01-03", 380), makeBar("2023-01-04", 382)];
    const bars2 = [makeBar("2023-01-05", 385)];

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ bars: bars1, next_page_token: "token-abc", symbol: "SPY" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ bars: bars2, next_page_token: null, symbol: "SPY" }),
      });

    vi.stubGlobal("fetch", mockFetch);

    const dataset = await fetchAlpacaBars(makeReq(), CREDS);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(dataset.manifest.candleCount).toBe(3);
  });

  it("throws with status code in message on HTTP 401", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "unauthorized",
    }));

    await expect(fetchAlpacaBars(makeReq(), CREDS)).rejects.toThrow(/401/);
  });

  it("throws with helpful message when 0 bars returned", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ bars: [], next_page_token: null, symbol: "SPY" }),
    }));

    await expect(fetchAlpacaBars(makeReq(), CREDS)).rejects.toThrow(/no bars/i);
  });

  it("throws when fetch returns malformed JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => { throw new SyntaxError("Unexpected token"); },
    }));

    await expect(fetchAlpacaBars(makeReq(), CREDS)).rejects.toThrow();
  });

  it("throws on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(fetchAlpacaBars(makeReq(), CREDS)).rejects.toThrow(/network|failed to fetch/i);
  });

  it("uppercases symbol in manifest", async () => {
    const bars = [makeBar("2023-01-03", 380)];

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ bars, next_page_token: null, symbol: "spy" }),
    }));

    const dataset = await fetchAlpacaBars(makeReq({ symbol: "spy" }), CREDS);
    expect(dataset.manifest.symbol).toBe("SPY");
  });
});
