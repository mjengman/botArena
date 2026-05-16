import { useState, useEffect } from "react";
import type { Dataset } from "../../engine/types.ts";
import {
  type MarketDataRequest,
  validateMarketDataRequest,
  fetchAlpacaBars,
} from "../../data/providers/alpacaMarketData.ts";
import {
  getCachedDataset,
  setCachedDataset,
  clearMarketDataCache,
  listCachedEntries,
} from "../../data/marketDataCache.ts";
import { Tooltip } from "./Tooltip.tsx";

interface MarketDataPanelProps {
  onApply: (dataset: Dataset) => void;
  onClose: () => void;
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

export function MarketDataPanel({ onApply, onClose }: MarketDataPanelProps) {
  // Credentials — stored in component state only, never persisted
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");

  // Fetch parameters
  const [symbol, setSymbol] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  // UI state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewDataset, setPreviewDataset] = useState<Dataset | null>(null);
  const [fromCache, setFromCache] = useState(false);

  // Cache
  const [cacheEntries, setCacheEntries] = useState(() => listCachedEntries());

  function refreshCache() {
    setCacheEntries(listCachedEntries());
  }

  useEffect(() => {
    refreshCache();
  }, []);

  function buildRequest(): MarketDataRequest {
    return {
      symbol: symbol.trim().toUpperCase(),
      startDate,
      endDate,
      timeframe: "1d",
      feed: "iex",
    };
  }

  const validationErrors = (() => {
    const req = buildRequest();
    // Skip validation if fields are empty — show errors only on attempt
    if (!symbol && !startDate && !endDate) return [];
    return validateMarketDataRequest(req);
  })();

  const canFetch =
    !loading &&
    symbol.trim().length > 0 &&
    startDate.length > 0 &&
    endDate.length > 0 &&
    apiKey.trim().length > 0 &&
    apiSecret.trim().length > 0;

  async function handleFetch() {
    setError(null);
    setPreviewDataset(null);
    setFromCache(false);

    const req = buildRequest();
    const errors = validateMarketDataRequest(req);
    if (errors.length > 0) {
      setError(errors.join(" "));
      return;
    }

    // Check cache first
    const cached = getCachedDataset(req.symbol, req.startDate, req.endDate);
    if (cached) {
      setPreviewDataset(cached.dataset);
      setFromCache(true);
      return;
    }

    setLoading(true);
    try {
      const dataset = await fetchAlpacaBars(req, {
        apiKey: apiKey.trim(),
        apiSecret: apiSecret.trim(),
      });
      setCachedDataset(req.symbol, req.startDate, req.endDate, dataset);
      refreshCache();
      setPreviewDataset(dataset);
      setFromCache(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function handleClearCache() {
    clearMarketDataCache();
    refreshCache();
    // If preview was from cache, clear it
    if (fromCache) {
      setPreviewDataset(null);
      setFromCache(false);
    }
  }

  function handleApply() {
    if (!previewDataset) return;
    onApply(previewDataset);
    onClose();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">⬇ ALPACA MARKET DATA</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">

          {/* ── Credentials ──────────────────────────────────────────── */}
          <div className="cfg-section">
            <div className="cfg-section-title">Credentials</div>
            <div className="cfg-grid">
              <label className="cfg-label">API Key</label>
              <input
                className="cfg-input"
                type="text"
                placeholder="APCA-…"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <label className="cfg-label">API Secret</label>
              <input
                className="cfg-input"
                type="password"
                placeholder="••••••••"
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div className="mkt-cred-note muted">
              Credentials stored in memory only — never saved to disk.
            </div>
          </div>

          {/* ── Fetch Parameters ─────────────────────────────────────── */}
          <div className="cfg-section">
            <div className="cfg-section-title">Fetch Parameters</div>
            <div className="mkt-fetch-grid">
              <label className="cfg-label">Symbol</label>
              <input
                className="cfg-input"
                type="text"
                placeholder="e.g. SPY"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                spellCheck={false}
              />
              <label className="cfg-label">Start Date</label>
              <input
                className="cfg-input"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
              <label className="cfg-label">End Date</label>
              <input
                className="cfg-input"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>

            <div className="mkt-fixed-row">
              <span className="muted">Timeframe:</span>
              <span className="mkt-fixed-val">1 Day</span>
              <span className="muted">
                Feed:
                <Tooltip text="Investors Exchange (IEX) is Alpaca's free-tier data source. Volume data is partial-market (~2–5% of total market share)." />
              </span>
              <span className="mkt-fixed-val">IEX (free tier)</span>
            </div>

            <div className="mkt-warning">
              <span className="mkt-warning-icon">⚠</span>
              <span>
                IEX data is partial-market volume (≈2–5% of market share). Volume-sensitive strategies
                may produce skewed results. Full SIP data requires an Alpaca premium subscription.
              </span>
            </div>

            {validationErrors.length > 0 && (
              <div className="mkt-validation-errors">
                {validationErrors.map((e, i) => (
                  <div key={i} className="cfg-import-error">{e}</div>
                ))}
              </div>
            )}

            <div>
              <button
                className="cfg-btn cfg-btn--primary"
                disabled={!canFetch || loading}
                onClick={() => void handleFetch()}
              >
                {loading ? "Fetching…" : "Fetch Bars"}
              </button>
            </div>
          </div>

          {/* ── Error banner ─────────────────────────────────────────── */}
          {error && (
            <div className="mkt-error-banner">
              <span>{error}</span>
              <button className="mkt-error-dismiss" onClick={() => setError(null)}>✕</button>
            </div>
          )}

          {/* ── Preview ──────────────────────────────────────────────── */}
          {previewDataset && (
            <div className="cfg-section">
              <div className="cfg-section-title">
                Preview
                {fromCache && <span className="cfg-section-note">from cache</span>}
              </div>
              <div className="mkt-preview-grid">
                <span className="cfg-label">Symbol</span>
                <span>{previewDataset.manifest.symbol}</span>
                <span className="cfg-label">Source</span>
                <span>Alpaca · IEX</span>
                <span className="cfg-label">Timeframe</span>
                <span>{previewDataset.manifest.timeframe}</span>
                <span className="cfg-label">Date Range</span>
                <span>{previewDataset.manifest.startDate} – {previewDataset.manifest.endDate}</span>
                <span className="cfg-label">Candles</span>
                <span>
                  {previewDataset.manifest.candleCount}
                  {(previewDataset.manifest.gapCount ?? 0) > 0 && (
                    <span className="muted"> · {previewDataset.manifest.gapCount} gap(s)</span>
                  )}
                </span>
              </div>
              <div>
                <button className="cfg-btn cfg-btn--primary" onClick={handleApply}>
                  Apply Dataset
                </button>
              </div>
            </div>
          )}

          {/* ── Cache ────────────────────────────────────────────────── */}
          {cacheEntries.length > 0 && (
            <div className="cfg-section">
              <div className="cfg-section-title">
                Cache
                <span className="cfg-section-note">{cacheEntries.length} entr{cacheEntries.length === 1 ? "y" : "ies"}</span>
              </div>
              <div className="mkt-cache-list">
                {cacheEntries.map((entry) => (
                  <div key={entry.key} className="mkt-cache-row">
                    <span className="mkt-cache-symbol">{entry.symbol}</span>
                    <span className="muted">{entry.candleCount} candles</span>
                    <span className="muted">fetched {fmtTime(entry.fetchedAt)}</span>
                  </div>
                ))}
              </div>
              <div>
                <button className="cfg-btn cfg-btn--ghost" onClick={handleClearCache}>
                  Clear Cache
                </button>
              </div>
            </div>
          )}

        </div>

        <div className="modal-footer">
          <span className="muted" style={{ fontSize: "10px" }}>
            Data via Alpaca Data API v2 · IEX free tier
          </span>
          <div className="modal-footer-right">
            <button className="cfg-btn cfg-btn--ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
