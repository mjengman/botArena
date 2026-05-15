import type { BotDetail } from "../hooks/useSimulation.ts";
import { BOT_COLORS } from "../constants.ts";

interface BotInspectorProps {
  bot: BotDetail | null;
}

export function BotInspector({ bot }: BotInspectorProps) {
  if (!bot) {
    return (
      <section className="panel inspector inspector--empty">
        <h2 className="panel-title">Inspector</h2>
        <p className="inspector-hint">Click a bot in standings to inspect</p>
      </section>
    );
  }

  const color = BOT_COLORS[bot.id] ?? "#94a3b8";
  const closedTrades = bot.trades.filter((t) => t.status === "closed");
  const openTrades = bot.trades.filter((t) => t.status === "open");
  const params = Object.entries(bot.params).filter(([, v]) => typeof v === "number");

  return (
    <section className="panel inspector">
      <h2 className="panel-title">
        <span className="bot-dot bot-dot--lg" style={{ background: color }} />
        {bot.name}
      </h2>

      <div className="insp-section">
        <div className="insp-row">
          <span className="insp-label">Cash</span>
          <span className="insp-val">${bot.cash.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}</span>
        </div>
        <div className="insp-row">
          <span className="insp-label">Equity</span>
          <span className="insp-val">${bot.equity.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}</span>
        </div>
        <div className="insp-row">
          <span className="insp-label">Exposure</span>
          <span className="insp-val">{(bot.exposure * 100).toFixed(1)}%</span>
        </div>
        <div className="insp-row">
          <span className="insp-label">Realized P&L</span>
          <span className={`insp-val ${bot.realizedPnl >= 0 ? "positive" : "negative"}`}>
            {bot.realizedPnl >= 0 ? "+" : ""}${bot.realizedPnl.toFixed(2)}
          </span>
        </div>
        <div className="insp-row">
          <span className="insp-label">Unrealized P&L</span>
          <span className={`insp-val ${bot.unrealizedPnl >= 0 ? "positive" : "negative"}`}>
            {bot.unrealizedPnl >= 0 ? "+" : ""}${bot.unrealizedPnl.toFixed(2)}
          </span>
        </div>
      </div>

      {bot.positions.length > 0 && (
        <div className="insp-section">
          <div className="insp-subtitle">Open Positions</div>
          {bot.positions.map((p) => (
            <div key={p.symbol} className="insp-row">
              <span className="insp-label">{p.symbol}</span>
              <span className="insp-val">{p.quantity} @ ${p.avgCost.toFixed(2)}</span>
            </div>
          ))}
        </div>
      )}

      {openTrades.length > 0 && (
        <div className="insp-section">
          <div className="insp-subtitle">Open Trade</div>
          {openTrades.map((t) => (
            <div key={t.id} className="insp-trade insp-trade--open">
              <span className="tag tag--buy">LONG</span>
              {t.entryQuantity} {t.symbol} @ ${t.entryPrice.toFixed(2)}
            </div>
          ))}
        </div>
      )}

      {closedTrades.length > 0 && (
        <div className="insp-section">
          <div className="insp-subtitle">
            Recent Trades ({closedTrades.length})
          </div>
          {closedTrades.slice(-5).reverse().map((t) => {
            const pnl = t.realizedPnl ?? 0;
            return (
              <div key={t.id} className="insp-trade">
                <span className="tag tag--buy">B</span>
                <span className="insp-trade-detail">
                  {t.entryQuantity} @ ${t.entryPrice.toFixed(2)}
                  {t.exitPrice != null && (
                    <>
                      {" → "}
                      <span className="tag tag--sell">S</span>
                      {" $"}{t.exitPrice.toFixed(2)}
                    </>
                  )}
                </span>
                <span className={`insp-trade-pnl ${pnl >= 0 ? "positive" : "negative"}`}>
                  {pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {params.length > 0 && (
        <div className="insp-section">
          <div className="insp-subtitle">Params</div>
          {params.map(([k, v]) => (
            <div key={k} className="insp-row">
              <span className="insp-label">{k}</span>
              <span className="insp-val muted">{String(v)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
