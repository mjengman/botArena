/**
 * CSV OHLCV importer.
 *
 * Parses a standard OHLCV CSV file into a Bot Arena `Dataset`.
 *
 * Accepted header names (case-insensitive, any order):
 *   date / datetime / time / timestamp → row date
 *   open                               → open price
 *   high                               → high price
 *   low                                → low price
 *   close / adj close / adjusted close → close price
 *   volume / vol                       → volume (optional; defaults to 0 if absent)
 *
 * Hard errors (throw `CsvImportError`):
 *   - Missing required columns (date, open, high, low, close)
 *   - Non-parseable date string
 *   - Non-numeric OHLCV values
 *   - Zero or negative price (open, high, low, or close)
 *   - High < low on any candle
 *   - Non-monotonic dates (out-of-order or duplicate timestamps)
 *   - File is empty or has no data rows after the header
 *
 * Soft warnings (recorded in `CsvImportResult.warnings`, do not throw):
 *   - Date gaps between consecutive candles (weekends, holidays, vendor gaps)
 *     are normal in daily data and are allowed. Gap count and gap dates
 *     are surfaced in `DatasetManifest.gapCount` / `DatasetManifest.gapDates`.
 *
 * The importer is purely synchronous and has no browser/Node dependencies.
 * Callers read the file and pass the raw string content.
 */

import type { Candle, Dataset } from "../engine/types.ts";

// ─── Public types ─────────────────────────────────────────────────────────────

export interface CsvImportResult {
  dataset: Dataset;
  /** Human-readable warnings (gap notifications). Does not indicate failure. */
  warnings: string[];
}

export interface CsvImportOptions {
  /**
   * Symbol name to embed in the manifest.
   * If omitted, derived from the filename hint (strip extension, uppercase)
   * or falls back to "IMPORTED".
   */
  symbol?: string;
  /**
   * Filename hint used to derive the symbol when `options.symbol` is not set.
   * e.g. "AAPL_daily.csv" → "AAPL"
   */
  filename?: string;
}

export class CsvImportError extends Error {
  constructor(
    message: string,
    /** 1-based line number where the error occurred, or undefined for header errors. */
    public readonly line?: number,
  ) {
    super(line !== undefined ? `Line ${line}: ${message}` : message);
    this.name = "CsvImportError";
  }
}

// ─── Column detection ─────────────────────────────────────────────────────────

type ColumnMap = {
  date: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

function detectColumns(headers: string[]): ColumnMap {
  const normalized = headers.map((h) => h.trim().toLowerCase().replace(/\s+/g, " "));

  function find(candidates: string[]): number {
    for (const c of candidates) {
      const idx = normalized.indexOf(c);
      if (idx !== -1) return idx;
    }
    // Partial match fallback
    for (const c of candidates) {
      const idx = normalized.findIndex((h) => h.includes(c));
      if (idx !== -1) return idx;
    }
    return -1;
  }

  const dateIdx = find(["date", "datetime", "time", "timestamp"]);
  const openIdx = find(["open"]);
  const highIdx = find(["high"]);
  const lowIdx = find(["low"]);
  const closeIdx = find(["adj close", "adjusted close", "close"]);
  const volumeIdx = find(["volume", "vol"]);

  const missing: string[] = [];
  if (dateIdx === -1) missing.push("date");
  if (openIdx === -1) missing.push("open");
  if (highIdx === -1) missing.push("high");
  if (lowIdx === -1) missing.push("low");
  if (closeIdx === -1) missing.push("close");

  if (missing.length > 0) {
    throw new CsvImportError(
      `Missing required column(s): ${missing.join(", ")}. ` +
        `Found headers: ${headers.join(", ")}`,
    );
  }

  return {
    date: dateIdx,
    open: openIdx,
    high: highIdx,
    low: lowIdx,
    close: closeIdx,
    volume: volumeIdx === -1 ? null : volumeIdx,
  };
}

// ─── Date parsing ─────────────────────────────────────────────────────────────

/**
 * Parse a date string to a UTC midnight timestamp (ms).
 * Accepts ISO 8601 dates (YYYY-MM-DD) and ISO datetimes.
 * Also accepts MM/DD/YYYY (US format) as a common alternative.
 * Returns NaN on failure, including for impossible calendar dates
 * (e.g. 2022-02-31, 13/40/2022) — JS's Date.UTC normalises these
 * silently, so we validate with a round-trip check.
 */
function parseDate(raw: string): number {
  const s = raw.trim();

  // ISO date: YYYY-MM-DD (treat as UTC midnight)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const y = parseInt(s.slice(0, 4), 10);
    const m = parseInt(s.slice(5, 7), 10);
    const d = parseInt(s.slice(8, 10), 10);
    const ts = Date.UTC(y, m - 1, d);
    // Round-trip check: Date.UTC normalises impossible dates (e.g. Feb 31 → Mar 3).
    // If the UTC components don't match the input, the date is invalid.
    const check = new Date(ts);
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
      return NaN;
    }
    return ts;
  }

  // ISO datetime: YYYY-MM-DDTHH:MM:SS[Z] — truncate to date, treat as UTC midnight
  const isoDateMatch = s.match(/^(\d{4}-\d{2}-\d{2})(?:T|[ ])/);
  if (isoDateMatch) {
    const ds = isoDateMatch[1]!;
    const y = parseInt(ds.slice(0, 4), 10);
    const m = parseInt(ds.slice(5, 7), 10);
    const d = parseInt(ds.slice(8, 10), 10);
    const ts = Date.UTC(y, m - 1, d);
    const check = new Date(ts);
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
      return NaN;
    }
    return ts;
  }

  // US format: MM/DD/YYYY
  const usMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (usMatch) {
    const m = parseInt(usMatch[1]!, 10);
    const d = parseInt(usMatch[2]!, 10);
    const y = parseInt(usMatch[3]!, 10);
    const ts = Date.UTC(y, m - 1, d);
    const check = new Date(ts);
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
      return NaN;
    }
    return ts;
  }

  return NaN;
}

function toIsoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

// ─── Row parsing ──────────────────────────────────────────────────────────────

function parseNumber(raw: string, field: string, lineNum: number): number {
  const s = raw.trim().replace(/,/g, ""); // remove thousands separators
  const n = Number(s);
  if (!isFinite(n)) {
    throw new CsvImportError(`Non-numeric value "${raw}" in column "${field}"`, lineNum);
  }
  return n;
}

// ─── CSV line splitter ────────────────────────────────────────────────────────

/** Split a CSV line respecting double-quoted fields. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// ─── Main importer ────────────────────────────────────────────────────────────

/**
 * Parse raw CSV text into a `CsvImportResult`.
 *
 * @param csvText - Full text content of the CSV file.
 * @param options - Optional symbol name and filename hint.
 * @throws `CsvImportError` on any hard validation failure.
 */
export function importCsv(csvText: string, options: CsvImportOptions = {}): CsvImportResult {
  const warnings: string[] = [];

  // ── Split lines, strip BOM, skip blank lines ────────────────────────────
  const rawLines = csvText.replace(/^﻿/, "").split(/\r?\n/);
  const lines = rawLines.map((l) => l.trimEnd()).filter((l) => l.length > 0);

  if (lines.length < 2) {
    throw new CsvImportError("File is empty or contains only a header row with no data");
  }

  // ── Parse header ────────────────────────────────────────────────────────
  const headerFields = splitCsvLine(lines[0]!);
  const cols = detectColumns(headerFields);

  // ── Parse data rows ─────────────────────────────────────────────────────
  const candles: Candle[] = [];
  let prevTimestamp = -Infinity;

  for (let i = 1; i < lines.length; i++) {
    const lineNum = i + 1; // 1-based, header is line 1
    const fields = splitCsvLine(lines[i]!);

    // Skip rows that are clearly filler (e.g. a second header row some providers emit)
    const rawDate = fields[cols.date]?.trim() ?? "";
    if (rawDate === "" || /^(date|datetime|time|timestamp)$/i.test(rawDate)) continue;

    // Parse date
    const ts = parseDate(rawDate);
    if (isNaN(ts)) {
      throw new CsvImportError(
        `Unrecognized date format "${rawDate}". Expected YYYY-MM-DD, YYYY-MM-DDTHH:MM:SS, or MM/DD/YYYY`,
        lineNum,
      );
    }

    // Hard-reject non-monotonic dates
    if (ts <= prevTimestamp) {
      const prev = toIsoDate(prevTimestamp);
      const curr = toIsoDate(ts);
      throw new CsvImportError(
        `Non-monotonic date: ${curr} is not after previous date ${prev}. ` +
          `Rows must be in strictly ascending chronological order with no duplicates`,
        lineNum,
      );
    }

    // Parse OHLCV
    const open  = parseNumber(fields[cols.open]  ?? "", "open",  lineNum);
    const high  = parseNumber(fields[cols.high]  ?? "", "high",  lineNum);
    const low   = parseNumber(fields[cols.low]   ?? "", "low",   lineNum);
    const close = parseNumber(fields[cols.close] ?? "", "close", lineNum);
    const volume =
      cols.volume !== null
        ? parseNumber(fields[cols.volume] ?? "0", "volume", lineNum)
        : 0;

    // Hard-reject zero or negative prices
    if (open <= 0)  throw new CsvImportError(`open price must be > 0 (got ${open})`,   lineNum);
    if (high <= 0)  throw new CsvImportError(`high price must be > 0 (got ${high})`,   lineNum);
    if (low  <= 0)  throw new CsvImportError(`low price must be > 0 (got ${low})`,     lineNum);
    if (close <= 0) throw new CsvImportError(`close price must be > 0 (got ${close})`, lineNum);

    // Hard-reject inverted candles
    if (high < low) {
      throw new CsvImportError(
        `high (${high}) < low (${low}) — inverted candle`,
        lineNum,
      );
    }

    candles.push({ timestamp: ts, open, high, low, close, volume });
    prevTimestamp = ts;
  }

  if (candles.length === 0) {
    throw new CsvImportError("No valid data rows found after parsing");
  }

  // ── Gap detection (soft warning) ────────────────────────────────────────
  const DAY_MS = 86_400_000;
  const gapDates: string[] = [];

  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i]!.timestamp - candles[i - 1]!.timestamp;
    // A gap is > 1 calendar day (allow up to 1 day + 1 minute for DST/rounding)
    if (delta > DAY_MS + 60_000) {
      const gapAfter = toIsoDate(candles[i - 1]!.timestamp);
      gapDates.push(gapAfter);
    }
  }

  if (gapDates.length > 0) {
    const preview = gapDates.slice(0, 5).join(", ");
    const extra = gapDates.length > 5 ? ` … and ${gapDates.length - 5} more` : "";
    warnings.push(
      `${gapDates.length} date gap(s) detected after: ${preview}${extra}. ` +
        `This is normal for weekends, holidays, and vendor gaps.`,
    );
  }

  // ── Build manifest ──────────────────────────────────────────────────────
  const symbol = resolveSymbol(options);
  const manifest = {
    symbol,
    timeframe: "1d",
    source: "csv-import",
    startDate: toIsoDate(candles[0]!.timestamp),
    endDate: toIsoDate(candles[candles.length - 1]!.timestamp),
    candleCount: candles.length,
    ...(gapDates.length > 0 && { gapCount: gapDates.length, gapDates }),
  };

  return { dataset: { manifest, candles }, warnings };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveSymbol(options: CsvImportOptions): string {
  if (options.symbol) return options.symbol.toUpperCase();
  if (options.filename) {
    // Strip path, extension, trailing underscores/hyphens/spaces
    const base = options.filename
      .replace(/\\/g, "/")
      .split("/")
      .pop()!
      .replace(/\.[^.]+$/, "")
      .replace(/[_\- ]+/g, " ")
      .trim()
      .toUpperCase();
    // Take the first whitespace-delimited token as the ticker
    const ticker = base.split(/\s+/)[0];
    if (ticker && ticker.length > 0 && ticker.length <= 10) return ticker;
  }
  return "IMPORTED";
}
