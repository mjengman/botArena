import type { ArenaEvent, ArenaEventType } from "./types.ts";

export class EventLog {
  private events: ArenaEvent[] = [];

  emit(
    type: ArenaEventType,
    timestamp: number,
    candleIndex: number,
    botId: string | null,
    payload: Record<string, unknown>,
  ): void {
    this.events.push({ type, timestamp, candleIndex, botId, payload });
  }

  getAll(): readonly ArenaEvent[] {
    return this.events;
  }

  reset(): void {
    this.events = [];
  }
}
