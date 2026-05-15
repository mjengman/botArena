import { useState, useRef } from "react";
import { sampleDataset } from "../../data/sampleDataset.ts";
import { BOT_REGISTRY } from "../botRegistry.ts";
import { type MatchConfig, defaultMatchConfig, validateMatchConfig } from "../matchConfig.ts";
import { importCsv, CsvImportError } from "../../data/csvImport.ts";
import type { Dataset } from "../../engine/types.ts";

interface ConfigPanelProps {
  current: MatchConfig;
  /** The dataset currently used as the simulation source (may be an import). */
  sourceDataset: Dataset;
  onApply: (config: MatchConfig) => void;
  onClose: () => void;
  /** Called when the user loads a valid CSV; replaces the source dataset. */
  onDatasetLoad: (dataset: Dataset) => void;
  /** Called when the user clears an imported dataset and reverts to synthetic. */
  onDatasetClear: () => void;
}

function candleDate(dataset: Dataset, idx: number): string {
  const c = dataset.candles[idx];
  if (!c) return "—";
  return new Date(c.timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function isImported(dataset: Dataset): boolean {
  return dataset.manifest.source === "csv-import";
}

export function ConfigPanel({
  current,
  sourceDataset,
  onApply,
  onClose,
  onDatasetLoad,
  onDatasetClear,
}: ConfigPanelProps) {
  const [draft, setDraft] = useState<MatchConfig>(() => ({
    ...current,
    botParams: Object.fromEntries(
      Object.entries(current.botParams).map(([k, v]) => [k, { ...v }]),
    ),
    activeBotIds: [...current.activeBotIds],
  }));
  const [importError, setImportError] = useState<string | null>(null);
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const totalCandles = sourceDataset.candles.length;

  function setField<K extends keyof MatchConfig>(key: K, value: MatchConfig[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function toggleBot(id: string) {
    setDraft((d) => {
      const active = d.activeBotIds.includes(id)
        ? d.activeBotIds.filter((b) => b !== id)
        : [...d.activeBotIds, id];
      return { ...d, activeBotIds: active };
    });
  }

  function setParam(botId: string, key: string, value: number) {
    setDraft((d) => ({
      ...d,
      botParams: {
        ...d.botParams,
        [botId]: { ...d.botParams[botId], [key]: value },
      },
    }));
  }

  function handleReset() {
    setDraft(defaultMatchConfig());
  }

  // ── CSV import ──────────────────────────────────────────────────────────
  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportError(null);
    setImportWarnings([]);

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const text = ev.target?.result as string;
        const { dataset, warnings } = importCsv(text, { filename: file.name });
        setImportWarnings(warnings);
        onDatasetLoad(dataset);
        // Reset draft date range to match the new dataset's full span
        setDraft((d) => ({ ...d, dataStartIdx: 0, dataEndIdx: dataset.candles.length - 1 }));
      } catch (err) {
        if (err instanceof CsvImportError) {
          setImportError(err.message);
        } else {
          setImportError("Unexpected error parsing file. Check the console for details.");
          console.error(err);
        }
      }
      // Reset file input so the same file can be re-selected after error
      if (fileInputRef.current) fileInputRef.current.value = "";
    };
    reader.onerror = () => {
      setImportError("Failed to read file.");
      if (fileInputRef.current) fileInputRef.current.value = "";
    };
    reader.readAsText(file);
  }

  function handleClearImport() {
    setImportError(null);
    setImportWarnings([]);
    onDatasetClear();
    setDraft((d) => ({
      ...d,
      dataStartIdx: 0,
      dataEndIdx: sampleDataset.candles.length - 1,
    }));
  }

  const validationErrors = validateMatchConfig(draft, sourceDataset);
  const canApply = validationErrors.length === 0;
  const candleRange = draft.dataEndIdx - draft.dataStartIdx + 1;
  const imported = isImported(sourceDataset);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">MATCH CONFIG</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {/* ── Dataset source ─────────────────────────────────────── */}
          <div className="cfg-section">
            <div className="cfg-section-title">
              Dataset
              {imported && (
                <span className="cfg-badge cfg-badge--imported">IMPORTED CSV</span>
              )}
            </div>

            {/* Manifest summary */}
            <div className="cfg-manifest">
              <div className="cfg-manifest-row">
                <span className="cfg-label">Symbol</span>
                <span>{sourceDataset.manifest.symbol}</span>
              </div>
              <div className="cfg-manifest-row">
                <span className="cfg-label">Source</span>
                <span className="cfg-manifest-source">{sourceDataset.manifest.source}</span>
              </div>
              <div className="cfg-manifest-row">
                <span className="cfg-label">Full Range</span>
                <span>
                  {sourceDataset.manifest.startDate} – {sourceDataset.manifest.endDate}
                </span>
              </div>
              <div className="cfg-manifest-row">
                <span className="cfg-label">Candles</span>
                <span>
                  {sourceDataset.manifest.candleCount}
                  {sourceDataset.manifest.gapCount !== undefined && (
                    <span className="cfg-gap-note muted">
                      {" "}· {sourceDataset.manifest.gapCount} gap(s)
                    </span>
                  )}
                </span>
              </div>
            </div>

            {/* Import warnings */}
            {importWarnings.length > 0 && (
              <div className="cfg-import-warnings">
                {importWarnings.map((w, i) => (
                  <div key={i} className="cfg-import-warning">{w}</div>
                ))}
              </div>
            )}

            {/* Import error */}
            {importError && (
              <div className="cfg-import-error">{importError}</div>
            )}

            {/* File picker + clear */}
            <div className="cfg-dataset-actions">
              <label className="cfg-btn cfg-btn--ghost cfg-file-label">
                ↑ Load CSV
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,.txt"
                  className="cfg-file-input"
                  onChange={handleFileChange}
                />
              </label>
              {imported && (
                <button className="cfg-btn cfg-btn--ghost" onClick={handleClearImport}>
                  ✕ Use Synthetic
                </button>
              )}
            </div>
            <div className="cfg-dataset-hint muted">
              CSV must have date, open, high, low, close columns. Volume is optional.
              Gaps (weekends, holidays) are allowed.
            </div>
          </div>

          {/* ── Execution params ───────────────────────────────────── */}
          <div className="cfg-section">
            <div className="cfg-section-title">Execution</div>
            <div className="cfg-grid">
              <label className="cfg-label">Starting Cash</label>
              <div className="cfg-input-wrap">
                <span className="cfg-prefix">$</span>
                <input
                  className="cfg-input"
                  type="number"
                  min={100}
                  max={1_000_000}
                  step={1000}
                  value={draft.startingCash}
                  onChange={(e) => setField("startingCash", Number(e.target.value))}
                />
              </div>

              <label className="cfg-label">Fee (bps)</label>
              <input
                className="cfg-input"
                type="number"
                min={0}
                max={100}
                step={1}
                value={draft.feeBps}
                onChange={(e) => setField("feeBps", Number(e.target.value))}
              />

              <label className="cfg-label">Slippage (bps)</label>
              <input
                className="cfg-input"
                type="number"
                min={0}
                max={100}
                step={1}
                value={draft.slippageBps}
                onChange={(e) => setField("slippageBps", Number(e.target.value))}
              />

              <label className="cfg-label">Seed</label>
              <input
                className="cfg-input"
                type="number"
                min={0}
                max={999999}
                step={1}
                value={draft.seed}
                onChange={(e) => setField("seed", Number(e.target.value))}
              />
            </div>
          </div>

          {/* ── Date range ─────────────────────────────────────────── */}
          <div className="cfg-section">
            <div className="cfg-section-title">
              Date Range
              <span className="cfg-section-note">
                {candleRange} candles · {candleDate(sourceDataset, draft.dataStartIdx)} –{" "}
                {candleDate(sourceDataset, draft.dataEndIdx)}
              </span>
            </div>
            <div className="cfg-range-row">
              <span className="cfg-range-label">Start</span>
              <input
                className="cfg-range"
                type="range"
                min={0}
                max={totalCandles - 2}
                value={draft.dataStartIdx}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setDraft((d) => ({
                    ...d,
                    dataStartIdx: v,
                    dataEndIdx: Math.max(d.dataEndIdx, v + 1),
                  }));
                }}
              />
              <span className="cfg-range-val">{candleDate(sourceDataset, draft.dataStartIdx)}</span>
            </div>
            <div className="cfg-range-row">
              <span className="cfg-range-label">End</span>
              <input
                className="cfg-range"
                type="range"
                min={1}
                max={totalCandles - 1}
                value={draft.dataEndIdx}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setDraft((d) => ({
                    ...d,
                    dataEndIdx: v,
                    dataStartIdx: Math.min(d.dataStartIdx, v - 1),
                  }));
                }}
              />
              <span className="cfg-range-val">{candleDate(sourceDataset, draft.dataEndIdx)}</span>
            </div>
          </div>

          {/* ── Bots ───────────────────────────────────────────────── */}
          <div className="cfg-section">
            <div className="cfg-section-title">Bots & Parameters</div>
            {BOT_REGISTRY.map((bot) => {
              const active = draft.activeBotIds.includes(bot.id);
              return (
                <div key={bot.id} className={`cfg-bot ${active ? "" : "cfg-bot--inactive"}`}>
                  <div className="cfg-bot-header">
                    <label className="cfg-bot-toggle">
                      <input
                        type="checkbox"
                        checked={active}
                        onChange={() => toggleBot(bot.id)}
                      />
                      <span className="cfg-bot-name">{bot.name}</span>
                    </label>
                  </div>
                  {active && bot.paramDefs.length > 0 && (
                    <div className="cfg-params">
                      {bot.paramDefs.map((pd) => (
                        <div key={pd.key} className="cfg-param-row">
                          <label className="cfg-param-label">{pd.label}</label>
                          <input
                            className="cfg-range cfg-range--sm"
                            type="range"
                            min={pd.min}
                            max={pd.max}
                            step={pd.step}
                            value={draft.botParams[bot.id]?.[pd.key] ?? pd.defaultValue}
                            onChange={(e) => setParam(bot.id, pd.key, Number(e.target.value))}
                          />
                          <span className="cfg-param-val">
                            {(draft.botParams[bot.id]?.[pd.key] ?? pd.defaultValue).toFixed(
                              pd.step < 0.1 ? 3 : pd.step < 1 ? 1 : 0,
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {validationErrors.length > 0 && (
          <div className="cfg-errors">
            {validationErrors.map((e) => (
              <div key={e.field} className="cfg-error">{e.message}</div>
            ))}
          </div>
        )}

        <div className="modal-footer">
          <button className="cfg-btn cfg-btn--ghost" onClick={handleReset}>
            Reset Defaults
          </button>
          <div className="modal-footer-right">
            <button className="cfg-btn cfg-btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="cfg-btn cfg-btn--primary" disabled={!canApply} onClick={() => onApply(draft)}>
              Apply & Restart
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
