import { describe, it, expect } from "vitest";
import { buildWindowDefs, runSeason } from "../src/app/season.ts";
import { defaultMatchConfig } from "../src/app/matchConfig.ts";
import { sampleDataset } from "../src/data/sampleDataset.ts";

const TOTAL = sampleDataset.candles.length; // 504

describe("buildWindowDefs", () => {
  it("produces the requested number of windows", () => {
    const mc = defaultMatchConfig();
    expect(buildWindowDefs(mc, 4)).toHaveLength(4);
    expect(buildWindowDefs(mc, 2)).toHaveLength(2);
  });

  it("first window starts at dataStartIdx", () => {
    const mc = defaultMatchConfig();
    const [first] = buildWindowDefs(mc, 4);
    expect(first!.startIdx).toBe(mc.dataStartIdx);
  });

  it("last window ends at dataEndIdx", () => {
    const mc = defaultMatchConfig();
    const defs = buildWindowDefs(mc, 4);
    expect(defs[defs.length - 1]!.endIdx).toBe(mc.dataEndIdx);
  });

  it("windows do not overlap and have no gaps", () => {
    const mc = defaultMatchConfig();
    const defs = buildWindowDefs(mc, 4);
    for (let i = 1; i < defs.length; i++) {
      expect(defs[i]!.startIdx).toBe(defs[i - 1]!.endIdx + 1);
    }
  });

  it("respects a custom date range", () => {
    const mc = { ...defaultMatchConfig(), dataStartIdx: 100, dataEndIdx: 299 };
    const defs = buildWindowDefs(mc, 2);
    expect(defs[0]!.startIdx).toBe(100);
    expect(defs[defs.length - 1]!.endIdx).toBe(299);
    expect(defs).toHaveLength(2);
  });

  it("candles are covered completely (no candle lost to floor division)", () => {
    const mc = defaultMatchConfig();
    const defs = buildWindowDefs(mc, 3);
    let covered = 0;
    for (const d of defs) covered += d.endIdx - d.startIdx + 1;
    expect(covered).toBe(TOTAL);
  });
});

describe("runSeason", () => {
  it("returns a result with the requested window count", () => {
    const mc = defaultMatchConfig();
    const result = runSeason(mc, 2);
    expect(result.windows).toHaveLength(2);
  });

  it("produces aggregate standings for all active bots", () => {
    const mc = defaultMatchConfig();
    const result = runSeason(mc, 2);
    expect(result.aggregate.length).toBe(mc.activeBotIds.length);
  });

  it("aggregate matchCount equals window count for each bot", () => {
    const mc = defaultMatchConfig();
    const result = runSeason(mc, 3);
    for (const s of result.aggregate) {
      expect(s.matchCount).toBe(3);
    }
  });

  it("wins sum across all bots equals window count (one winner per window)", () => {
    const mc = defaultMatchConfig();
    const result = runSeason(mc, 4);
    const totalWins = result.aggregate.reduce((s, a) => s + a.wins, 0);
    expect(totalWins).toBe(4);
  });

  it("two identical runs produce identical aggregate standings (determinism)", () => {
    const mc = defaultMatchConfig();
    const r1 = runSeason(mc, 2);
    const r2 = runSeason(mc, 2);
    expect(r1.aggregate.map((a) => ({ id: a.botId, avgReturn: a.avgReturn }))).toEqual(
      r2.aggregate.map((a) => ({ id: a.botId, avgReturn: a.avgReturn })),
    );
  });

  it("compounded totalReturn is product of (1+r) - 1", () => {
    const mc = defaultMatchConfig();
    const result = runSeason(mc, 2);
    for (const agg of result.aggregate) {
      const w = result.windows.map((win) => win.standings.find((s) => s.botId === agg.botId)!.totalReturn);
      const expected = w.reduce((acc, r) => acc * (1 + r), 1) - 1;
      expect(agg.totalReturn).toBeCloseTo(expected);
    }
  });
});
