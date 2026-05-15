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

export type CurveView = "equity" | "drawdown";

interface EquityCurvesProps {
  equityHistories: EquityHistory[];
  selectedBotId: string | null;
  view: CurveView;
}

interface ChartPoint {
  index: number;
  [botId: string]: number;
}

function buildEquityData(histories: EquityHistory[]): ChartPoint[] {
  const maxLen = Math.max(0, ...histories.map((h) => h.history.length));
  if (maxLen === 0) return [];
  return Array.from({ length: maxLen }, (_, i) => {
    const point: ChartPoint = { index: i };
    for (const h of histories) {
      if (i < h.history.length) point[h.botId] = h.history[i]!;
    }
    return point;
  });
}

function buildDrawdownData(histories: EquityHistory[]): ChartPoint[] {
  const maxLen = Math.max(0, ...histories.map((h) => h.history.length));
  if (maxLen === 0) return [];
  return Array.from({ length: maxLen }, (_, i) => {
    const point: ChartPoint = { index: i };
    for (const h of histories) {
      if (i < h.history.length) {
        // Compute peak-to-trough drawdown at position i
        let peak = 0;
        for (let j = 0; j <= i; j++) {
          if (h.history[j]! > peak) peak = h.history[j]!;
        }
        const dd = peak > 0 ? (peak - h.history[i]!) / peak : 0;
        point[h.botId] = -(dd * 100); // negative % for display
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

function DrawdownTooltip({ active, payload }: { active?: boolean; payload?: TooltipEntry[] }) {
  if (!active || !payload?.length) return null;
  const sorted = [...payload].sort((a, b) => a.value - b.value);
  return (
    <div className="chart-tooltip">
      {sorted.map((entry) => (
        <div key={entry.name} className="chart-tooltip-row">
          <span className="chart-tooltip-dot" style={{ background: entry.color }} />
          <span className="chart-tooltip-name">{entry.name}</span>
          <span>{entry.value.toFixed(1)}%</span>
        </div>
      ))}
    </div>
  );
}

export function EquityCurves({ equityHistories, selectedBotId, view }: EquityCurvesProps) {
  const equityData = useMemo(() => buildEquityData(equityHistories), [equityHistories]);
  const drawdownData = useMemo(() => buildDrawdownData(equityHistories), [equityHistories]);

  const data = view === "equity" ? equityData : drawdownData;

  if (data.length === 0) {
    return (
      <div className="chart-empty">
        <span>Equity curves will appear once the match starts</span>
      </div>
    );
  }

  const legendFormatter = (value: string) => (
    <span style={{ color: BOT_COLORS[value] ?? "#94a3b8" }}>
      {equityHistories.find((h) => h.botId === value)?.botName ?? value}
    </span>
  );

  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e2d44" vertical={false} />
        <XAxis dataKey="index" hide />
        {view === "equity" ? (
          <YAxis
            domain={["auto", "auto"]}
            width={56}
            tick={{ fill: "#64748b", fontSize: 11 }}
            tickFormatter={(v: number) => `$${(v / 1000).toFixed(1)}k`}
          />
        ) : (
          <YAxis
            domain={["auto", 0]}
            width={56}
            tick={{ fill: "#64748b", fontSize: 11 }}
            tickFormatter={(v: number) => `${v.toFixed(0)}%`}
          />
        )}
        <Tooltip content={view === "equity" ? <EquityTooltip /> : <DrawdownTooltip />} />
        <Legend
          wrapperStyle={{ fontSize: 11, color: "#64748b", paddingTop: 2 }}
          formatter={legendFormatter}
        />
        {view === "equity" && (
          <ReferenceLine
            y={DEFAULT_START_CASH}
            stroke="#1e2d44"
            strokeDasharray="4 3"
            strokeWidth={1}
          />
        )}
        {view === "drawdown" && (
          <ReferenceLine y={0} stroke="#1e2d44" strokeWidth={1} />
        )}
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
