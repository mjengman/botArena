/**
 * usePaperSession — React hook managing the paper trading governance stack.
 *
 * Owns the full lifecycle for one simulated paper session:
 *   ConcreteEnablementGate → ConcreteCredentialStore → GovernanceEngine
 *   → SimulatedPaperAdapter → PaperSessionRunner
 *
 * All governance objects are created once per mount (via useRef lazy init)
 * and persist across re-renders. The PaperSessionRunner is created fresh
 * each time startSession() is called, so state (portfolio, trades) resets
 * between sessions.
 *
 * Replay mode: after startSession(), the hook drives tick() through the
 * sample dataset candles on an interval. Each tick advances the bot's
 * portfolio and updates React state.
 *
 * For M8 (simulated mode), credentials are stored but not used for real
 * API calls — any non-empty API key triggers the credentials-present
 * precondition so the full gate/store lifecycle is exercised in the UI.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { ConcreteEnablementGate } from "../../engine/governance/enablementGate.ts";
import { ConcreteCredentialStore } from "../../engine/governance/credentialStore.ts";
import { GovernanceEngine } from "../../engine/governance/governanceEngine.ts";
import { AuditLog } from "../../engine/governance/auditLog.ts";
import { SimulatedPaperAdapter } from "../../engine/adapters/simulatedPaperAdapter.ts";
import { PaperSessionRunner } from "../../engine/paperSessionRunner.ts";
import { sampleDataset } from "../../data/sampleDataset.ts";
import { buyAndHold } from "../../strategies/buyAndHold.ts";
import type {
  AlpacaCredentials,
  GateLifecycleSubscriber,
  GateStatus,
  PaperAdapterConfig,
} from "../../engine/brokerTypes.ts";
import type { AuditEntry } from "../../engine/governance/auditLog.ts";
import type { GovernanceBotStats } from "../../engine/governance/governanceEngine.ts";
import type { BotSpec, SimulationConfig } from "../../engine/types.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const BOT_ID = "paper-bot-1";
const SYMBOL = "ARENA";
const REPLAY_INTERVAL_MS = 350;

const SIM_CONFIG: SimulationConfig = {
  startingCash: 10_000,
  feeBps: 5,
  slippageBps: 5,
  seed: 42,
};

const DEFAULT_PAPER_CONFIG: PaperAdapterConfig = {
  allowedSymbols: [SYMBOL],
  maxOpenOrders: 5,
  maxOrdersPerDay: 20,
  maxOrderNotional: 9_000,
  driftToleranceShares: 1,
  driftToleranceCash: 10,
  autoDisarmAfterMs: 4 * 60 * 60 * 1000,
  maxPositionFractionOfEquity: 0.99,
  maxRealizedDailyLossUsd: 1_000,
  botCapitalAllocationUsd: 10_000,
};

const BOT_SPEC: BotSpec = {
  id: BOT_ID,
  name: "Buy & Hold (Paper)",
  strategy: buyAndHold,
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PaperSessionUIState {
  gateStatus: GateStatus;
  hasCredentials: boolean;
  isArming: boolean;
  sessionRunning: boolean;
  isReplaying: boolean;
  equity: number;
  candleIndex: number;
  candleTotal: number;
  auditEntries: readonly AuditEntry[];
  govStats: GovernanceBotStats;
  error: string | null;
}

interface PaperStack {
  auditLog: AuditLog;
  store: ConcreteCredentialStore;
  gate: ConcreteEnablementGate;
  governance: GovernanceEngine;
  adapter: SimulatedPaperAdapter;
}

function makeEmptyGovStats(): GovernanceBotStats {
  return {
    dailyOrderCount: 0,
    realizedDailyLossUsd: 0,
    committedCapitalUsd: 0,
    dayKey: "",
  };
}

function buildInitialUIState(): PaperSessionUIState {
  return {
    gateStatus: "DISARMED",
    hasCredentials: false,
    isArming: false,
    sessionRunning: false,
    isReplaying: false,
    equity: SIM_CONFIG.startingCash,
    candleIndex: 0,
    candleTotal: sampleDataset.candles.length,
    auditEntries: [],
    govStats: makeEmptyGovStats(),
    error: null,
  };
}

// ─── usePaperSession ──────────────────────────────────────────────────────────

export function usePaperSession() {
  const [uiState, setUIState] = useState<PaperSessionUIState>(buildInitialUIState);

  // ── Governance stack — created once per mount ───────────────────────────
  const stackRef = useRef<PaperStack | null>(null);
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
            : "No credentials set — enter your Alpaca Paper API key first",
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

  // ── PaperSessionRunner — created per session, torn down on stop ─────────
  const runnerRef = useRef<PaperSessionRunner | null>(null);

  // ── Replay interval control ─────────────────────────────────────────────
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickingRef = useRef(false);

  // ── React state sync helper ─────────────────────────────────────────────
  const syncUIState = useCallback(
    (overrides?: Partial<PaperSessionUIState>) => {
      const { gate, store, governance, auditLog } = stackRef.current!;
      const runner = runnerRef.current;
      const runnerState = runner?.getState();
      setUIState((prev) => ({
        ...prev,
        gateStatus: gate.status,
        hasCredentials: store.hasCredentials,
        equity: runnerState?.bot.portfolio.equity ?? prev.equity,
        candleIndex: runnerState?.candlesProcessed ?? prev.candleIndex,
        sessionRunning: runnerState?.running ?? false,
        auditEntries: auditLog.getEntries(),
        govStats: governance.getStats(BOT_ID),
        error: null,
        ...overrides,
      }));
    },
    [],
  );

  // ── Subscribe a lifecycle subscriber for gate auto-disarm ───────────────
  // Registered once on mount. Ensures React state stays in sync when the
  // auto-disarm timer fires (which happens outside any user action).
  useEffect(() => {
    const { gate } = stackRef.current!;
    const subscriber: GateLifecycleSubscriber = {
      onArmed() {
        syncUIState({ isArming: false });
      },
      onDisarmed() {
        // Stop any active replay when gate auto-disarms
        if (intervalRef.current !== null) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        syncUIState({ isArming: false, isReplaying: false, sessionRunning: false });
      },
    };
    gate.subscribe(subscriber);
    // Note: ConcreteEnablementGate has no unsubscribe — this subscriber lives
    // for the component lifetime, which matches the gate's lifetime.
  }, [syncUIState]);

  // ── Stop replay interval on unmount ────────────────────────────────────
  useEffect(() => {
    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, []);

  // ─── Actions ─────────────────────────────────────────────────────────────

  /**
   * Store credentials in the CredentialStore. May be called before arming.
   * Credentials are a precondition for arm(), not a result of it.
   */
  const setCredentials = useCallback((creds: AlpacaCredentials) => {
    const { store } = stackRef.current!;
    store.set(creds);
    syncUIState();
  }, [syncUIState]);

  /**
   * Attempt to arm the gate. Runs all preconditions (credentials-present
   * check). On success, the gate transitions to ARMED and the session
   * start button becomes available. On failure, the error is surfaced.
   */
  const arm = useCallback(async () => {
    const { gate, auditLog } = stackRef.current!;
    setUIState((prev) => ({ ...prev, isArming: true, error: null }));
    try {
      const ok = await gate.arm();
      if (!ok) {
        // Find the failed precondition detail from the audit log
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

  /** Immediately disarm the gate. Safe to call at any time. */
  const disarm = useCallback((reason = "user disarmed") => {
    const { gate } = stackRef.current!;
    // Stop any running session first
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    gate.disarm(reason);
    // syncUIState is called by the gate subscriber (onDisarmed)
  }, []);

  /**
   * Start a paper session. Gate must already be ARMED.
   *
   * Creates a fresh PaperSessionRunner (resetting bot portfolio to
   * SIM_CONFIG.startingCash), calls start() for session-start reconciliation,
   * then begins the replay interval that drives tick() through the sample
   * dataset candles.
   */
  const startSession = useCallback(async () => {
    const { gate, governance, auditLog, adapter } = stackRef.current!;

    if (gate.status !== "ARMED") {
      setUIState((prev) => ({
        ...prev,
        error: "Gate must be ARMED before starting a session",
      }));
      return;
    }

    // Create a fresh runner (resets bot state)
    const runner = new PaperSessionRunner(
      SIM_CONFIG,
      BOT_SPEC,
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
        sessionRunning: false,
        isReplaying: false,
      });
      return;
    }

    syncUIState({ sessionRunning: true, isReplaying: true, error: null });

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
          // Replay complete — graceful session end
          clearInterval(intervalRef.current!);
          intervalRef.current = null;
          await currentRunner.end();
          syncUIState({ isReplaying: false, sessionRunning: false });
          return;
        }

        const candle = candles[processed]!;
        const history = candles.slice(0, processed + 1);
        adapter.setCurrentCandle(candle.close, candle.timestamp);
        await currentRunner.tick(candle, history);

        syncUIState({ isReplaying: true });
      } catch (err) {
        // Unexpected error — stop replay and surface the error
        clearInterval(intervalRef.current!);
        intervalRef.current = null;
        syncUIState({
          isReplaying: false,
          sessionRunning: false,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        tickingRef.current = false;
      }
    }, REPLAY_INTERVAL_MS);
  }, [syncUIState]);

  /**
   * Stop the current session. Calls runner.end() for session-end
   * reconciliation and disarms the gate.
   */
  const stopSession = useCallback(async () => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    const runner = runnerRef.current;
    if (runner) {
      try {
        await runner.end();
      } catch {
        // Reconciliation may fail; gate is already disarmed by runner
      }
      runnerRef.current = null;
    }
    const { gate } = stackRef.current!;
    gate.disarm("user stopped session");
    syncUIState({ isReplaying: false, sessionRunning: false });
  }, [syncUIState]);

  return {
    state: uiState,
    setCredentials,
    arm,
    disarm,
    startSession,
    stopSession,
  };
}
