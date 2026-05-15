import { useState } from "react";
import { sampleDataset } from "../../data/sampleDataset.ts";
import { BOT_REGISTRY } from "../botRegistry.ts";
import { type MatchConfig, defaultMatchConfig, validateMatchConfig } from "../matchConfig.ts";

interface ConfigPanelProps {
  current: MatchConfig;
  onApply: (config: MatchConfig) => void;
  onClose: () => void;
}

const TOTAL_CANDLES = sampleDataset.candles.length;

function candleDate(idx: number): string {
  const c = sampleDataset.candles[idx];
  if (!c) return "—";
  return new Date(c.timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function ConfigPanel({ current, onApply, onClose }: ConfigPanelProps) {
  const [draft, setDraft] = useState<MatchConfig>(() => ({
    ...current,
    botParams: Object.fromEntries(
      Object.entries(current.botParams).map(([k, v]) => [k, { ...v }]),
    ),
    activeBotIds: [...current.activeBotIds],
  }));

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

  const validationErrors = validateMatchConfig(draft);
  const canApply = validationErrors.length === 0;

  const candleRange = draft.dataEndIdx - draft.dataStartIdx + 1;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">MATCH CONFIG</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {/* Execution params */}
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

          {/* Date range */}
          <div className="cfg-section">
            <div className="cfg-section-title">
              Date Range
              <span className="cfg-section-note">
                {candleRange} candles · {candleDate(draft.dataStartIdx)} – {candleDate(draft.dataEndIdx)}
              </span>
            </div>
            <div className="cfg-range-row">
              <span className="cfg-range-label">Start</span>
              <input
                className="cfg-range"
                type="range"
                min={0}
                max={TOTAL_CANDLES - 2}
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
              <span className="cfg-range-val">{candleDate(draft.dataStartIdx)}</span>
            </div>
            <div className="cfg-range-row">
              <span className="cfg-range-label">End</span>
              <input
                className="cfg-range"
                type="range"
                min={1}
                max={TOTAL_CANDLES - 1}
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
              <span className="cfg-range-val">{candleDate(draft.dataEndIdx)}</span>
            </div>
          </div>

          {/* Bots */}
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

          {/* Dataset manifest */}
          <div className="cfg-section">
            <div className="cfg-section-title">Dataset Manifest</div>
            <div className="cfg-manifest">
              <div className="cfg-manifest-row">
                <span className="cfg-label">Symbol</span>
                <span>{sampleDataset.manifest.symbol}</span>
              </div>
              <div className="cfg-manifest-row">
                <span className="cfg-label">Timeframe</span>
                <span>{sampleDataset.manifest.timeframe}</span>
              </div>
              <div className="cfg-manifest-row">
                <span className="cfg-label">Source</span>
                <span className="cfg-manifest-source">{sampleDataset.manifest.source}</span>
              </div>
              <div className="cfg-manifest-row">
                <span className="cfg-label">Full Range</span>
                <span>
                  {sampleDataset.manifest.startDate} – {sampleDataset.manifest.endDate}
                </span>
              </div>
              <div className="cfg-manifest-row">
                <span className="cfg-label">Total Candles</span>
                <span>{sampleDataset.manifest.candleCount}</span>
              </div>
            </div>
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
