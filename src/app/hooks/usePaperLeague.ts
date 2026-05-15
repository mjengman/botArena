/**
 * usePaperLeague — React hook managing a multi-bot paper-league session.
 *
 * Owns the full lifecycle for one league session:
 *   ConcreteEnablementGate → ConcreteCredentialStore → GovernanceEngine
 *   → SimulatedPaperAdapter → PaperLeagueRunner
 *
 * All governance objects are created once per mount (via useRef lazy init)
 * and persist across re-renders. The PaperLeagueRunner is created fresh
 * each time startSession() is called, so state (portfolios, trades) resets
 * between sessions.
 *
 * Three bots compete in every league session:
 *   - Buy & Hold  (id: "bah")
 *   - Momentum    (id: "mom")
 *   - Mean Reversion (id: "mr")
 * Each starts with $10k; the governance gate is shared across all bots.
 *
 * Replay mode: after startSession(), the hook drives tick() through the
 * sample dataset candles on an interval. Each tick advances all bots'
 * portfolios and updates React state.
 *
 * Per-bot actions (pauseBot, resumeBot, clearBot, eliminateBot, retireBot,
 * refundBot, withdrawCapital) are wrapped in try/catch — errors surface
 * via uiState.error. All actions trigger a syncUIState() so the panel
 * re-renders immediately.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { ConcreteEnablementGate } from "../../engine/governance/enablementGate.ts";
import { ConcreteCredentialStore } from "../../engine/governance/credentialStore.ts";
import { GovernanceEngine } from "../../engine/governance/governanceEngine.ts";
import { AuditLog } from "../../engine/governance/auditLog.ts";
import { SimulatedPaperAdapter } from "../../engine/adapters/simulatedPaperAdapter.ts";
import { PaperLeagueRunner } from "../../engine/paperLeagueRunner.ts";
import { sampleDataset } from "../../data/sampleDataset.ts";
import { buyAndHold } from "../../strategies/buyAndHold.ts";
import { momentum } from "../../strategies/momentum.ts";
import { meanReversion } from "../../strategies/meanReversion.ts";
import type {
  AlpacaCredentials,
  GateLifecycleSubscriber,
  GateStatus,
  PaperAdapterConfig,
} from "../../engine/brokerTypes.ts";
import type { AuditEntry } from "../../engine/governance/auditLog.ts";
import type { BotSpec, SimulationConfig } from "../../engine/types.ts";
import type { LeagueState } from "../../engine/leagueTypes.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const SYMBOL = "ARENA";
const REPLAY_INTERVAL_MS = 350;
const STARTING_CAPITAL = 10_000;

const SIM_CONFIG: SimulationConfig = {
  startingCash: STARTING_CAPITAL,
  feeBps: 5,
  slippageBps: 5,
  seed: 42,
};

const DEFAULT_PAPER_CONFIG: PaperAdapterConfig = {
  allowedSymbols: [SYMBOL],
  maxOpenOrders: 5,
  maxOrdersPerDay: 20,
  maxOrderNotional: 10_500,
  driftToleranceShares: 1,
  driftToleranceCash: 10,
  autoDisarmAfterMs: 4 * 60 * 60 * 1000,
  maxPositionFractionOfEquity: 0.99,
  maxRealizedDailyLossUsd: 1_000,
  botCapitalAllocationUsd: STARTING_CAPITAL,
};

const LEAGUE_BOT_SPECS: BotSpec[] = [
  { id: "bah", name: "Buy & Hold", strategy: buyAndHold },
  { id: "mom", name: "Momentum", strategy: momentum },
  { id: "mr",  name: "Mean Reversion", strategy: meanReversion },
];

const LEAGUE_ALLOCATIONS: Record<string, number> = {
  bah: STARTING_CAPITAL,
  mom: STARTING_CAPITAL,
  mr:  STARTING_CAPITAL,
};

// ─── Types ────────────────────────────────────────────────────────────────────

function buildInitialLeagueState(): LeagueState {
  return {
    running: false,
    startedAt: null,
    candlesProcessed: 0,
    allocations: [],
    unallocatedCash: 0,
  };
}

export interface PaperLeagueUIState {
  gateStatus: GateStatus;
  hasCredentials: boolean;
  isArming: boolean;
  isReplaying: boolean;
  leagueState: LeagueState;
  candleTotal: number;
  auditEntries: readonly AuditEntry[];
  error: string | null;
}

interface LeagueStack {
  auditLog: AuditLog;
  store: ConcreteCredentialStore;
  gate: ConcreteEnablementGate;
  governance: GovernanceEngine;
  adapter: SimulatedPaperAdapter;
}

function buildInitialUIState(): PaperLeagueUIState {
  return {
    gateStatus: "DISARMED",
    hasCredentials: false,
    isArming: false,
    isReplaying: false,
    leagueState: buildInitialLeagueState(),
    candleTotal: sampleDataset.candles.length,
    auditEntries: [],
    error: null,
  };
}

// ─── usePaperLeague ───────────────────────────────────────────────────────────

export function usePaperLeague() {
  const [uiState, setUIState] = useState<PaperLeagueUIState>(buildInitialUIState);

  // ── Governance stack — created once per mount ───────────────────────────
  const stackRef = useRef<LeagueStack | null>(null);
  if (stackRef.current === null) {
    const auditLog = new AuditLog();
    const store = new ConcreteCredentialStore();
    const gate = new ConcreteEnablementGate(
      [
        async () => ({
          check: "credentials-present",
          passed: store.hasCredentials,
          detail: store.hasCredentials
            ? undefined
            : "No demo access key set — enter any value in the access key field first",
        }),
      ],
      auditLog,
      DEFAULT_PAPER_CONFIG.autoDisarmAfterMs,
    );
    gate.subscribe(store);
    const governance = new GovernanceEngine(DEFAULT_PAPER_CONFIG, gate, auditLog);
    const adapter = new SimulatedPaperAdapter(SIM_CONFIG.feeBps, SIM_CONFIG.slippageBps);
    stackRef.current = { auditLog, store, gate, governance, adapter };
  }

  // ── PaperLeagueRunner — created per session, torn down on stop ──────────
  const runnerRef = useRef<PaperLeagueRunner | null>(null);

  // ── Replay interval control ─────────────────────────────────────────────
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickingRef = useRef(false);

  // ── React state sync helper ─────────────────────────────────────────────
  const syncUIState = useCallback(
    (overrides?: Partial<PaperLeagueUIState>) => {
      const { gate, store, auditLog } = stackRef.current!;
      const runner = runnerRef.current;
      setUIState((prev) => ({
        ...prev,
        gateStatus: gate.status,
        hasCredentials: store.hasCredentials,
        leagueState: runner?.getState() ?? prev.leagueState,
        auditEntries: auditLog.getEntries(),
        error: null,
        ...overrides,
      }));
    },
    [],
  );

  // ── Gate lifecycle subscriber — sync state on auto-disarm ───────────────
  useEffect(() => {
    const { gate } = stackRef.current!;
    const subscriber: GateLifecycleSubscriber = {
      onArmed() {
        syncUIState({ isArming: false });
      },
      onDisarmed() {
        if (intervalRef.current !== null) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        syncUIState({ isArming: false, isReplaying: false });
      },
    };
    gate.subscribe(subscriber);
  }, [syncUIState]);

  // ── Unmount cleanup ─────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      const runner = runnerRef.current;
      if (runner) {
        runner.end().catch(() => {/* best-effort */});
        runnerRef.current = null;
      }
      stackRef.current?.gate.disarm("panel closed");
    };
  }, []);

  // ─── Shared teardown helper ───────────────────────────────────────────────

  const _cleanupAndDisarm = useCallback(async (reason: string) => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    const runner = runnerRef.current;
    if (runner) {
      try {
        await runner.end();
      } catch {
        // best-effort
      }
      runnerRef.current = null;
    }
    stackRef.current!.gate.disarm(reason);
    // React state updated by gate subscriber → syncUIState
  }, []);

  // ─── Actions ─────────────────────────────────────────────────────────────

  const setCredentials = useCallback((creds: AlpacaCredentials) => {
    stackRef.current!.store.set(creds);
    syncUIState();
  }, [syncUIState]);

  const arm = useCallback(async () => {
    const { gate, auditLog } = stackRef.current!;
    setUIState((prev) => ({ ...prev, isArming: true, error: null }));
    try {
      const ok = await gate.arm();
      if (!ok) {
        const entries = auditLog.getEntries();
        const failedEntry = [...entries]
          .reverse()
          .find((e) => e.type === "PRECONDITION_RESULT" && e.payload["passed"] === false);
        const detail = String(
          failedEntry?.payload["detail"] ?? "Arming precondition failed",
        );
        syncUIState({ isArming: false, error: detail });
      } else {
        syncUIState({ isArming: false });
      }
    } catch (err) {
      syncUIState({
        isArming: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [syncUIState]);

  const disarm = useCallback(async (reason = "user disarmed") => {
    await _cleanupAndDisarm(reason);
  }, [_cleanupAndDisarm]);

  const startSession = useCallback(async () => {
    const { gate, governance, auditLog, adapter } = stackRef.current!;

    if (gate.status !== "ARMED") {
      setUIState((prev) => ({
        ...prev,
        error: "Gate must be ARMED before starting a session",
      }));
      return;
    }

    // Reset per-bot governance counters for all league bots
    for (const spec of LEAGUE_BOT_SPECS) {
      governance.resetStats(spec.id);
    }

    const runner = new PaperLeagueRunner(
      SIM_CONFIG,
      LEAGUE_BOT_SPECS,
      LEAGUE_ALLOCATIONS,
      adapter,
      governance,
      auditLog,
      gate,
      SYMBOL,
    );
    runnerRef.current = runner;

    try {
      await runner.start();
    } catch (err) {
      runnerRef.current = null;
      syncUIState({
        error: err instanceof Error ? err.message : String(err),
        isReplaying: false,
      });
      return;
    }

    syncUIState({ isReplaying: true, error: null });

    // ── Replay interval ───────────────────────────────────────────────────
    intervalRef.current = setInterval(async () => {
      if (tickingRef.current) return;
      tickingRef.current = true;
      try {
        const currentRunner = runnerRef.current;
        if (!currentRunner) return;

        const candles = sampleDataset.candles;
        const processed = currentRunner.getState().candlesProcessed;

        if (processed >= candles.length) {
          clearInterval(intervalRef.current!);
          intervalRef.current = null;
          await currentRunner.end();
          runnerRef.current = null;
          syncUIState({ isReplaying: false });
          return;
        }

        const candle = candles[processed]!;
        const history = candles.slice(0, processed + 1);
        adapter.setCurrentCandle(candle.close, candle.timestamp);
        await currentRunner.tick(candle, history);

        syncUIState({ isReplaying: true });
      } catch (err) {
        clearInterval(intervalRef.current!);
        intervalRef.current = null;
        syncUIState({
          isReplaying: false,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        tickingRef.current = false;
      }
    }, REPLAY_INTERVAL_MS);
  }, [syncUIState]);

  const stopSession = useCallback(async () => {
    await _cleanupAndDisarm("user stopped session");
  }, [_cleanupAndDisarm]);

  // ─── Per-bot actions (all wrapped in try/catch for error surfacing) ───────

  const pauseBot = useCallback((botId: string) => {
    try {
      runnerRef.current?.pauseBot(botId);
      syncUIState();
    } catch (err) {
      syncUIState({ error: err instanceof Error ? err.message : String(err) });
    }
  }, [syncUIState]);

  const resumeBot = useCallback((botId: string) => {
    try {
      runnerRef.current?.resumeBot(botId);
      syncUIState();
    } catch (err) {
      syncUIState({ error: err instanceof Error ? err.message : String(err) });
    }
  }, [syncUIState]);

  const clearBot = useCallback((botId: string) => {
    try {
      runnerRef.current?.clearBot(botId);
      syncUIState();
    } catch (err) {
      syncUIState({ error: err instanceof Error ? err.message : String(err) });
    }
  }, [syncUIState]);

  const eliminateBot = useCallback((botId: string) => {
    try {
      runnerRef.current?.eliminateBot(botId, "eliminated by user");
      syncUIState();
    } catch (err) {
      syncUIState({ error: err instanceof Error ? err.message : String(err) });
    }
  }, [syncUIState]);

  const retireBot = useCallback((botId: string) => {
    try {
      runnerRef.current?.retireBot(botId, "retired by user");
      syncUIState();
    } catch (err) {
      syncUIState({ error: err instanceof Error ? err.message : String(err) });
    }
  }, [syncUIState]);

  const refundBot = useCallback((botId: string, amount: number) => {
    try {
      runnerRef.current?.refundBot(botId, amount);
      syncUIState();
    } catch (err) {
      syncUIState({ error: err instanceof Error ? err.message : String(err) });
    }
  }, [syncUIState]);

  const withdrawCapital = useCallback((botId: string, amount: number) => {
    try {
      runnerRef.current?.withdrawCapital(botId, amount);
      syncUIState();
    } catch (err) {
      syncUIState({ error: err instanceof Error ? err.message : String(err) });
    }
  }, [syncUIState]);

  const dismissError = useCallback(() => {
    setUIState((prev) => ({ ...prev, error: null }));
  }, []);

  return {
    state: uiState,
    setCredentials,
    arm,
    disarm,
    startSession,
    stopSession,
    pauseBot,
    resumeBot,
    clearBot,
    eliminateBot,
    retireBot,
    refundBot,
    withdrawCapital,
    dismissError,
  };
}
