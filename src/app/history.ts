import type { MetricSnapshot } from "../engine/types.ts";

const STORAGE_KEY = "bot-arena-history";
const MAX_RUNS = 50;

export interface StoredRun {
  id: string;
  completedAt: string;
  config: { startingCash: number; feeBps: number; slippageBps: number; seed: number };
  dataset: { symbol: string; startDate: string; endDate: string; candleCount: number };
  activeBotIds: string[];
  standings: MetricSnapshot[];
  eventCount: number;
}

export function loadHistory(): StoredRun[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredRun[]) : [];
  } catch {
    return [];
  }
}

export function saveRun(run: StoredRun): void {
  try {
    const history = loadHistory();
    history.unshift(run);
    if (history.length > MAX_RUNS) history.length = MAX_RUNS;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {
    // localStorage unavailable or full — fail silently
  }
}

export function deleteRun(id: string): void {
  try {
    const history = loadHistory().filter((r) => r.id !== id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {}
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

export function importRunFromJson(json: string): StoredRun | null {
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    if (!obj.standings || !obj.config || !obj.dataset) return null;
    const run: StoredRun = {
      id: `import-${Date.now()}`,
      completedAt: (obj.exportedAt as string) ?? new Date().toISOString(),
      config: obj.config as StoredRun["config"],
      dataset: obj.dataset as StoredRun["dataset"],
      activeBotIds: (obj.bots as Array<{ id: string }>).map((b) => b.id),
      standings: obj.standings as MetricSnapshot[],
      eventCount: (obj.eventCount as number) ?? 0,
    };
    saveRun(run);
    return run;
  } catch {
    return null;
  }
}
