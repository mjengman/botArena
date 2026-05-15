import { useMemo } from "react";
import {
  ComposedChart,
  Line,
  ReferenceLine,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import type { Dataset } from "../../engine/types.ts";
import type { ArenaEvent } from "../../engine/types.ts";

interface PriceChartProps {
  dataset: Dataset;
  candleIndex: number;
  events: ArenaEvent[];
  selectedBotId: string | null;
}

interface PricePoint {
  index: number;
  close: number;
  date: string;
}

// Pre-compute the full price series once — it never changes.
function buildPriceData(dataset: Dataset): PricePoint[] {
  return dataset.candles.map((c, i) => ({
    index: i,
    close: c.close,
    date: new Date(c.timestamp).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "2-digit",
    }),
  }));
}

interface FillMarker {
  candleIndex: number;
  side: "buy" | "sell";
}

function renderDot(
  props: { cx?: number; cy?: number; index?: number },
  markers: Map<number, FillMarker>,
) {
  const { cx, cy, index } = props;
  if (cx == null || cy == null || index == null) return null;
  const m = markers.get(index);
  if (!m) return null;
  if (m.side === "buy") {
    return (
      <polygon
        key={`buy-${index}`}
        points={`${cx},${cy - 8} ${cx - 5},${cy + 3} ${cx + 5},${cy + 3}`}
        fill="#4ade80"
        opacity={0.9}
      />
    );
  }
  return (
    <polygon
      key={`sell-${index}`}
      points={`${cx},${cy + 8} ${cx - 5},${cy - 3} ${cx + 5},${cy - 3}`}
      fill="#f87171"
      opacity={0.9}
    />
  );
}

interface TooltipPayload {
  payload?: PricePoint;
}

function PriceTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayload[] }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-date">{d.date}</div>
      <div>${d.close.toFixed(2)}</div>
    </div>
  );
}

export function PriceChart({ dataset, candleIndex, events, selectedBotId }: PriceChartProps) {
  const priceData = useMemo(() => buildPriceData(dataset), [dataset]);

  const fillMarkers = useMemo(() => {
    const map = new Map<number, FillMarker>();
    for (const e of events) {
      if (e.type === "ORDER_FILL" && e.botId === selectedBotId) {
        map.set(e.candleIndex, {
          candleIndex: e.candleIndex,
          side: e.payload["side"] as "buy" | "sell",
        });
      }
    }
    return map;
  }, [events, selectedBotId]);

  const currentIdx = candleIndex > 0 ? candleIndex - 1 : null;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={priceData} margin={{ top: 4, right: 8, bottom: 4, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e2d44" vertical={false} />
        <XAxis dataKey="index" hide />
        <YAxis
          domain={["auto", "auto"]}
          width={56}
          tick={{ fill: "#64748b", fontSize: 11 }}
          tickFormatter={(v: number) => `$${v.toFixed(0)}`}
        />
        <Tooltip content={<PriceTooltip />} />
        <Line
          type="monotone"
          dataKey="close"
          stroke="#475569"
          strokeWidth={1.5}
          dot={(props) => renderDot(props as { cx?: number; cy?: number; index?: number }, fillMarkers) ?? <g key={`empty-${(props as {index?: number}).index}`} />}
          activeDot={{ r: 3, fill: "#94a3b8" }}
          isAnimationActive={false}
        />
        {currentIdx !== null && (
          <ReferenceLine
            x={currentIdx}
            stroke="#f59e0b"
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
