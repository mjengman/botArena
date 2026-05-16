/**
 * paperLiveRunner.test.ts
 *
 * Tests for:
 *   - PaperLiveRunner (WS auth, subscription, bar processing, dedup, market guard,
 *     gap detection, reconnect, REST polling, stop)
 *   - liveSessionStorage (saveLiveSession, loadLiveSession, clearLiveSession, utcDateKey)
 *   - GovernanceEngine.getStats / injectStats additions
 */

// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PaperLiveRunner, DEFAULT_PAPER_LIVE_CONFIG } from "../src/engine/paperLiveRunner.ts";
import type { PaperLiveConfig } from "../src/engine/paperLiveRunner.ts";
import {
  saveLiveSession,
  loadLiveSession,
  clearLiveSession,
  utcDateKey,
} from "../src/engine/liveSessionStorage.ts";
import { GovernanceEngine } from "../src/engine/governance/governanceEngine.ts";
import { ConcreteEnablementGate } from "../src/engine/governance/enablementGate.ts";
import { AuditLog } from "../src/engine/governance/auditLog.ts";
import type { PaperAdapterConfig } from "../src/engine/brokerTypes.ts";
import { PaperLeagueRunner } from "../src/engine/paperLeagueRunner.ts";
import { SimulatedPaperAdapter } from "../src/engine/adapters/simulatedPaperAdapter.ts";
import type { ConcreteCredentialStore } from "../src/engine/governance/credentialStore.ts";
import type { Candle, SimulationConfig } from "../src/engine/types.ts";
import { buyAndHold } from "../src/strategies/buyAndHold.ts";

// ─── MockWebSocket ────────────────────────────────────────────────────────────

class MockWebSocket {
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  sentMessages: string[] = [];
  readyState = 1;

  send(data: string) { this.sentMessages.push(data); }
  close() { this.onclose?.({ code: 1000, reason: "" } as CloseEvent); }

  triggerOpen() { this.onopen?.(new Event("open")); }
  triggerMessage(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
  triggerClose(code = 1000) { this.onclose?.({ code, reason: "" } as CloseEvent); }
  triggerError() { this.onerror?.(new Event("error")); }
}

// ─── FAST_CONFIG ──────────────────────────────────────────────────────────────

const FAST_CONFIG: PaperLiveConfig = {
  ...DEFAULT_PAPER_LIVE_CONFIG,
  wsReconnectDelayMs: 0,
  restPollIntervalMs: 999_999,
  bootstrapBars: 0,
};

// ─── Mock helpers ─────────────────────────────────────────────────────────────

const baseGovConfig: PaperAdapterConfig = {
  allowedSymbols: ["SPY"],
  maxOpenOrders: 10,
  maxOrdersPerDay: 20,
  maxOrderNotional: 10_500,
  driftToleranceShares: 1,
  driftToleranceCash: 10,
  autoDisarmAfterMs: 4 * 60 * 60 * 1000,
  maxPositionFractionOfEquity: 0.99,
  maxRealizedDailyLossUsd: 1_000,
  botCapitalAllocationUsd: 10_000,
};

function makeArmedStore(): ConcreteCredentialStore {
  // Mock store that always returns credentials
  return {
    get: () => ({
      apiKey: "test-key",
      apiSecret: "test-secret",
      baseUrl: "https://paper-api.alpaca.markets",
    }),
    set: vi.fn(),
    clear: vi.fn(),
    hasCredentials: true,
    peekForArming: () => null,
    onArmed: vi.fn(),
    onDisarmed: vi.fn(),
  } as unknown as ConcreteCredentialStore;
}

async function makeArmedGateAsync(): Promise<ConcreteEnablementGate> {
  const auditLog = new AuditLog();
  const gate = new ConcreteEnablementGate(
    [async () => ({ check: "test", passed: true })],
    auditLog,
  );
  await gate.arm();
  return gate;
}

const mockLeagueRunner = {
  start: vi.fn().mockResolvedValue(undefined),
  tick: vi.fn().mockResolvedValue(undefined),
  end: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockReturnValue({
    running: true,
    candlesProcessed: 0,
    allocations: [],
    unallocatedCash: 0,
    startedAt: Date.now(),
  }),
} as unknown as PaperLeagueRunner;

function makeMockGovernance(): GovernanceEngine {
  return {
    getStats: vi.fn().mockReturnValue(undefined),
    injectStats: vi.fn(),
    resetStats: vi.fn(),
    setEligibilityStatus: vi.fn(),
  } as unknown as GovernanceEngine;
}

function makeBarMsg(t: string, symbol = "SPY") {
  return [{ T: "b", S: symbol, o: 100, h: 102, l: 99, c: 101, v: 1000, t }];
}

// ─── Test setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Reset mockLeagueRunner mocks
  (mockLeagueRunner.start as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (mockLeagueRunner.tick as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (mockLeagueRunner.end as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  // Clear localStorage
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── PaperLiveRunner tests ────────────────────────────────────────────────────

describe("PaperLiveRunner — snapshot getter", () => {
  it("returns a LiveRunnerSnapshot with default values before start()", async () => {
    const gate = await makeArmedGateAsync();
    const auditLog = new AuditLog();
    const governance = makeMockGovernance();
    const store = makeArmedStore();
    let wsInstance: MockWebSocket | null = null;

    const runner = new PaperLiveRunner(
      mockLeagueRunner,
      store,
      governance,
      auditLog,
      gate,
      "SPY",
      FAST_CONFIG,
      [],
      (url) => { wsInstance = new MockWebSocket(); void url; return wsInstance as unknown as WebSocket; },
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ is_open: true, next_open: "", next_close: "" }) }),
    );

    const snap = runner.snapshot;
    expect(snap.isMarketOpen).toBe(false);
    expect(snap.barsReceived).toBe(0);
    expect(snap.lastBarAt).toBeNull();
    expect(snap.wsStatus).toBe("disconnected");
  });
});

describe("PaperLiveRunner — WS auth flow", () => {
  it("sends auth message after WS open", async () => {
    const gate = await makeArmedGateAsync();
    const auditLog = new AuditLog();
    const governance = makeMockGovernance();
    const store = makeArmedStore();
    let wsInstance: MockWebSocket | null = null;

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ is_open: true, next_open: "", next_close: "" }),
    } as Response);

    const runner = new PaperLiveRunner(
      mockLeagueRunner,
      store,
      governance,
      auditLog,
      gate,
      "SPY",
      FAST_CONFIG,
      [],
      (url) => {
        wsInstance = new MockWebSocket();
        void url;
        return wsInstance as unknown as WebSocket;
      },
      fetchMock,
    );

    const startPromise = runner.start();
    // Flush clock fetch promise
    await Promise.resolve();
    await Promise.resolve();
    startPromise.then(() => {/* void */}).catch(() => {/* void */});

    await startPromise;

    expect(wsInstance).not.toBeNull();
    wsInstance!.triggerOpen();
    // Wait for auth send
    await Promise.resolve();

    expect(wsInstance!.sentMessages.length).toBeGreaterThanOrEqual(1);
    const authMsg = JSON.parse(wsInstance!.sentMessages[0]!);
    expect(authMsg.action).toBe("auth");
    expect(authMsg.key).toBe("test-key");
    expect(authMsg.secret).toBe("test-secret");

    await runner.stop();
  });

  it("sends subscription message after auth success", async () => {
    const gate = await makeArmedGateAsync();
    const auditLog = new AuditLog();
    const governance = makeMockGovernance();
    const store = makeArmedStore();
    let wsInstance: MockWebSocket | null = null;

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ is_open: true, next_open: "", next_close: "" }),
    } as Response);

    const runner = new PaperLiveRunner(
      mockLeagueRunner,
      store,
      governance,
      auditLog,
      gate,
      "SPY",
      FAST_CONFIG,
      [],
      (url) => {
        wsInstance = new MockWebSocket();
        void url;
        return wsInstance as unknown as WebSocket;
      },
      fetchMock,
    );

    await runner.start();
    wsInstance!.triggerOpen();
    await Promise.resolve();

    // Trigger auth success
    wsInstance!.triggerMessage([{ T: "success", msg: "authenticated" }]);
    await Promise.resolve();

    expect(wsInstance!.sentMessages.length).toBeGreaterThanOrEqual(2);
    const subMsg = JSON.parse(wsInstance!.sentMessages[1]!);
    expect(subMsg.action).toBe("subscribe");
    expect(subMsg.bars).toContain("SPY");

    await runner.stop();
  });

  it("sets wsStatus to 'connected' after subscription confirmation", async () => {
    const gate = await makeArmedGateAsync();
    const auditLog = new AuditLog();
    const governance = makeMockGovernance();
    const store = makeArmedStore();
    let wsInstance: MockWebSocket | null = null;
    const snapshots: import("../src/engine/paperLiveRunner.ts").LiveRunnerSnapshot[] = [];

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ is_open: true, next_open: "", next_close: "" }),
    } as Response);

    const runner = new PaperLiveRunner(
      mockLeagueRunner,
      store,
      governance,
      auditLog,
      gate,
      "SPY",
      FAST_CONFIG,
      [],
      (url) => {
        wsInstance = new MockWebSocket();
        void url;
        return wsInstance as unknown as WebSocket;
      },
      fetchMock,
    );

    runner.onSnapshot = (s) => snapshots.push(s);
    await runner.start();

    wsInstance!.triggerOpen();
    await Promise.resolve();
    wsInstance!.triggerMessage([{ T: "success", msg: "authenticated" }]);
    await Promise.resolve();
    wsInstance!.triggerMessage([{ T: "subscription", bars: ["SPY"] }]);
    await Promise.resolve();

    const lastSnap = snapshots[snapshots.length - 1]!;
    expect(lastSnap.wsStatus).toBe("connected");

    await runner.stop();
  });
});

describe("PaperLiveRunner — bar processing", () => {
  it("increments barsReceived when a bar message is received", async () => {
    const gate = await makeArmedGateAsync();
    const auditLog = new AuditLog();
    const governance = makeMockGovernance();
    const store = makeArmedStore();
    let wsInstance: MockWebSocket | null = null;

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ is_open: true, next_open: "", next_close: "" }),
    } as Response);

    const runner = new PaperLiveRunner(
      mockLeagueRunner,
      store,
      governance,
      auditLog,
      gate,
      "SPY",
      FAST_CONFIG,
      [],
      (url) => {
        wsInstance = new MockWebSocket();
        void url;
        return wsInstance as unknown as WebSocket;
      },
      fetchMock,
    );

    await runner.start();
    wsInstance!.triggerOpen();
    await Promise.resolve();
    wsInstance!.triggerMessage([{ T: "success", msg: "authenticated" }]);
    await Promise.resolve();
    wsInstance!.triggerMessage([{ T: "subscription", bars: ["SPY"] }]);
    await Promise.resolve();

    // Send a bar
    wsInstance!.triggerMessage(makeBarMsg("2026-05-16T14:30:00Z"));
    // Wait for async processing
    await new Promise((r) => setTimeout(r, 10));

    expect(runner.snapshot.barsReceived).toBe(1);
    expect(runner.snapshot.lastBarAt).toBe(Date.parse("2026-05-16T14:30:00Z"));

    await runner.stop();
  });

  it("does not process a bar with the same timestamp (deduplication)", async () => {
    const gate = await makeArmedGateAsync();
    const auditLog = new AuditLog();
    const governance = makeMockGovernance();
    const store = makeArmedStore();
    let wsInstance: MockWebSocket | null = null;

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ is_open: true, next_open: "", next_close: "" }),
    } as Response);

    const runner = new PaperLiveRunner(
      mockLeagueRunner,
      store,
      governance,
      auditLog,
      gate,
      "SPY",
      FAST_CONFIG,
      [],
      (url) => {
        wsInstance = new MockWebSocket();
        void url;
        return wsInstance as unknown as WebSocket;
      },
      fetchMock,
    );

    await runner.start();
    wsInstance!.triggerOpen();
    await Promise.resolve();
    wsInstance!.triggerMessage([{ T: "success", msg: "authenticated" }]);
    await Promise.resolve();
    wsInstance!.triggerMessage([{ T: "subscription", bars: ["SPY"] }]);
    await Promise.resolve();

    const t = "2026-05-16T14:30:00Z";
    wsInstance!.triggerMessage(makeBarMsg(t));
    await new Promise((r) => setTimeout(r, 10));
    expect(runner.snapshot.barsReceived).toBe(1);

    // Send same bar again
    wsInstance!.triggerMessage(makeBarMsg(t));
    await new Promise((r) => setTimeout(r, 10));
    expect(runner.snapshot.barsReceived).toBe(1); // still 1

    await runner.stop();
  });

  it("does not call tick() when market is closed", async () => {
    const gate = await makeArmedGateAsync();
    const auditLog = new AuditLog();
    const governance = makeMockGovernance();
    const store = makeArmedStore();
    let wsInstance: MockWebSocket | null = null;

    // Clock returns market closed
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          is_open: false,
          next_open: "2026-05-17T09:30:00Z",
          next_close: "2026-05-17T16:00:00Z",
        }),
    } as Response);

    const tickFn = vi.fn().mockResolvedValue(undefined);
    const closedLeagueRunner = {
      ...mockLeagueRunner,
      tick: tickFn,
    } as unknown as PaperLeagueRunner;

    const runner = new PaperLiveRunner(
      closedLeagueRunner,
      store,
      governance,
      auditLog,
      gate,
      "SPY",
      FAST_CONFIG,
      [],
      (url) => {
        wsInstance = new MockWebSocket();
        void url;
        return wsInstance as unknown as WebSocket;
      },
      fetchMock,
    );

    await runner.start();
    wsInstance!.triggerOpen();
    await Promise.resolve();
    wsInstance!.triggerMessage([{ T: "success", msg: "authenticated" }]);
    await Promise.resolve();
    wsInstance!.triggerMessage([{ T: "subscription", bars: ["SPY"] }]);
    await Promise.resolve();

    wsInstance!.triggerMessage(makeBarMsg("2026-05-16T14:30:00Z"));
    await new Promise((r) => setTimeout(r, 10));

    expect(tickFn).not.toHaveBeenCalled();
    expect(runner.snapshot.barsReceived).toBe(0);

    await runner.stop();
  });

  it("calls tick() when market is open", async () => {
    const gate = await makeArmedGateAsync();
    const auditLog = new AuditLog();
    const governance = makeMockGovernance();
    const store = makeArmedStore();
    let wsInstance: MockWebSocket | null = null;

    // Clock returns market open
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          is_open: true,
          next_open: "2026-05-17T09:30:00Z",
          next_close: "2026-05-17T16:00:00Z",
        }),
    } as Response);

    const tickFn = vi.fn().mockResolvedValue(undefined);
    const openLeagueRunner = {
      ...mockLeagueRunner,
      tick: tickFn,
      start: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined),
    } as unknown as PaperLeagueRunner;

    const runner = new PaperLiveRunner(
      openLeagueRunner,
      store,
      governance,
      auditLog,
      gate,
      "SPY",
      FAST_CONFIG,
      [],
      (url) => {
        wsInstance = new MockWebSocket();
        void url;
        return wsInstance as unknown as WebSocket;
      },
      fetchMock,
    );

    await runner.start();
    wsInstance!.triggerOpen();
    await Promise.resolve();
    wsInstance!.triggerMessage([{ T: "success", msg: "authenticated" }]);
    await Promise.resolve();
    wsInstance!.triggerMessage([{ T: "subscription", bars: ["SPY"] }]);
    await Promise.resolve();

    wsInstance!.triggerMessage(makeBarMsg("2026-05-16T14:30:00Z"));
    await new Promise((r) => setTimeout(r, 20));

    expect(tickFn).toHaveBeenCalledTimes(1);
    expect(runner.snapshot.barsReceived).toBe(1);

    await runner.stop();
  });

  it("logs BAR_GAP when bars have > 2 minute gap", async () => {
    const gate = await makeArmedGateAsync();
    const auditLog = new AuditLog();
    const governance = makeMockGovernance();
    const store = makeArmedStore();
    let wsInstance: MockWebSocket | null = null;

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          is_open: true,
          next_open: "2026-05-17T09:30:00Z",
          next_close: "2026-05-17T16:00:00Z",
        }),
    } as Response);

    const runner = new PaperLiveRunner(
      mockLeagueRunner,
      store,
      governance,
      auditLog,
      gate,
      "SPY",
      FAST_CONFIG,
      [],
      (url) => {
        wsInstance = new MockWebSocket();
        void url;
        return wsInstance as unknown as WebSocket;
      },
      fetchMock,
    );

    await runner.start();
    wsInstance!.triggerOpen();
    await Promise.resolve();
    wsInstance!.triggerMessage([{ T: "success", msg: "authenticated" }]);
    await Promise.resolve();
    wsInstance!.triggerMessage([{ T: "subscription", bars: ["SPY"] }]);
    await Promise.resolve();

    // First bar
    wsInstance!.triggerMessage(makeBarMsg("2026-05-16T14:30:00Z"));
    await new Promise((r) => setTimeout(r, 20));

    // Bar with > 2 min gap (15 minutes later)
    wsInstance!.triggerMessage(makeBarMsg("2026-05-16T14:45:00Z"));
    await new Promise((r) => setTimeout(r, 20));

    // Check audit log for BAR_GAP
    const entries = auditLog.getEntries();
    const gapEntry = entries.find(
      (e) => e.type === "ERROR" && e.message.includes("BAR_GAP"),
    );
    expect(gapEntry).toBeDefined();

    await runner.stop();
  });
});

describe("PaperLiveRunner — WS reconnect", () => {
  it("attempts reconnect after WS close (wsReconnectAttempts < max)", async () => {
    const gate = await makeArmedGateAsync();
    const auditLog = new AuditLog();
    const governance = makeMockGovernance();
    const store = makeArmedStore();
    const wsInstances: MockWebSocket[] = [];

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ is_open: true, next_open: "", next_close: "" }),
    } as Response);

    const runner = new PaperLiveRunner(
      mockLeagueRunner,
      store,
      governance,
      auditLog,
      gate,
      "SPY",
      { ...FAST_CONFIG, wsReconnectDelayMs: 0 },
      [],
      (url) => {
        const ws = new MockWebSocket();
        wsInstances.push(ws);
        void url;
        return ws as unknown as WebSocket;
      },
      fetchMock,
    );

    await runner.start();
    expect(wsInstances.length).toBe(1);

    // Trigger WS close — should schedule reconnect with delay=0
    wsInstances[0]!.triggerClose(1001);

    // Wait a tick for setTimeout(fn, 0) to fire
    await new Promise((r) => setTimeout(r, 10));

    // A second WS should have been created
    expect(wsInstances.length).toBeGreaterThanOrEqual(2);

    await runner.stop();
  });
});

describe("PaperLiveRunner — REST polling", () => {
  it("_pollRestBar calls fetch latest bar and processes new bar", async () => {
    const gate = await makeArmedGateAsync();
    const auditLog = new AuditLog();
    const governance = makeMockGovernance();
    const store = makeArmedStore();
    let wsInstance: MockWebSocket | null = null;

    const t = "2026-05-16T14:30:00Z";
    let callCount = 0;

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      callCount++;
      if (String(url).includes("/bars/latest")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              symbol: "SPY",
              bar: { t, o: 100, h: 102, l: 99, c: 101, v: 1000 },
            }),
        } as Response);
      }
      // clock
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({ is_open: true, next_open: "", next_close: "" }),
      } as Response);
    });

    const config: PaperLiveConfig = {
      ...FAST_CONFIG,
      restPollIntervalMs: 50, // Fire quickly for test
      bootstrapBars: 0,
    };

    const runner = new PaperLiveRunner(
      mockLeagueRunner,
      store,
      governance,
      auditLog,
      gate,
      "SPY",
      config,
      [],
      (url) => {
        wsInstance = new MockWebSocket();
        void url;
        return wsInstance as unknown as WebSocket;
      },
      fetchMock,
    );

    await runner.start();

    // Wait for REST polling to fire
    await new Promise((r) => setTimeout(r, 120));

    // The latest-bar endpoint should have been called
    const latestBarCalls = (fetchMock.mock.calls as [string][]).filter(([url]) =>
      String(url).includes("/bars/latest"),
    );
    expect(latestBarCalls.length).toBeGreaterThanOrEqual(1);

    // Bar should have been processed
    expect(runner.snapshot.barsReceived).toBeGreaterThanOrEqual(1);

    await runner.stop();
  });
});

describe("PaperLiveRunner — stop()", () => {
  it("closes WS and calls leagueRunner.end()", async () => {
    const gate = await makeArmedGateAsync();
    const auditLog = new AuditLog();
    const governance = makeMockGovernance();
    const store = makeArmedStore();
    let wsInstance: MockWebSocket | null = null;

    const endFn = vi.fn().mockResolvedValue(undefined);
    const stoppedRunner = {
      ...mockLeagueRunner,
      end: endFn,
      start: vi.fn().mockResolvedValue(undefined),
    } as unknown as PaperLeagueRunner;

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ is_open: true, next_open: "", next_close: "" }),
    } as Response);

    const runner = new PaperLiveRunner(
      stoppedRunner,
      store,
      governance,
      auditLog,
      gate,
      "SPY",
      FAST_CONFIG,
      [],
      (url) => {
        wsInstance = new MockWebSocket();
        void url;
        return wsInstance as unknown as WebSocket;
      },
      fetchMock,
    );

    await runner.start();
    expect(wsInstance).not.toBeNull();

    await runner.stop("test stop");

    expect(endFn).toHaveBeenCalled();
  });
});

// ─── liveSessionStorage tests ──────────────────────────────────────────────────

describe("liveSessionStorage — utcDateKey", () => {
  it("returns a YYYY-MM-DD formatted string", () => {
    const key = utcDateKey();
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns the correct UTC date for a known timestamp", () => {
    // 2026-05-16T12:00:00Z
    const ts = Date.UTC(2026, 4, 16, 12, 0, 0);
    expect(utcDateKey(ts)).toBe("2026-05-16");
  });

  it("handles year boundary correctly", () => {
    // 2026-01-01T00:00:00Z
    const ts = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(utcDateKey(ts)).toBe("2026-01-01");
  });
});

describe("liveSessionStorage — save/load round-trip", () => {
  it("saves and loads a session for today", () => {
    const today = utcDateKey();
    const barHistory: Candle[] = [
      { timestamp: 1000, open: 100, high: 102, low: 99, close: 101, volume: 500 },
    ];

    saveLiveSession({
      symbol: "SPY",
      sessionDate: today,
      barHistory,
      barsReceived: 1,
      lastBarAt: 1000,
      botStats: [{ botId: "bah", dailyOrderCount: 2, realizedDailyLossUsd: 10, dayKey: today }],
      sleeves: [],
      unallocatedCash: 0,
    });

    const loaded = loadLiveSession("SPY");
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(2);
    expect(loaded!.symbol).toBe("SPY");
    expect(loaded!.sessionDate).toBe(today);
    expect(loaded!.barsReceived).toBe(1);
    expect(loaded!.lastBarAt).toBe(1000);
    expect(loaded!.barHistory.length).toBe(1);
    expect(loaded!.botStats[0]!.dailyOrderCount).toBe(2);
  });

  it("returns null for a wrong-day session", () => {
    const yesterday = utcDateKey(Date.now() - 24 * 60 * 60 * 1000);
    const key = `arena-live-SPY-${yesterday}`;
    localStorage.setItem(
      key,
      JSON.stringify({
        version: 2,
        symbol: "SPY",
        sessionDate: yesterday,
        barHistory: [],
        barsReceived: 0,
        lastBarAt: null,
        botStats: [],
        sleeves: [],
        unallocatedCash: 0,
      }),
    );

    // loadLiveSession only loads today's session
    const loaded = loadLiveSession("SPY");
    expect(loaded).toBeNull();
  });

  it("returns null for a different symbol", () => {
    const today = utcDateKey();
    saveLiveSession({
      symbol: "AAPL",
      sessionDate: today,
      barHistory: [],
      barsReceived: 0,
      lastBarAt: null,
      botStats: [],
      sleeves: [],
      unallocatedCash: 0,
    });

    const loaded = loadLiveSession("SPY");
    expect(loaded).toBeNull();
  });

  it("caps bar history at 500 entries", () => {
    const today = utcDateKey();
    const barHistory: Candle[] = Array.from({ length: 600 }, (_, i) => ({
      timestamp: i * 60_000,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 100,
    }));

    saveLiveSession({
      symbol: "SPY",
      sessionDate: today,
      barHistory,
      barsReceived: 600,
      lastBarAt: 599 * 60_000,
      botStats: [],
      sleeves: [],
      unallocatedCash: 0,
    });

    const loaded = loadLiveSession("SPY");
    expect(loaded).not.toBeNull();
    expect(loaded!.barHistory.length).toBe(500);
    // Most recent 500 should be retained (indices 100–599)
    expect(loaded!.barHistory[0]!.timestamp).toBe(100 * 60_000);
  });
});

describe("liveSessionStorage — clearLiveSession", () => {
  it("removes the entry from localStorage", () => {
    const today = utcDateKey();
    saveLiveSession({
      symbol: "SPY",
      sessionDate: today,
      barHistory: [],
      barsReceived: 0,
      lastBarAt: null,
      botStats: [],
      sleeves: [],
      unallocatedCash: 0,
    });

    expect(loadLiveSession("SPY")).not.toBeNull();

    clearLiveSession("SPY");

    expect(loadLiveSession("SPY")).toBeNull();
  });

  it("does not throw if no entry exists", () => {
    expect(() => clearLiveSession("NONEXISTENT")).not.toThrow();
  });
});

// ─── liveSessionStorage — schema version validation ───────────────────────────

describe("liveSessionStorage — version validation", () => {
  it("rejects a version-1 (pre-sleeve) record stored under today's key", () => {
    const today = utcDateKey();
    const key = `arena-live-SPY-${today}`;
    // Simulate an old M13-first-commit record that lacks sleeves/unallocatedCash
    localStorage.setItem(
      key,
      JSON.stringify({
        version: 1,
        symbol: "SPY",
        sessionDate: today,
        barHistory: [],
        barsReceived: 0,
        lastBarAt: null,
        botStats: [],
        // no sleeves, no unallocatedCash
      }),
    );

    // Must return null — stale v1 schema must not be used for sleeve recovery
    expect(loadLiveSession("SPY")).toBeNull();
  });

  it("accepts a version-2 record with correct sleeves + unallocatedCash", () => {
    const today = utcDateKey();
    saveLiveSession({
      symbol: "SPY",
      sessionDate: today,
      barHistory: [],
      barsReceived: 0,
      lastBarAt: null,
      botStats: [],
      sleeves: [
        {
          botId: "bah",
          cash: 8_000,
          positions: [],
          realizedPnl: 0,
          currentAllocation: 10_000,
          eligibilityStatus: "ACTIVE",
        },
      ],
      unallocatedCash: 500,
    });

    const loaded = loadLiveSession("SPY");
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(2);
    expect(loaded!.sleeves).toHaveLength(1);
    expect(loaded!.sleeves[0]!.cash).toBe(8_000);
    expect(loaded!.unallocatedCash).toBe(500);
  });
});

// ─── PaperLiveRunner — clock fail-closed (P1) ─────────────────────────────────

describe("PaperLiveRunner — clock fetch failure skips bar (fail-closed)", () => {
  it("skips bar and updates _lastBarAt when clock fetch throws", async () => {
    const gate = await makeArmedGateAsync();
    const auditLog = new AuditLog();
    const governance = makeMockGovernance();
    const store = makeArmedStore();
    let wsInstance: MockWebSocket | null = null;

    const tickFn = vi.fn().mockResolvedValue(undefined);
    const failRunner = {
      ...mockLeagueRunner,
      tick: tickFn,
    } as unknown as PaperLeagueRunner;

    // Initial clock succeeds (market open), then subsequent clocks throw
    let clockCallCount = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/clock")) {
        clockCallCount++;
        if (clockCallCount > 1) {
          // All per-bar clock checks fail
          return Promise.reject(new Error("network timeout"));
        }
        // Initial clock at start() succeeds
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ is_open: true, next_open: "", next_close: "" }),
        } as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });

    const runner = new PaperLiveRunner(
      failRunner,
      store,
      governance,
      auditLog,
      gate,
      "SPY",
      FAST_CONFIG,
      [],
      (url) => {
        wsInstance = new MockWebSocket();
        void url;
        return wsInstance as unknown as WebSocket;
      },
      fetchMock,
    );

    await runner.start();
    wsInstance!.triggerOpen();
    await Promise.resolve();
    wsInstance!.triggerMessage([{ T: "success", msg: "authenticated" }]);
    await Promise.resolve();
    wsInstance!.triggerMessage([{ T: "subscription", bars: ["SPY"] }]);
    await Promise.resolve();

    const t = "2026-05-16T14:30:00Z";

    // Deliver a bar — per-bar clock fetch will throw
    wsInstance!.triggerMessage(makeBarMsg(t));
    await new Promise((r) => setTimeout(r, 20));

    // tick must NOT have been called — we failed closed
    expect(tickFn).not.toHaveBeenCalled();
    expect(runner.snapshot.barsReceived).toBe(0);

    // _lastBarAt must have been updated so same bar is not retried
    expect(runner.snapshot.lastBarAt).toBe(Date.parse(t));

    await runner.stop();
  });

  it("does not skip bar when clock fetch succeeds (regression guard)", async () => {
    const gate = await makeArmedGateAsync();
    const auditLog = new AuditLog();
    const governance = makeMockGovernance();
    const store = makeArmedStore();
    let wsInstance: MockWebSocket | null = null;

    const tickFn = vi.fn().mockResolvedValue(undefined);
    const openRunner = {
      ...mockLeagueRunner,
      tick: tickFn,
    } as unknown as PaperLeagueRunner;

    // Clock always succeeds and says market is open
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ is_open: true, next_open: "", next_close: "" }),
    } as Response);

    const runner = new PaperLiveRunner(
      openRunner,
      store,
      governance,
      auditLog,
      gate,
      "SPY",
      FAST_CONFIG,
      [],
      (url) => {
        wsInstance = new MockWebSocket();
        void url;
        return wsInstance as unknown as WebSocket;
      },
      fetchMock,
    );

    await runner.start();
    wsInstance!.triggerOpen();
    await Promise.resolve();
    wsInstance!.triggerMessage([{ T: "success", msg: "authenticated" }]);
    await Promise.resolve();
    wsInstance!.triggerMessage([{ T: "subscription", bars: ["SPY"] }]);
    await Promise.resolve();

    wsInstance!.triggerMessage(makeBarMsg("2026-05-16T14:31:00Z"));
    await new Promise((r) => setTimeout(r, 20));

    expect(tickFn).toHaveBeenCalledOnce();
    expect(runner.snapshot.barsReceived).toBe(1);

    await runner.stop();
  });
});

// ─── GovernanceEngine — getStats / injectStats ────────────────────────────────

describe("GovernanceEngine — getStats / injectStats", () => {
  async function makeGovernanceWithArmedGate() {
    const auditLog = new AuditLog();
    const gate = new ConcreteEnablementGate(
      [async () => ({ check: "test", passed: true })],
      auditLog,
    );
    await gate.arm();
    const engine = new GovernanceEngine(baseGovConfig, gate, auditLog);
    return { engine, gate, auditLog };
  }

  it("getStats returns undefined for an unknown bot", async () => {
    const { engine } = await makeGovernanceWithArmedGate();
    expect(engine.getStats("never-seen-bot")).toBeUndefined();
  });

  it("injectStats + getStats round-trip", async () => {
    const { engine } = await makeGovernanceWithArmedGate();
    const today = utcDateKey();
    engine.injectStats("bot-x", {
      dailyOrderCount: 5,
      realizedDailyLossUsd: 150,
      committedCapitalUsd: 2000,
      dayKey: today,
    });

    const stats = engine.getStats("bot-x");
    expect(stats).toBeDefined();
    expect(stats!.dailyOrderCount).toBe(5);
    expect(stats!.realizedDailyLossUsd).toBe(150);
    expect(stats!.committedCapitalUsd).toBe(2000);
    expect(stats!.dayKey).toBe(today);
  });

  it("injectStats + resetStats(false) preserves daily counters when dayKey matches today", async () => {
    const { engine } = await makeGovernanceWithArmedGate();
    const today = utcDateKey();

    engine.injectStats("bot-y", {
      dailyOrderCount: 3,
      realizedDailyLossUsd: 50,
      committedCapitalUsd: 500,
      dayKey: today,
    });

    // resetStats(false) = date-aware reset: preserve daily counters on same day
    engine.resetStats("bot-y", false);

    const stats = engine.getStats("bot-y");
    expect(stats).toBeDefined();
    expect(stats!.dailyOrderCount).toBe(3);       // preserved
    expect(stats!.realizedDailyLossUsd).toBe(50); // preserved
    expect(stats!.committedCapitalUsd).toBe(0);   // always reset
  });

  it("injectStats + resetStats(true) clears all counters", async () => {
    const { engine } = await makeGovernanceWithArmedGate();
    const today = utcDateKey();

    engine.injectStats("bot-z", {
      dailyOrderCount: 7,
      realizedDailyLossUsd: 200,
      committedCapitalUsd: 1000,
      dayKey: today,
    });

    engine.resetStats("bot-z", true);

    const stats = engine.getStats("bot-z");
    expect(stats).toBeDefined();
    expect(stats!.dailyOrderCount).toBe(0);
    expect(stats!.realizedDailyLossUsd).toBe(0);
    expect(stats!.committedCapitalUsd).toBe(0);
  });
});

// ─── PaperLeagueRunner — getSleeveSnapshots / injectSleeveState ───────────────

describe("PaperLeagueRunner — getSleeveSnapshots / injectSleeveState (P0 recovery)", () => {
  const SIM_CFG: SimulationConfig = {
    startingCash: 10_000,
    feeBps: 5,
    slippageBps: 5,
    seed: 1,
  };

  const PAPER_CFG: PaperAdapterConfig = {
    allowedSymbols: ["SPY"],
    maxOpenOrders: 10,
    maxOrdersPerDay: 20,
    maxOrderNotional: 100_000,
    driftToleranceShares: 1,
    driftToleranceCash: 10,
    autoDisarmAfterMs: 4 * 60 * 60 * 1000,
    maxPositionFractionOfEquity: 0.99,
    maxRealizedDailyLossUsd: 5_000,
    botCapitalAllocationUsd: 10_000,
  };

  async function makeLeague() {
    const auditLog = new AuditLog();
    const gate = new ConcreteEnablementGate(
      [async () => ({ check: "test", passed: true })],
      auditLog,
    );
    await gate.arm();
    const governance = new GovernanceEngine(PAPER_CFG, gate, auditLog);
    const adapter = new SimulatedPaperAdapter(SIM_CFG.feeBps, SIM_CFG.slippageBps);
    const botSpec = { id: "bah", name: "Buy & Hold", strategy: buyAndHold };
    const runner = new PaperLeagueRunner(
      SIM_CFG,
      [botSpec],
      { bah: 10_000 },
      adapter,
      governance,
      auditLog,
      gate,
      "SPY",
      500, // $500 unallocated
    );
    return { runner, gate, auditLog, governance };
  }

  it("getSleeveSnapshots returns a snapshot with initial sleeve state", async () => {
    const { runner } = await makeLeague();
    const snaps = runner.getSleeveSnapshots();

    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.botId).toBe("bah");
    expect(snaps[0]!.cash).toBe(10_000);
    expect(snaps[0]!.realizedPnl).toBe(0);
    expect(snaps[0]!.currentAllocation).toBe(10_000);
    expect(snaps[0]!.eligibilityStatus).toBe("ACTIVE");
    expect(snaps[0]!.positions).toHaveLength(0);
    expect(snaps[0]!.eliminatedAtEquity).toBeUndefined();
  });

  it("injectSleeveState restores cash, positions, and allocation", async () => {
    const { runner } = await makeLeague();

    // Inject a modified state simulating a mid-session save
    runner.injectSleeveState(
      [
        {
          botId: "bah",
          cash: 7_500,
          positions: [{ symbol: "SPY", quantity: 25, avgCost: 100 }],
          realizedPnl: 50,
          currentAllocation: 10_000,
          eligibilityStatus: "ACTIVE",
        },
      ],
      750, // unallocatedCash
      102, // latestClose — marks 25 shares × $102 = $2550 position value
    );

    const snaps = runner.getSleeveSnapshots();
    expect(snaps[0]!.cash).toBe(7_500);
    expect(snaps[0]!.positions).toHaveLength(1);
    expect(snaps[0]!.positions[0]!.quantity).toBe(25);
    expect(snaps[0]!.positions[0]!.avgCost).toBe(100);
    expect(snaps[0]!.realizedPnl).toBe(50);

    // getState() should reflect the updated unallocatedCash
    expect(runner.getState().unallocatedCash).toBe(750);
  });

  it("injectSleeveState restores eligibility status and reason", async () => {
    const { runner } = await makeLeague();

    runner.injectSleeveState(
      [
        {
          botId: "bah",
          cash: 9_000,
          positions: [],
          realizedPnl: 0,
          currentAllocation: 9_000,
          eligibilityStatus: "PAUSED",
          eligibilityReason: "paused by user",
        },
      ],
      0,
      100,
    );

    const state = runner.getState();
    const alloc = state.allocations.find((a) => a.botId === "bah")!;
    expect(alloc.status).toBe("PAUSED");
    expect(alloc.ineligibilityReason).toBe("paused by user");
  });

  it("injectSleeveState ignores unknown botIds gracefully", async () => {
    const { runner } = await makeLeague();

    // Should not throw for an unknown botId
    expect(() =>
      runner.injectSleeveState(
        [
          {
            botId: "nonexistent-bot",
            cash: 5_000,
            positions: [],
            realizedPnl: 0,
            currentAllocation: 5_000,
            eligibilityStatus: "ACTIVE",
          },
        ],
        0,
        100,
      ),
    ).not.toThrow();

    // Original bah sleeve untouched
    const snaps = runner.getSleeveSnapshots();
    expect(snaps[0]!.cash).toBe(10_000);
  });

  it("injectSleeveState throws if called after start()", async () => {
    const { runner } = await makeLeague();
    await runner.start();

    expect(() =>
      runner.injectSleeveState([], 0, 100),
    ).toThrow("injectSleeveState() must be called before start()");

    await runner.end();
  });

  it("getSleeveSnapshots includes eliminatedAtEquity for eliminated bots", async () => {
    const { runner, gate } = await makeLeague();

    // Manually eliminate the bot
    runner.eliminateBot("bah", "test elimination");

    const snaps = runner.getSleeveSnapshots();
    expect(snaps[0]!.eligibilityStatus).toBe("ELIMINATED");
    // eliminatedAtEquity should be set (== starting equity since no ticks)
    expect(snaps[0]!.eliminatedAtEquity).toBe(10_000);

    void gate; // suppress unused warning
  });
});

// ─── P0: PaperLiveRunner recovery — sleeve state injected on reload ────────────

describe("PaperLiveRunner — same-day recovery injects sleeve state (P0)", () => {
  it("calls injectSleeveState with persisted sleeves before leagueRunner.start()", async () => {
    const gate = await makeArmedGateAsync();
    const auditLog = new AuditLog();
    const governance = makeMockGovernance();
    const store = makeArmedStore();
    const today = utcDateKey();

    // Set up persisted session with sleeve state
    saveLiveSession({
      symbol: "SPY",
      sessionDate: today,
      barHistory: [{ timestamp: 1_000, open: 100, high: 102, low: 99, close: 101, volume: 500 } as Candle],
      barsReceived: 1,
      lastBarAt: 1_000,
      botStats: [],
      sleeves: [
        {
          botId: "bah",
          cash: 7_500,
          positions: [{ symbol: "SPY", quantity: 25, avgCost: 100 }],
          realizedPnl: 50,
          currentAllocation: 10_000,
          eligibilityStatus: "ACTIVE",
        },
      ],
      unallocatedCash: 500,
    });

    const injectFn = vi.fn();
    const recoveryRunner = {
      ...mockLeagueRunner,
      start: vi.fn().mockResolvedValue(undefined),
      injectSleeveState: injectFn,
    } as unknown as PaperLeagueRunner;

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ is_open: true, next_open: "", next_close: "" }),
    } as Response);

    const runner = new PaperLiveRunner(
      recoveryRunner,
      store,
      governance,
      auditLog,
      gate,
      "SPY",
      FAST_CONFIG,
      ["bah"],
      (_url) => new MockWebSocket() as unknown as WebSocket,
      fetchMock,
    );

    await runner.start();

    // injectSleeveState should have been called with the persisted sleeve data
    expect(injectFn).toHaveBeenCalledOnce();
    const [sleeves, unallocatedCash, latestClose] = injectFn.mock.calls[0] as [unknown[], number, number];
    expect(sleeves).toHaveLength(1);
    expect((sleeves[0] as { botId: string }).botId).toBe("bah");
    expect(unallocatedCash).toBe(500);
    // latestClose should be the close of the last bar in history (101)
    expect(latestClose).toBe(101);

    await runner.stop();
  });

  it("does not call injectSleeveState when no persisted session exists", async () => {
    const gate = await makeArmedGateAsync();
    const auditLog = new AuditLog();
    const governance = makeMockGovernance();
    const store = makeArmedStore();

    const injectFn = vi.fn();
    const freshRunner = {
      ...mockLeagueRunner,
      start: vi.fn().mockResolvedValue(undefined),
      injectSleeveState: injectFn,
    } as unknown as PaperLeagueRunner;

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ is_open: true, next_open: "", next_close: "" }),
    } as Response);

    const runner = new PaperLiveRunner(
      freshRunner,
      store,
      governance,
      auditLog,
      gate,
      "SPY",
      FAST_CONFIG,
      [],
      (_url) => new MockWebSocket() as unknown as WebSocket,
      fetchMock,
    );

    await runner.start();

    expect(injectFn).not.toHaveBeenCalled();

    await runner.stop();
  });
});

// ─── P1b: market-closed bar dedup ─────────────────────────────────────────────

describe("PaperLiveRunner — market-closed bar updates _lastBarAt (P1b dedup)", () => {
  it("does not re-process a closed-market bar on the next poll", async () => {
    const gate = await makeArmedGateAsync();
    const auditLog = new AuditLog();
    const governance = makeMockGovernance();
    const store = makeArmedStore();
    let wsInstance: MockWebSocket | null = null;

    const tickFn = vi.fn().mockResolvedValue(undefined);
    const closedRunner = {
      ...mockLeagueRunner,
      tick: tickFn,
    } as unknown as PaperLeagueRunner;

    // Market is always closed
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ is_open: false, next_open: "", next_close: "" }),
    } as Response);

    const runner = new PaperLiveRunner(
      closedRunner,
      store,
      governance,
      auditLog,
      gate,
      "SPY",
      FAST_CONFIG,
      [],
      (url) => {
        wsInstance = new MockWebSocket();
        void url;
        return wsInstance as unknown as WebSocket;
      },
      fetchMock,
    );

    await runner.start();
    wsInstance!.triggerOpen();
    await Promise.resolve();
    wsInstance!.triggerMessage([{ T: "success", msg: "authenticated" }]);
    await Promise.resolve();
    wsInstance!.triggerMessage([{ T: "subscription", bars: ["SPY"] }]);
    await Promise.resolve();

    const t = "2026-05-16T14:30:00Z";

    // Deliver the bar once
    wsInstance!.triggerMessage(makeBarMsg(t));
    await new Promise((r) => setTimeout(r, 10));

    expect(runner.snapshot.barsReceived).toBe(0); // market closed — no tick
    expect(runner.snapshot.lastBarAt).toBe(Date.parse(t)); // _lastBarAt WAS updated

    // Deliver the same bar again — should be deduped now
    wsInstance!.triggerMessage(makeBarMsg(t));
    await new Promise((r) => setTimeout(r, 10));

    // tick still not called
    expect(tickFn).not.toHaveBeenCalled();

    await runner.stop();
  });
});

// ─── P1a: REST polling is a true fallback ─────────────────────────────────────

describe("PaperLiveRunner — REST polling skipped when WS is connected (P1a)", () => {
  it("does not call REST latest-bar endpoint while wsStatus === connected", async () => {
    const gate = await makeArmedGateAsync();
    const auditLog = new AuditLog();
    const governance = makeMockGovernance();
    const store = makeArmedStore();
    let wsInstance: MockWebSocket | null = null;

    let latestBarCallCount = 0;

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/bars/latest")) latestBarCallCount++;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ is_open: true, next_open: "", next_close: "" }),
      } as Response);
    });

    const config: PaperLiveConfig = {
      ...FAST_CONFIG,
      restPollIntervalMs: 30, // very short so the timer fires during test
    };

    const runner = new PaperLiveRunner(
      mockLeagueRunner,
      store,
      governance,
      auditLog,
      gate,
      "SPY",
      config,
      [],
      (url) => {
        wsInstance = new MockWebSocket();
        void url;
        return wsInstance as unknown as WebSocket;
      },
      fetchMock,
    );

    await runner.start();

    // Complete WS auth → wsStatus becomes "connected"
    wsInstance!.triggerOpen();
    await Promise.resolve();
    wsInstance!.triggerMessage([{ T: "success", msg: "authenticated" }]);
    await Promise.resolve();
    wsInstance!.triggerMessage([{ T: "subscription", bars: ["SPY"] }]);
    await Promise.resolve();

    expect(runner.snapshot.wsStatus).toBe("connected");

    // Let the REST poll timer fire several times
    await new Promise((r) => setTimeout(r, 120));

    // REST latest-bar must NOT have been called while WS is connected
    expect(latestBarCallCount).toBe(0);

    await runner.stop();
  });

  it("REST polling resumes when wsStatus is fallback", async () => {
    const gate = await makeArmedGateAsync();
    const auditLog = new AuditLog();
    const governance = makeMockGovernance();
    const store = makeArmedStore();
    let wsInstance: MockWebSocket | null = null;

    let latestBarCallCount = 0;

    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes("/bars/latest")) {
        latestBarCallCount++;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            symbol: "SPY",
            bar: { t: "2026-05-16T14:30:00Z", o: 100, h: 102, l: 99, c: 101, v: 1000 },
          }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ is_open: true, next_open: "", next_close: "" }),
      } as Response);
    });

    const config: PaperLiveConfig = {
      ...FAST_CONFIG,
      restPollIntervalMs: 30,
      maxReconnectAttempts: 0, // immediately fall back on WS close
    };

    const runner = new PaperLiveRunner(
      mockLeagueRunner,
      store,
      governance,
      auditLog,
      gate,
      "SPY",
      config,
      [],
      (url) => {
        wsInstance = new MockWebSocket();
        void url;
        return wsInstance as unknown as WebSocket;
      },
      fetchMock,
    );

    await runner.start();

    // Exhaust reconnect attempts — wsStatus becomes "fallback"
    wsInstance!.triggerClose(1006);
    await new Promise((r) => setTimeout(r, 10));

    expect(runner.snapshot.wsStatus).toBe("fallback");

    // REST poll timer fires — should now call latest-bar
    await new Promise((r) => setTimeout(r, 120));

    expect(latestBarCallCount).toBeGreaterThanOrEqual(1);

    await runner.stop();
  });
});
