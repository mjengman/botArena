import { useMemo } from "react";
import {
  LineChart,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import type { EquityHistory } from "../hooks/useSimulation.ts";
import { BOT_COLORS, DEFAULT_START_CASH } from "../constants.ts";

interface EquityCurvesProps {
  equityHistories: EquityHistory[];
  selectedBotId: string | null;
}

interface EquityPoint {
  index: number;
  [botId: string]: number;
}

function buildEquityData(histories: EquityHistory[]): EquityPoint[] {
  const maxLen = Math.max(0, ...histories.map((h) => h.history.length));
  if (maxLen === 0) return [];
  return Array.from({ length: maxLen }, (_, i) => {
    const point: EquityPoint = { index: i };
    for (const h of histories) {
      if (i < h.history.length) {
        point[h.botId] = h.history[i]!;
      }
    }
    return point;
  });
}

interface TooltipEntry {
  name: string;
  value: number;
  color: string;
}

function EquityTooltip({ active, payload }: { active?: boolean; payload?: TooltipEntry[] }) {
  if (!active || !payload?.length) return null;
  const sorted = [...payload].sort((a, b) => b.value - a.value);
  return (
    <div className="chart-tooltip">
      {sorted.map((entry) => (
        <div key={entry.name} className="chart-tooltip-row">
          <span className="chart-tooltip-dot" style={{ background: entry.color }} />
          <span className="chart-tooltip-name">{entry.name}</span>
          <span>${entry.value.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>
        </div>
      ))}
    </div>
  );
}

export function EquityCurves({ equityHistories, selectedBotId }: EquityCurvesProps) {
  const equityData = useMemo(
    () => buildEquityData(equityHistories),
    [equityHistories],
  );

  if (equityData.length === 0) {
    return (
      <div className="chart-empty">
        <span>Equity curves will appear once the match starts</span>
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={equityData} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e2d44" vertical={false} />
        <XAxis dataKey="index" hide />
        <YAxis
          domain={["auto", "auto"]}
          width={56}
          tick={{ fill: "#64748b", fontSize: 11 }}
          tickFormatter={(v: number) => `$${(v / 1000).toFixed(1)}k`}
        />
        <Tooltip content={<EquityTooltip />} />
        <Legend
          wrapperStyle={{ fontSize: 11, color: "#64748b", paddingTop: 2 }}
          formatter={(value: string) => (
            <span style={{ color: BOT_COLORS[value] ?? "#94a3b8" }}>
              {equityHistories.find((h) => h.botId === value)?.botName ?? value}
            </span>
          )}
        />
        <ReferenceLine
          y={DEFAULT_START_CASH}
          stroke="#1e2d44"
          strokeDasharray="4 3"
          strokeWidth={1}
        />
        {equityHistories.map((h) => (
          <Line
            key={h.botId}
            type="monotone"
            dataKey={h.botId}
            name={h.botId}
            stroke={BOT_COLORS[h.botId] ?? "#94a3b8"}
            strokeWidth={selectedBotId === null || selectedBotId === h.botId ? 2 : 1}
            opacity={selectedBotId === null || selectedBotId === h.botId ? 1 : 0.3}
            dot={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
