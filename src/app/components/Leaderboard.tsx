import { useState } from "react";
import type { MetricSnapshot } from "../../engine/types.ts";
import { BOT_COLORS } from "../constants.ts";

type SortKey = "totalReturn" | "finalEquity" | "maxDrawdown" | "winRate" | "tradeCount";

interface LeaderboardProps {
  standings: MetricSnapshot[];
  selectedBotId: string | null;
  onSelect: (id: string) => void;
}

const COLUMNS: { key: SortKey; label: string; desc: boolean }[] = [
  { key: "totalReturn",  label: "Return",  desc: true  },
  { key: "finalEquity",  label: "Equity",  desc: true  },
  { key: "maxDrawdown",  label: "MaxDD",   desc: false },
  { key: "winRate",      label: "Win%",    desc: true  },
  { key: "tradeCount",   label: "Trades",  desc: true  },
];

function sortStandings(standings: MetricSnapshot[], key: SortKey, desc: boolean): MetricSnapshot[] {
  return [...standings].sort((a, b) => {
    const diff = a[key] - b[key];
    return desc ? -diff : diff;
  });
}

export function Leaderboard({ standings, selectedBotId, onSelect }: LeaderboardProps) {
  const [sortKey, setSortKey] = useState<SortKey>("totalReturn");
  const [sortDesc, setSortDesc] = useState(true);

  function handleSort(col: (typeof COLUMNS)[number]) {
    if (sortKey === col.key) {
      setSortDesc((d) => !d);
    } else {
      setSortKey(col.key);
      setSortDesc(col.desc);
    }
  }

  const sorted = sortStandings(standings, sortKey, sortDesc);

  return (
    <section className="panel leaderboard">
      <h2 className="panel-title">Standings</h2>
      <table className="lb-table">
        <thead>
          <tr>
            <th>#</th>
            <th>Bot</th>
            {COLUMNS.map((col) => (
              <th
                key={col.key}
                className={`num lb-sort-th ${sortKey === col.key ? "lb-sort-th--active" : ""}`}
                onClick={() => handleSort(col)}
                title={`Sort by ${col.label}`}
              >
                {col.label}
                {sortKey === col.key && (
                  <span className="lb-sort-arrow">{sortDesc ? " ↓" : " ↑"}</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((s, displayIdx) => {
            const color = BOT_COLORS[s.botId] ?? "#94a3b8";
            const returnPct = (s.totalReturn * 100).toFixed(2);
            const positive = s.totalReturn >= 0;
            return (
              <tr
                key={s.botId}
                className={`lb-row ${selectedBotId === s.botId ? "lb-row--selected" : ""}`}
                onClick={() => onSelect(s.botId)}
              >
                <td className="lb-rank">{displayIdx + 1}</td>
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
                <td className="num muted">
                  {(s.winRate * 100).toFixed(0)}%
                </td>
                <td className="num muted">
                  {s.tradeCount}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
