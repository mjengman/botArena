import { useEffect, useRef } from "react";
import type { ArenaEvent } from "../../engine/types.ts";
import { BOT_COLORS } from "../constants.ts";

interface EventFeedProps {
  events: ArenaEvent[];
  selectedBotId: string | null;
  botNames: Record<string, string>;
}

const VISIBLE_TYPES = new Set<ArenaEvent["type"]>([
  "MATCH_START",
  "MATCH_END",
  "ORDER_FILL",
  "ORDER_REJECTED",
  "WARNING",
]);

function describe(e: ArenaEvent): string {
  switch (e.type) {
    case "MATCH_START":
      return `Match started · ${e.payload["candleCount"]} candles · ${e.payload["botCount"]} bots · $${(e.payload["startingCash"] as number).toLocaleString()} each`;
    case "MATCH_END":
      return "Match complete";
    case "ORDER_FILL": {
      const side = e.payload["side"] as string;
      const qty = e.payload["quantity"] as number;
      const sym = e.payload["symbol"] as string;
      const price = (e.payload["price"] as number).toFixed(2);
      const fee = (e.payload["fee"] as number).toFixed(2);
      const action = side === "buy" ? "Bought" : "Sold";
      return `${action} ${qty} ${sym} @ $${price} · fee $${fee}`;
    }
    case "ORDER_REJECTED":
      return `Order rejected: ${e.payload["reason"]} · ${e.payload["side"]} ${e.payload["symbol"]}`;
    case "WARNING":
      return `⚠ ${e.payload["message"]}`;
    default:
      return e.type;
  }
}

function eventClass(e: ArenaEvent): string {
  if (e.type === "ORDER_FILL") return (e.payload["side"] as string) === "buy" ? "ev--buy" : "ev--sell";
  if (e.type === "ORDER_REJECTED" || e.type === "WARNING") return "ev--warn";
  if (e.type === "MATCH_START" || e.type === "MATCH_END") return "ev--system";
  return "";
}

export function EventFeed({ events, selectedBotId, botNames }: EventFeedProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const visible = events.filter((e) => {
    if (!VISIBLE_TYPES.has(e.type)) return false;
    if (selectedBotId && e.botId && e.botId !== selectedBotId) return false;
    return true;
  });

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [visible.length]);

  return (
    <section className="event-feed">
      <div className="event-feed-header">
        <span className="panel-title">Event Log</span>
        <span className="muted" style={{ fontSize: 11 }}>
          {selectedBotId ? `filtered · ${botNames[selectedBotId] ?? selectedBotId}` : `${visible.length} events`}
        </span>
      </div>
      <div className="event-list" ref={containerRef}>
        {visible.length === 0 && (
          <div className="event-empty">No events yet — press Play or Step to run</div>
        )}
        {visible.map((e, i) => {
          const color = e.botId ? (BOT_COLORS[e.botId] ?? "#94a3b8") : "#475569";
          return (
            <div key={i} className={`ev ${eventClass(e)}`}>
              <span className="ev-dot" style={{ background: color }} />
              <span className="ev-bot">{e.botId ? (botNames[e.botId] ?? e.botId) : "system"}</span>
              <span className="ev-text">{describe(e)}</span>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </section>
  );
}
