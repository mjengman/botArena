import type { MetricSnapshot } from "../../engine/types.ts";
import { BOT_COLORS } from "../constants.ts";

interface LeaderboardProps {
  standings: MetricSnapshot[];
  selectedBotId: string | null;
  onSelect: (id: string) => void;
}

export function Leaderboard({ standings, selectedBotId, onSelect }: LeaderboardProps) {
  return (
    <section className="panel leaderboard">
      <h2 className="panel-title">Standings</h2>
      <table className="lb-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Bot</th>
            <th className="num">Return</th>
            <th className="num">Equity</th>
            <th className="num">MaxDD</th>
          </tr>
        </thead>
        <tbody>
          {standings.map((s) => {
            const color = BOT_COLORS[s.botId] ?? "#94a3b8";
            const returnPct = (s.totalReturn * 100).toFixed(2);
            const positive = s.totalReturn >= 0;
            return (
              <tr
                key={s.botId}
                className={`lb-row ${selectedBotId === s.botId ? "lb-row--selected" : ""}`}
                onClick={() => onSelect(s.botId)}
              >
                <td className="lb-rank">{s.rank}</td>
                <td className="lb-name">
                  <span className="bot-dot" style={{ background: color }} />
                  {s.botName}
                </td>
                <td className={`num ${positive ? "positive" : "negative"}`}>
                  {positive ? "+" : ""}{returnPct}%
                </td>
                <td className="num muted">
                  ${s.finalEquity.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                </td>
                <td className="num muted">
                  {(s.maxDrawdown * 100).toFixed(1)}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
