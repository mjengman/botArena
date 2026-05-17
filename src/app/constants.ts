export const BOT_COLORS: Record<string, string> = {
  bah: "#4ade80",
  mac: "#60a5fa",
  mom: "#f59e0b",
  mr: "#c084fc",
  rnd: "#94a3b8",
};

export type Speed = "1x" | "4x" | "16x" | "max";

export const SPEED_DELAY: Record<Exclude<Speed, "max">, number> = {
  "1x": 350,
  "4x": 80,
  "16x": 16,
};

export const DEFAULT_START_CASH = 100;
