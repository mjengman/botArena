// @vitest-environment jsdom
/**
 * M14 Slice 3 — evolutionState.ts unit tests.
 *
 * Coverage:
 *   A. buildInitialPopulation  — count, archetypes, params, gen-0 invariants
 *   B. buildEvolutionManifest  — uses sliced candle dates, not full-dataset dates
 *   C. buildRunContext          — captures correct context fields
 *   D. adaptSeasonResult        — thin structural mapping
 *   E. createEvolutionRun       — generation-0 shape
 *   F. createEvolutionSession   — runState + context in sync
 *   G. contextMatchesCurrent    — clean match and each individual mismatch
 *   H. Persistence              — versioned envelope, round-trip, stale/corrupt guard
 *   I. runEvolutionSeason       — evolved bots run with mutated params; unknown archetype throws
 */

import { describe, it, expect, beforeEach } from "vitest";
import { sampleDataset } from "../src/data/sampleDataset.ts";
import { defaultMatchConfig } from "../src/app/matchConfig.ts";
import { BOT_REGISTRY } from "../src/app/botRegistry.ts";
import {
  DEFAULT_EVOLUTION_CONFIG,
  buildInitialPopulation,
  buildEvolutionManifest,
  buildRunContext,
  computeDatasetFingerprint,
  createEvolutionRun,
  createEvolutionSession,
  adaptSeasonResult,
  contextMatchesCurrent,
  loadEvolutionSession,
  saveEvolutionSession,
  clearEvolutionSession,
} from "../src/app/evolutionState.ts";
import type { EvolutionRunContext } from "../src/app/evolutionState.ts";
import { runEvolutionSeason } from "../src/app/season.ts";
import type { SeasonResult } from "../src/app/season.ts";
import type { MatchConfig } from "../src/app/matchConfig.ts";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const NOW = "2026-05-18T10:00:00.000Z";
const MOCK_MC = defaultMatchConfig();
const MOCK_DATASET = sampleDataset;

/** A minimal SeasonResult with two windows for adaptSeasonResult tests. */
function makeSeasonResult(windowCount = 2): SeasonResult {
  const standings = BOT_REGISTRY.map((b, i) => ({
    botId: b.id, botName: b.name,
    rank: i + 1, totalReturn: 0.05 * (i + 1),
    finalEquity: 105, maxDrawdown: 0.03,
    winRate: 0.5, tradeCount: 2, closedTradeCount: 2,
    realizedPnl: 5, unrealizedPnl: 0,
    profitFactor: 1.5, avgTrade: 2.5, exposureTime: 0.6,
  }));
  return {
    id: "test-season",
    ranAt: NOW,
    windowCount,
    windows: Array.from({ length: windowCount }, (_, i) => ({
      index: i,
      startDate: "2022-01-03",
      endDate: "2022-06-30",
      candleCount: 100,
      standings,
    })),
    aggregate: [],
  };
}

// ─── A. buildInitialPopulation ────────────────────────────────────────────────

describe("buildInitialPopulation", () => {
  const pop = buildInitialPopulation("run-abc123", DEFAULT_EVOLUTION_CONFIG, 100, NOW);

  it("produces one spec per registry entry", () => {
    expect(pop).toHaveLength(BOT_REGISTRY.length);
  });

  it("archetypes match registry ids in order", () => {
    const archetypes = pop.map((s) => s.archetype);
    expect(archetypes).toEqual(BOT_REGISTRY.map((b) => b.id));
  });

  it("params match each registry entry's defaults", () => {
    for (const spec of pop) {
      const def = BOT_REGISTRY.find((b) => b.id === spec.archetype)!;
      for (const pd of def.paramDefs) {
        expect(spec.params[pd.key]).toBe(pd.defaultValue);
      }
    }
  });

  it("all specs are generation 0 with empty parentIds", () => {
    for (const spec of pop) {
      expect(spec.generation).toBe(0);
      expect(spec.parentIds).toEqual([]);
    }
  });

  it("capital is set from startingCash argument", () => {
    const popWith200 = buildInitialPopulation("run-xyz", DEFAULT_EVOLUTION_CONFIG, 200, NOW);
    for (const spec of popWith200) {
      expect(spec.capital).toBe(200);
    }
  });

  it("mutationRate comes from config", () => {
    for (const spec of pop) {
      expect(spec.mutationRate).toBe(DEFAULT_EVOLUTION_CONFIG.mutationRate);
    }
  });

  it("every id contains the lineageId prefix", () => {
    for (const spec of pop) {
      expect(spec.id.startsWith(spec.metadata.lineageId)).toBe(true);
    }
  });

  it("ids are unique across all initial bots", () => {
    const ids = pop.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("lineageIds are unique across archetypes for the same runId", () => {
    const lineageIds = pop.map((s) => s.metadata.lineageId);
    expect(new Set(lineageIds).size).toBe(lineageIds.length);
  });

  it("different runIds produce different lineageIds for the same archetype", () => {
    const pop2 = buildInitialPopulation("run-different", DEFAULT_EVOLUTION_CONFIG, 100, NOW);
    for (let i = 0; i < pop.length; i++) {
      expect(pop[i]!.metadata.lineageId).not.toBe(pop2[i]!.metadata.lineageId);
    }
  });
});

// ─── B. buildEvolutionManifest ────────────────────────────────────────────────

describe("buildEvolutionManifest", () => {
  it("uses sliced candle dates, not full dataset start/end", () => {
    // Use a sub-range that doesn't span the full dataset
    const slicedMc: MatchConfig = {
      ...MOCK_MC,
      dataStartIdx: 100,
      dataEndIdx: 199,
    };
    const manifest = buildEvolutionManifest(MOCK_DATASET, slicedMc, 4);

    // The expected dates come from the candles at indices 100 and 199
    const expectedFrom = new Date(MOCK_DATASET.candles[100]!.timestamp).toISOString().slice(0, 10);
    const expectedTo   = new Date(MOCK_DATASET.candles[199]!.timestamp).toISOString().slice(0, 10);

    expect(manifest.fromDate).toBe(expectedFrom);
    expect(manifest.toDate).toBe(expectedTo);

    // Importantly: should NOT equal the full-dataset dates (unless the indices
    // happen to be 0 and the last candle, which they don't in this fixture)
    expect(manifest.fromDate).not.toBe(MOCK_DATASET.manifest.startDate);
    expect(manifest.toDate).not.toBe(MOCK_DATASET.manifest.endDate);
  });

  it("uses full dataset dates when indices span the whole dataset", () => {
    const fullMc: MatchConfig = {
      ...MOCK_MC,
      dataStartIdx: 0,
      dataEndIdx: MOCK_DATASET.candles.length - 1,
    };
    const manifest = buildEvolutionManifest(MOCK_DATASET, fullMc, 4);
    expect(manifest.fromDate).toBe(MOCK_DATASET.manifest.startDate);
    expect(manifest.toDate).toBe(MOCK_DATASET.manifest.endDate);
  });

  it("records the correct windowCount and symbol", () => {
    const manifest = buildEvolutionManifest(MOCK_DATASET, MOCK_MC, 6);
    expect(manifest.windowCount).toBe(6);
    expect(manifest.symbol).toBe(MOCK_DATASET.manifest.symbol);
  });

  it("windowLengthDays is floor(totalCandles / windowCount)", () => {
    const mc: MatchConfig = { ...MOCK_MC, dataStartIdx: 0, dataEndIdx: 99 };
    const manifest = buildEvolutionManifest(MOCK_DATASET, mc, 4);
    expect(manifest.windowLengthDays).toBe(Math.floor(100 / 4));
  });
});

// ─── C. buildRunContext ───────────────────────────────────────────────────────

describe("buildRunContext", () => {
  it("captures candleCount as the slice size, not the full dataset", () => {
    const mc: MatchConfig = { ...MOCK_MC, dataStartIdx: 50, dataEndIdx: 149 };
    const ctx = buildRunContext(mc, MOCK_DATASET, 4);
    expect(ctx.candleCount).toBe(100);
  });

  it("captures all sim config fields", () => {
    const mc: MatchConfig = {
      ...MOCK_MC, startingCash: 500, feeBps: 10, slippageBps: 5, seed: 999,
    };
    const ctx = buildRunContext(mc, MOCK_DATASET, 4);
    expect(ctx.startingCash).toBe(500);
    expect(ctx.feeBps).toBe(10);
    expect(ctx.slippageBps).toBe(5);
    expect(ctx.seed).toBe(999);
  });

  it("captures dataStartIdx and dataEndIdx verbatim", () => {
    const mc: MatchConfig = { ...MOCK_MC, dataStartIdx: 20, dataEndIdx: 80 };
    const ctx = buildRunContext(mc, MOCK_DATASET, 4);
    expect(ctx.dataStartIdx).toBe(20);
    expect(ctx.dataEndIdx).toBe(80);
  });

  it("stores windowCount from argument", () => {
    const ctx = buildRunContext(MOCK_MC, MOCK_DATASET, 6);
    expect(ctx.windowCount).toBe(6);
  });

  it("stores a non-empty datasetFingerprint", () => {
    const ctx = buildRunContext(MOCK_MC, MOCK_DATASET, 4);
    expect(typeof ctx.datasetFingerprint).toBe("string");
    expect(ctx.datasetFingerprint.length).toBeGreaterThan(0);
  });

  it("same slice produces same fingerprint (deterministic)", () => {
    const ctx1 = buildRunContext(MOCK_MC, MOCK_DATASET, 4);
    const ctx2 = buildRunContext(MOCK_MC, MOCK_DATASET, 4);
    expect(ctx1.datasetFingerprint).toBe(ctx2.datasetFingerprint);
  });

  it("different slice produces different fingerprint", () => {
    const ctx1 = buildRunContext({ ...MOCK_MC, dataStartIdx: 0, dataEndIdx: 99 }, MOCK_DATASET, 4);
    const ctx2 = buildRunContext({ ...MOCK_MC, dataStartIdx: 100, dataEndIdx: 199 }, MOCK_DATASET, 4);
    expect(ctx1.datasetFingerprint).not.toBe(ctx2.datasetFingerprint);
  });
});

// ─── D. adaptSeasonResult ─────────────────────────────────────────────────────

describe("adaptSeasonResult", () => {
  it("preserves window count", () => {
    const adapted = adaptSeasonResult(makeSeasonResult(3));
    expect(adapted.windows).toHaveLength(3);
  });

  it("preserves window indices", () => {
    const adapted = adaptSeasonResult(makeSeasonResult(2));
    expect(adapted.windows[0]!.index).toBe(0);
    expect(adapted.windows[1]!.index).toBe(1);
  });

  it("preserves standings reference equality (no deep copy)", () => {
    const sr = makeSeasonResult(2);
    const adapted = adaptSeasonResult(sr);
    expect(adapted.windows[0]!.standings).toBe(sr.windows[0]!.standings);
  });
});

// ─── E. createEvolutionRun ────────────────────────────────────────────────────

describe("createEvolutionRun", () => {
  const manifest = buildEvolutionManifest(MOCK_DATASET, MOCK_MC, 4);
  const run = createEvolutionRun(DEFAULT_EVOLUTION_CONFIG, manifest, 100, NOW);

  it("starts at generation 0", () => {
    expect(run.generation).toBe(0);
  });

  it("activePop has one bot per registry entry", () => {
    expect(run.activePop).toHaveLength(BOT_REGISTRY.length);
  });

  it("archive and championHistory start empty", () => {
    expect(run.archive).toHaveLength(0);
    expect(Object.keys(run.championHistory)).toHaveLength(0);
  });

  it("runId is deterministic for same (createdAt, symbol)", () => {
    const run2 = createEvolutionRun(DEFAULT_EVOLUTION_CONFIG, manifest, 100, NOW);
    expect(run.runId).toBe(run2.runId);
  });

  it("runId differs when createdAt differs", () => {
    const run2 = createEvolutionRun(DEFAULT_EVOLUTION_CONFIG, manifest, 100, "2025-01-01T00:00:00.000Z");
    expect(run.runId).not.toBe(run2.runId);
  });

  it("stores the supplied config verbatim", () => {
    expect(run.config).toEqual(DEFAULT_EVOLUTION_CONFIG);
  });
});

// ─── F. createEvolutionSession ────────────────────────────────────────────────

describe("createEvolutionSession", () => {
  const session = createEvolutionSession(
    DEFAULT_EVOLUTION_CONFIG, MOCK_MC, MOCK_DATASET, 4, NOW,
  );

  it("runState and context are both present", () => {
    expect(session.runState).toBeDefined();
    expect(session.context).toBeDefined();
  });

  it("context symbol matches dataset", () => {
    expect(session.context.symbol).toBe(MOCK_DATASET.manifest.symbol);
  });

  it("context startingCash matches matchConfig", () => {
    expect(session.context.startingCash).toBe(MOCK_MC.startingCash);
  });

  it("context dataStartIdx/dataEndIdx match matchConfig", () => {
    expect(session.context.dataStartIdx).toBe(MOCK_MC.dataStartIdx);
    expect(session.context.dataEndIdx).toBe(MOCK_MC.dataEndIdx);
  });

  it("runState startingCash propagates to each initial bot's capital", () => {
    for (const spec of session.runState.activePop) {
      expect(spec.capital).toBe(MOCK_MC.startingCash);
    }
  });

  it("context.windowCount equals the argument passed", () => {
    expect(session.context.windowCount).toBe(4);
  });

  it("context.datasetFingerprint is a non-empty hex string", () => {
    expect(typeof session.context.datasetFingerprint).toBe("string");
    expect(session.context.datasetFingerprint.length).toBeGreaterThan(0);
    expect(/^[0-9a-f]+$/.test(session.context.datasetFingerprint)).toBe(true);
  });

  it("throws when config.populationSize does not equal BOT_REGISTRY.length", () => {
    const badConfig = { ...DEFAULT_EVOLUTION_CONFIG, populationSize: 99 };
    expect(() =>
      createEvolutionSession(badConfig, MOCK_MC, MOCK_DATASET, 4, NOW),
    ).toThrow(/populationSize/);
  });
});

// ─── F2. computeDatasetFingerprint ───────────────────────────────────────────

describe("computeDatasetFingerprint", () => {
  it("returns the same value for the same slice (deterministic)", () => {
    const f1 = computeDatasetFingerprint(MOCK_DATASET, 0, 99);
    const f2 = computeDatasetFingerprint(MOCK_DATASET, 0, 99);
    expect(f1).toBe(f2);
  });

  it("differs when the slice differs", () => {
    const f1 = computeDatasetFingerprint(MOCK_DATASET, 0, 99);
    const f2 = computeDatasetFingerprint(MOCK_DATASET, 100, 199);
    expect(f1).not.toBe(f2);
  });

  it("detects a single changed close value", () => {
    const altered = MOCK_DATASET.candles.map((c, i) =>
      i === 50 ? { ...c, close: c.close + 1 } : c,
    );
    const altDataset = { ...MOCK_DATASET, candles: altered };
    const f1 = computeDatasetFingerprint(MOCK_DATASET, 0, 99);
    const f2 = computeDatasetFingerprint(altDataset, 0, 99);
    expect(f1).not.toBe(f2);
  });

  it("is unaffected by candles outside the slice", () => {
    // Mutate a candle at index 200 — should not affect fingerprint of [0, 99]
    const altered = MOCK_DATASET.candles.map((c, i) =>
      i === 200 ? { ...c, close: 0 } : c,
    );
    const altDataset = { ...MOCK_DATASET, candles: altered };
    const f1 = computeDatasetFingerprint(MOCK_DATASET, 0, 99);
    const f2 = computeDatasetFingerprint(altDataset, 0, 99);
    expect(f1).toBe(f2);
  });

  it("returns an 8-char lowercase hex string", () => {
    const fp = computeDatasetFingerprint(MOCK_DATASET, 0, 10);
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
  });
});

// ─── G. contextMatchesCurrent ─────────────────────────────────────────────────

describe("contextMatchesCurrent", () => {
  let storedContext: EvolutionRunContext;

  beforeEach(() => {
    storedContext = buildRunContext(MOCK_MC, MOCK_DATASET, 4);
  });

  it("returns empty array when context matches exactly", () => {
    const mismatches = contextMatchesCurrent(storedContext, MOCK_MC, MOCK_DATASET);
    expect(mismatches).toHaveLength(0);
  });

  it("flags symbol mismatch", () => {
    const altDataset = {
      ...MOCK_DATASET,
      manifest: { ...MOCK_DATASET.manifest, symbol: "DIFF" },
    };
    const m = contextMatchesCurrent(storedContext, MOCK_MC, altDataset);
    expect(m.some((s) => s.includes("symbol"))).toBe(true);
  });

  it("flags startingCash mismatch", () => {
    const altMc: MatchConfig = { ...MOCK_MC, startingCash: 9999 };
    const m = contextMatchesCurrent(storedContext, altMc, MOCK_DATASET);
    expect(m.some((s) => s.includes("starting cash"))).toBe(true);
  });

  it("flags feeBps mismatch", () => {
    const altMc: MatchConfig = { ...MOCK_MC, feeBps: 50 };
    const m = contextMatchesCurrent(storedContext, altMc, MOCK_DATASET);
    expect(m.some((s) => s.includes("feeBps"))).toBe(true);
  });

  it("flags slippageBps mismatch", () => {
    const altMc: MatchConfig = { ...MOCK_MC, slippageBps: 25 };
    const m = contextMatchesCurrent(storedContext, altMc, MOCK_DATASET);
    expect(m.some((s) => s.includes("slippageBps"))).toBe(true);
  });

  it("flags seed mismatch", () => {
    const altMc: MatchConfig = { ...MOCK_MC, seed: 9999 };
    const m = contextMatchesCurrent(storedContext, altMc, MOCK_DATASET);
    expect(m.some((s) => s.includes("seed"))).toBe(true);
  });

  it("flags dataStartIdx mismatch", () => {
    const altMc: MatchConfig = { ...MOCK_MC, dataStartIdx: 50 };
    const m = contextMatchesCurrent(storedContext, altMc, MOCK_DATASET);
    expect(m.some((s) => s.includes("dataStartIdx"))).toBe(true);
  });

  it("flags dataEndIdx mismatch", () => {
    const altMc: MatchConfig = { ...MOCK_MC, dataEndIdx: MOCK_MC.dataEndIdx - 50 };
    const m = contextMatchesCurrent(storedContext, altMc, MOCK_DATASET);
    expect(m.some((s) => s.includes("dataEndIdx"))).toBe(true);
  });

  it("reports all mismatches at once (not just the first)", () => {
    const altMc: MatchConfig = { ...MOCK_MC, feeBps: 10, slippageBps: 5, seed: 1 };
    const m = contextMatchesCurrent(storedContext, altMc, MOCK_DATASET);
    expect(m.length).toBeGreaterThanOrEqual(3);
  });

  it("flags datasetFingerprint mismatch when candle data differs (same metadata)", () => {
    // Build an alternate dataset with identical metadata but one candle's close mutated.
    // This is the silent-substitution attack: same symbol/dates/count, different OHLCV.
    const altCandles = MOCK_DATASET.candles.map((c, i) =>
      i === 10 ? { ...c, close: c.close + 999.99 } : c,
    );
    const altDataset = { ...MOCK_DATASET, candles: altCandles };
    const m = contextMatchesCurrent(storedContext, MOCK_MC, altDataset);
    expect(m.some((s) => s.includes("fingerprint"))).toBe(true);
  });

  it("no false fingerprint mismatch when same candles loaded twice", () => {
    // Simulates user reloading identical data — fingerprint must still match.
    const m = contextMatchesCurrent(storedContext, MOCK_MC, { ...MOCK_DATASET });
    expect(m.some((s) => s.includes("fingerprint"))).toBe(false);
  });
});

// ─── H. Persistence ───────────────────────────────────────────────────────────

describe("persistence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("loadEvolutionSession returns null when nothing is stored", () => {
    expect(loadEvolutionSession()).toBeNull();
  });

  it("save → load round-trips runState and context", () => {
    const session = createEvolutionSession(
      DEFAULT_EVOLUTION_CONFIG, MOCK_MC, MOCK_DATASET, 4, NOW,
    );
    saveEvolutionSession(session);
    const loaded = loadEvolutionSession();

    expect(loaded).not.toBeNull();
    expect(loaded!.runState.runId).toBe(session.runState.runId);
    expect(loaded!.runState.generation).toBe(0);
    expect(loaded!.context.symbol).toBe(session.context.symbol);
    expect(loaded!.context.startingCash).toBe(session.context.startingCash);
  });

  it("clearEvolutionSession makes load return null", () => {
    const session = createEvolutionSession(
      DEFAULT_EVOLUTION_CONFIG, MOCK_MC, MOCK_DATASET, 4, NOW,
    );
    saveEvolutionSession(session);
    clearEvolutionSession();
    expect(loadEvolutionSession()).toBeNull();
  });

  it("returns null for a stale schema version (v: 0)", () => {
    localStorage.setItem(
      "bot-arena-evolution",
      JSON.stringify({ v: 0, runState: { runId: "x", generation: 0, activePop: [], config: {} }, context: { symbol: "X", startingCash: 100, dataStartIdx: 0, dataEndIdx: 0 } }),
    );
    expect(loadEvolutionSession()).toBeNull();
  });

  it("returns null for a stale schema version (v: 1 — pre-fingerprint)", () => {
    // v1 contexts lack datasetFingerprint and windowCount — should be rejected
    localStorage.setItem(
      "bot-arena-evolution",
      JSON.stringify({ v: 1, runState: { runId: "x", generation: 0, activePop: [], config: {} }, context: { symbol: "X", startingCash: 100, dataStartIdx: 0, dataEndIdx: 0 } }),
    );
    expect(loadEvolutionSession()).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    localStorage.setItem("bot-arena-evolution", "not json at all {{{{");
    expect(loadEvolutionSession()).toBeNull();
  });

  it("returns null when runState is missing required fields", () => {
    localStorage.setItem(
      "bot-arena-evolution",
      JSON.stringify({ v: 2, runState: { runId: "x" /* generation missing */ }, context: { symbol: "X", startingCash: 100, dataStartIdx: 0, dataEndIdx: 0, datasetFingerprint: "abc", windowCount: 4 } }),
    );
    expect(loadEvolutionSession()).toBeNull();
  });

  it("returns null when context is missing", () => {
    const session = createEvolutionSession(
      DEFAULT_EVOLUTION_CONFIG, MOCK_MC, MOCK_DATASET, 4, NOW,
    );
    const stored = { v: 2, runState: session.runState /* context omitted */ };
    localStorage.setItem("bot-arena-evolution", JSON.stringify(stored));
    expect(loadEvolutionSession()).toBeNull();
  });

  it("returns null when context.datasetFingerprint is missing (pre-v2 partial)", () => {
    const session = createEvolutionSession(
      DEFAULT_EVOLUTION_CONFIG, MOCK_MC, MOCK_DATASET, 4, NOW,
    );
    // Strip fingerprint to simulate a v2 record written without it
    const ctx = { ...session.context };
    delete (ctx as Record<string, unknown>).datasetFingerprint;
    localStorage.setItem("bot-arena-evolution", JSON.stringify({ v: 2, runState: session.runState, context: ctx }));
    expect(loadEvolutionSession()).toBeNull();
  });

  it("returns null when context.windowCount is missing", () => {
    const session = createEvolutionSession(
      DEFAULT_EVOLUTION_CONFIG, MOCK_MC, MOCK_DATASET, 4, NOW,
    );
    const ctx = { ...session.context };
    delete (ctx as Record<string, unknown>).windowCount;
    localStorage.setItem("bot-arena-evolution", JSON.stringify({ v: 2, runState: session.runState, context: ctx }));
    expect(loadEvolutionSession()).toBeNull();
  });

  it("round-trip preserves windowCount and datasetFingerprint", () => {
    const session = createEvolutionSession(
      DEFAULT_EVOLUTION_CONFIG, MOCK_MC, MOCK_DATASET, 4, NOW,
    );
    saveEvolutionSession(session);
    const loaded = loadEvolutionSession();
    expect(loaded!.context.windowCount).toBe(4);
    expect(loaded!.context.datasetFingerprint).toBe(session.context.datasetFingerprint);
  });
});

// ─── I. runEvolutionSeason ────────────────────────────────────────────────────

describe("runEvolutionSeason", () => {
  // Use a narrow slice so the test runs fast
  const narrowMc: MatchConfig = { ...MOCK_MC, dataStartIdx: 0, dataEndIdx: 99 };
  const activePop = buildInitialPopulation(
    "test-run", DEFAULT_EVOLUTION_CONFIG, 100, NOW,
  );

  it("returns a SeasonResult with the requested number of windows", () => {
    const result = runEvolutionSeason(activePop, narrowMc, 2, MOCK_DATASET);
    expect(result.windows).toHaveLength(2);
  });

  it("standings contain all evolved bot IDs (not registry IDs)", () => {
    const result = runEvolutionSeason(activePop, narrowMc, 2, MOCK_DATASET);
    const evolvedIds = new Set(activePop.map((s) => s.id));
    for (const w of result.windows) {
      for (const standing of w.standings) {
        expect(evolvedIds.has(standing.botId)).toBe(true);
      }
    }
  });

  it("each window's standings contains every active bot", () => {
    const result = runEvolutionSeason(activePop, narrowMc, 2, MOCK_DATASET);
    for (const w of result.windows) {
      expect(w.standings).toHaveLength(activePop.length);
    }
  });

  it("season id is prefixed with 'evolution-season-'", () => {
    const result = runEvolutionSeason(activePop, narrowMc, 2, MOCK_DATASET);
    expect(result.id.startsWith("evolution-season-")).toBe(true);
  });

  it("throws when a spec has an unknown archetype", () => {
    const badPop = [
      { ...activePop[0]!, archetype: "nonexistent-archetype" },
      ...activePop.slice(1),
    ];
    expect(() => runEvolutionSeason(badPop, narrowMc, 2, MOCK_DATASET)).toThrow(
      /unknown archetype/i,
    );
  });

  it("mutated params are used: changing mac periods changes result", () => {
    // Two populations differing only in mac shortPeriod/longPeriod
    const popDefault = buildInitialPopulation("run-a", DEFAULT_EVOLUTION_CONFIG, 100, NOW);
    const popMutated = popDefault.map((spec) =>
      spec.archetype === "mac"
        ? { ...spec, params: { ...spec.params, shortPeriod: 2, longPeriod: 5 } }
        : spec,
    );

    const r1 = runEvolutionSeason(popDefault, narrowMc, 2, MOCK_DATASET);
    const r2 = runEvolutionSeason(popMutated, narrowMc, 2, MOCK_DATASET);

    const macDefault = r1.windows[0]!.standings.find((s) => s.botName === "MA Crossover");
    const macMutated = r2.windows[0]!.standings.find((s) => s.botName === "MA Crossover");

    // The results won't be identical because different params → different trades
    // We can't assert exact values, but the objects should exist and at minimum
    // the mutated version with very tight periods should differ in tradeCount
    expect(macDefault).toBeDefined();
    expect(macMutated).toBeDefined();
    // Different params → different trade behaviour; at least one metric differs
    const sameResult =
      macDefault!.totalReturn === macMutated!.totalReturn &&
      macDefault!.tradeCount   === macMutated!.tradeCount;
    expect(sameResult).toBe(false);
  });
});
