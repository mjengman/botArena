import { describe, it, expect } from "vitest";
import { importCsv, CsvImportError } from "../src/data/csvImport.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function row(
  date: string,
  open = 100,
  high = 110,
  low = 90,
  close = 105,
  volume = 1000,
) {
  return `${date},${open},${high},${low},${close},${volume}`;
}

const HEADER = "date,open,high,low,close,volume";

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join("\n");
}

// ─── Happy-path parsing ───────────────────────────────────────────────────────

describe("importCsv — happy path", () => {
  it("parses a minimal valid CSV", () => {
    const input = csv(row("2022-01-03"), row("2022-01-04"), row("2022-01-05"));
    const { dataset, warnings } = importCsv(input);
    expect(dataset.candles).toHaveLength(3);
    expect(warnings).toHaveLength(0);
  });

  it("populates manifest fields correctly", () => {
    const input = csv(row("2022-01-03"), row("2022-01-04"));
    const { dataset } = importCsv(input, { symbol: "AAPL" });
    expect(dataset.manifest.symbol).toBe("AAPL");
    expect(dataset.manifest.timeframe).toBe("1d");
    expect(dataset.manifest.source).toBe("csv-import");
    expect(dataset.manifest.startDate).toBe("2022-01-03");
    expect(dataset.manifest.endDate).toBe("2022-01-04");
    expect(dataset.manifest.candleCount).toBe(2);
  });

  it("sets candle fields from CSV values", () => {
    const input = csv("2022-01-03,101,112,89,105,50000");
    const { dataset } = importCsv(input);
    const c = dataset.candles[0]!;
    expect(c.open).toBe(101);
    expect(c.high).toBe(112);
    expect(c.low).toBe(89);
    expect(c.close).toBe(105);
    expect(c.volume).toBe(50000);
  });

  it("timestamps are UTC midnight", () => {
    const input = csv(row("2022-01-03"));
    const { dataset } = importCsv(input);
    expect(dataset.candles[0]!.timestamp).toBe(Date.UTC(2022, 0, 3));
  });

  it("accepts headers in any column order", () => {
    const reordered = "volume,close,low,high,open,date\n1000,105,90,110,100,2022-01-03";
    const { dataset } = importCsv(reordered);
    const c = dataset.candles[0]!;
    expect(c.open).toBe(100);
    expect(c.close).toBe(105);
    expect(c.volume).toBe(1000);
  });

  it("accepts case-insensitive headers", () => {
    const input = "Date,Open,High,Low,Close,Volume\n2022-01-03,100,110,90,105,1000";
    const { dataset } = importCsv(input);
    expect(dataset.candles).toHaveLength(1);
  });

  it("accepts 'Adj Close' as the close column", () => {
    const input = "date,open,high,low,adj close,volume\n2022-01-03,100,110,90,107,1000";
    const { dataset } = importCsv(input);
    expect(dataset.candles[0]!.close).toBe(107);
  });

  it("defaults volume to 0 when column is absent", () => {
    const input = "date,open,high,low,close\n2022-01-03,100,110,90,105";
    const { dataset } = importCsv(input);
    expect(dataset.candles[0]!.volume).toBe(0);
  });

  it("strips BOM from file start", () => {
    const input = "﻿" + csv(row("2022-01-03"));
    const { dataset } = importCsv(input);
    expect(dataset.candles).toHaveLength(1);
  });

  it("strips thousands separators from numeric fields", () => {
    // Quoted CSV fields with comma thousands separators (common in spreadsheet exports)
    const clean = 'date,open,high,low,close,volume\n2022-01-03,"1,000","1,100",900,"1,050","50,000"';
    const { dataset } = importCsv(clean);
    expect(dataset.candles[0]!.open).toBe(1000);
    expect(dataset.candles[0]!.volume).toBe(50000);
  });

  it("handles Windows line endings (CRLF)", () => {
    const input = "date,open,high,low,close,volume\r\n2022-01-03,100,110,90,105,1000\r\n2022-01-04,105,115,95,110,2000";
    const { dataset } = importCsv(input);
    expect(dataset.candles).toHaveLength(2);
  });

  it("skips blank lines within the file", () => {
    const input = "date,open,high,low,close,volume\n2022-01-03,100,110,90,105,1000\n\n2022-01-05,105,115,95,110,2000";
    const { dataset } = importCsv(input);
    expect(dataset.candles).toHaveLength(2);
  });

  it("accepts ISO datetime strings (truncates to date)", () => {
    const input = "date,open,high,low,close,volume\n2022-01-03T00:00:00Z,100,110,90,105,1000";
    const { dataset } = importCsv(input);
    expect(dataset.candles[0]!.timestamp).toBe(Date.UTC(2022, 0, 3));
  });

  it("accepts MM/DD/YYYY date format", () => {
    const input = "date,open,high,low,close,volume\n01/03/2022,100,110,90,105,1000";
    const { dataset } = importCsv(input);
    expect(dataset.candles[0]!.timestamp).toBe(Date.UTC(2022, 0, 3));
  });
});

// ─── Symbol derivation ────────────────────────────────────────────────────────

describe("importCsv — symbol derivation", () => {
  it("uses explicit symbol option", () => {
    const { dataset } = importCsv(csv(row("2022-01-03")), { symbol: "msft" });
    expect(dataset.manifest.symbol).toBe("MSFT");
  });

  it("derives symbol from filename (strips extension)", () => {
    const { dataset } = importCsv(csv(row("2022-01-03")), { filename: "TSLA_daily.csv" });
    expect(dataset.manifest.symbol).toBe("TSLA");
  });

  it("falls back to IMPORTED when no hint is given", () => {
    const { dataset } = importCsv(csv(row("2022-01-03")));
    expect(dataset.manifest.symbol).toBe("IMPORTED");
  });
});

// ─── Gap detection ────────────────────────────────────────────────────────────

describe("importCsv — gap detection", () => {
  it("emits no warning for consecutive daily candles", () => {
    const input = csv(row("2022-01-03"), row("2022-01-04"), row("2022-01-05"));
    const { warnings } = importCsv(input);
    expect(warnings).toHaveLength(0);
  });

  it("warns but succeeds for a weekend gap (Fri→Mon)", () => {
    const input = csv(row("2022-01-07"), row("2022-01-10")); // Fri → Mon
    const { dataset, warnings } = importCsv(input);
    expect(dataset.candles).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/gap/i);
  });

  it("records gap count and gap dates in the manifest", () => {
    const input = csv(row("2022-01-07"), row("2022-01-10"), row("2022-01-11"), row("2022-01-14"));
    const { dataset } = importCsv(input);
    expect(dataset.manifest.gapCount).toBe(2);
    expect(dataset.manifest.gapDates).toEqual(["2022-01-07", "2022-01-11"]);
  });

  it("does not set gapCount / gapDates when there are no gaps", () => {
    const input = csv(row("2022-01-03"), row("2022-01-04"));
    const { dataset } = importCsv(input);
    expect(dataset.manifest.gapCount).toBeUndefined();
    expect(dataset.manifest.gapDates).toBeUndefined();
  });
});

// ─── Hard errors — missing / bad columns ─────────────────────────────────────

describe("importCsv — hard errors: missing columns", () => {
  it("throws on missing date column", () => {
    const input = "open,high,low,close,volume\n100,110,90,105,1000";
    expect(() => importCsv(input)).toThrowError(CsvImportError);
    expect(() => importCsv(input)).toThrowError(/date/i);
  });

  it("throws on missing close column", () => {
    const input = "date,open,high,low,volume\n2022-01-03,100,110,90,1000";
    expect(() => importCsv(input)).toThrowError(/close/i);
  });

  it("lists all missing columns in the error message", () => {
    const input = "foo,bar\n1,2";
    expect(() => importCsv(input)).toThrowError(/date.*open.*high.*low.*close/i);
  });
});

// ─── Hard errors — empty / header-only files ─────────────────────────────────

describe("importCsv — hard errors: empty files", () => {
  it("throws on completely empty input", () => {
    expect(() => importCsv("")).toThrowError(CsvImportError);
  });

  it("throws on header-only file (no data rows)", () => {
    expect(() => importCsv(HEADER)).toThrowError(CsvImportError);
  });

  it("throws when all data rows are blank after filtering", () => {
    expect(() => importCsv(HEADER + "\n\n\n")).toThrowError(CsvImportError);
  });
});

// ─── Hard errors — bad date values ───────────────────────────────────────────

describe("importCsv — hard errors: bad dates", () => {
  it("throws on unrecognized date format", () => {
    const input = csv("not-a-date,100,110,90,105,1000");
    expect(() => importCsv(input)).toThrowError(/unrecognized date/i);
  });

  it("throws on duplicate (non-monotonic) dates", () => {
    const input = csv(row("2022-01-03"), row("2022-01-03"));
    expect(() => importCsv(input)).toThrowError(/non-monotonic/i);
  });

  it("throws on out-of-order dates", () => {
    const input = csv(row("2022-01-05"), row("2022-01-03"));
    expect(() => importCsv(input)).toThrowError(/non-monotonic/i);
  });

  it("includes the 1-based line number in the error", () => {
    const input = csv(row("2022-01-03"), "2022-01-04,abc,110,90,105,1000");
    try {
      importCsv(input);
      throw new Error("expected CsvImportError");
    } catch (e) {
      expect(e).toBeInstanceOf(CsvImportError);
      expect((e as CsvImportError).line).toBe(3); // header=1, first row=2, second row=3
    }
  });

  // Impossible calendar dates — JS's Date.UTC silently normalises these
  // (e.g. Feb 31 → Mar 3) without the round-trip validation guard.
  it("throws on Feb 30 (impossible day)", () => {
    const input = csv(row("2022-02-30"), row("2022-03-01"));
    expect(() => importCsv(input)).toThrowError(/unrecognized date/i);
  });

  it("throws on Feb 31 (impossible day)", () => {
    const input = csv(row("2022-02-31"), row("2022-03-01"));
    expect(() => importCsv(input)).toThrowError(/unrecognized date/i);
  });

  it("throws on month 13 (impossible month)", () => {
    const input = csv(row("2022-13-01"));
    expect(() => importCsv(input)).toThrowError(/unrecognized date/i);
  });

  it("throws on day 40 in MM/DD/YYYY format", () => {
    const input = "date,open,high,low,close,volume\n13/40/2022,100,110,90,105,1000";
    expect(() => importCsv(input)).toThrowError(/unrecognized date/i);
  });

  it("throws on Apr 31 (impossible day)", () => {
    const input = csv(row("2022-04-31"), row("2022-05-02"));
    expect(() => importCsv(input)).toThrowError(/unrecognized date/i);
  });
});

// ─── Hard errors — bad OHLCV values ──────────────────────────────────────────

describe("importCsv — hard errors: bad OHLCV values", () => {
  it("throws on non-numeric open", () => {
    const input = csv("2022-01-03,abc,110,90,105,1000");
    expect(() => importCsv(input)).toThrowError(/non-numeric/i);
  });

  it("throws on non-numeric close", () => {
    const input = csv("2022-01-03,100,110,90,N/A,1000");
    expect(() => importCsv(input)).toThrowError(/non-numeric/i);
  });

  it("throws on zero close price", () => {
    const input = csv("2022-01-03,100,110,0,0,1000");
    expect(() => importCsv(input)).toThrowError(/> 0/);
  });

  it("throws on negative low price", () => {
    const input = csv("2022-01-03,100,110,-5,105,1000");
    expect(() => importCsv(input)).toThrowError(/> 0/);
  });

  it("throws on inverted candle (high < low)", () => {
    const input = csv("2022-01-03,100,85,90,105,1000"); // high=85 < low=90
    expect(() => importCsv(input)).toThrowError(/inverted/i);
  });
});

// ─── Determinism ─────────────────────────────────────────────────────────────

describe("importCsv — determinism", () => {
  it("same CSV content always produces identical candles", () => {
    const input = csv(
      row("2022-01-03", 100, 110, 90, 105, 1000),
      row("2022-01-04", 105, 115, 95, 110, 2000),
      row("2022-01-05", 110, 120, 100, 115, 3000),
    );
    const r1 = importCsv(input);
    const r2 = importCsv(input);
    expect(r1.dataset.candles).toEqual(r2.dataset.candles);
    expect(r1.dataset.manifest).toEqual(r2.dataset.manifest);
  });
});
