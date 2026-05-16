/**
 * usePaperLeague — React hook managing a multi-bot paper-league session.
 *
 * Supports two modes:
 *
 *   "simulated"    (default) — fills computed in-process using SimulatedPaperAdapter.
 *                 Any value accepted in the access-key field; no real API calls made.
 *                 Replays the active dataset candle-by-candle at a fixed interval.
 *
 *   "alpaca-paper" — fills submitted via real Alpaca Paper REST API using
 *                 AlpacaPaperAdapter. Requires valid Alpaca Paper API key + secret.
 *                 Three arming preconditions: credentials present → account fetch
 *                 succeeds → account status ACTIVE. Candle data still drives
 *                 strategy timing; fills arrive at live Alpaca market prices.
 *
 * Governance objects (gate, store, governance engine, audit log) are rebuilt when
 * mode changes — mode may only be changed when the gate is DISARMED.
 *
 * Three bots compete in every league session:
 *   - Buy & Hold     (id: "bah")
 *   - Momentum       (id: "mom")
 *   - Mean Reversion (id: "mr")
 * Each starts with $10k; governance is shared across all bots.
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { ConcreteEnablementGate } from "../../engine/governance/enablementGate.ts";
import { ConcreteCredentialStore } from "../../engine/governance/credentialStore.ts";
import { GovernanceEngine } from "../../engine/governance/governanceEngine.ts";
import { AuditLog } from "../../engine/governance/auditLog.ts";
import { SimulatedPaperAdapter } from "../../engine/adapters/simulatedPaperAdapter.ts";
import { AlpacaPaperAdapter } from "../../engine/adapters/alpacaPaperAdapter.ts";
import { makeAlpacaArmingPreconditions } from "../../engine/adapters/alpacaArmingPreconditions.ts";
import { PaperLeagueRunner } from "../../engine/paperLeagueRunner.ts";
import { PaperLiveRunner, DEFAULT_PAPER_LIVE_CONFIG } from "../../engine/paperLiveRunner.ts";
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
import type { BotSpec, Dataset, SimulationConfig } from "../../engine/types.ts";
import type { LeagueState } from "../../engine/leagueTypes.ts";
import type { WsStatus } from "../../engine/paperLiveRunner.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type LeagueMode = "simulated" | "alpaca-paper";

// ─── Constants ────────────────────────────────────────────────────────────────

const REPLAY_INTERVAL_MS = 350;
const STARTING_CAPITAL = 10_000;

const SIM_CONFIG: SimulationConfig = {
  startingCash: STARTING_CAPITAL,
  feeBps: 5,
  slippageBps: 5,
  seed: 42,
};

const DEFAULT_PAPER_CONFIG: PaperAdapterConfig = {
  allowedSymbols: ["ARENA"],
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
  { id: "bah", name: "Buy & Hold",     strategy: buyAndHold },
  { id: "mom", name: "Momentum",       strategy: momentum },
  { id: "mr",  name: "Mean Reversion", strategy: meanReversion },
];

const LEAGUE_ALLOCATIONS: Record<string, number> = {
  bah: STARTING_CAPITAL,
  mom: STARTING_CAPITAL,
  mr:  STARTING_CAPITAL,
};

// ─── Stack builder ────────────────────────────────────────────────────────────

interface LeagueStack {
  auditLog: AuditLog;
  store: ConcreteCredentialStore;
  gate: ConcreteEnablementGate;
  governance: GovernanceEngine;
  /** The active BrokerAdapter for this mode. */
  adapter: SimulatedPaperAdapter | AlpacaPaperAdapter;
  /** Symbol used for governance allowlist and runner. */
  symbol: string;
}

/**
 * Build a fresh governance stack for the given mode and symbol.
 *
 * @param mode     Which adapter to wire up.
 * @param symbol   Symbol the bots will trade (used in allowlist + runner).
 * @param onArmed  Called synchronously when the gate transitions to ARMED.
 * @param onDisarmed Called synchronously when the gate disarms.
 */
function buildStack(
  mode: LeagueMode,
  symbol: string,
  onArmed: () => void,
  onDisarmed: () => void,
): LeagueStack {
  const auditLog = new AuditLog();
  const store = new ConcreteCredentialStore();

  // ── Arming preconditions ────────────────────────────────────────────────
  const preconditions =
    mode === "alpaca-paper"
      ? makeAlpacaArmingPreconditions(store)
      : [
          async () => ({
            check: "credentials-present",
            passed: store.hasCredentials,
            detail: store.hasCredentials
              ? undefined
              : "Enter any value in the access key field first",
          }),
        ];

  const gate = new ConcreteEnablementGate(
    preconditions,
    auditLog,
    DEFAULT_PAPER_CONFIG.autoDisarmAfterMs,
  );
  gate.subscribe(store);

  // React state sync subscriber — delegates to the latest callbacks via refs
  const subscriber: GateLifecycleSubscriber = {
    onArmed() { onArmed(); },
    onDisarmed() { onDisarmed(); },
  };
  gate.subscribe(subscriber);

  // ── Adapter ─────────────────────────────────────────────────────────────
  const adapter: SimulatedPaperAdapter | AlpacaPaperAdapter =
    mode === "alpaca-paper"
      ? new AlpacaPaperAdapter(store)
      : new SimulatedPaperAdapter(SIM_CONFIG.feeBps, SIM_CONFIG.slippageBps);

  // ── Governance config: allowedSymbols uses the active symbol ────────────
  const paperConfig: PaperAdapterConfig = { ...DEFAULT_PAPER_CONFIG, allowedSymbols: [symbol] };
  const governance = new GovernanceEngine(paperConfig, gate, auditLog);

  return { auditLog, store, gate, governance, adapter, symbol };
}

// ─── State ────────────────────────────────────────────────────────────────────

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
  mode: LeagueMode;
  symbol: string;
  gateStatus: GateStatus;
  hasCredentials: boolean;
  isArming: boolean;
  isReplaying: boolean;
  leagueState: LeagueState;
  candleTotal: number;
  auditEntries: readonly AuditEntry[];
  error: string | null;
  isMarketOpen: boolean;
  lastBarAt: number | null;
  barsReceived: number;
  wsStatus: WsStatus;
}

function buildInitialUIState(mode: LeagueMode = "simulated", symbol = "ARENA"): PaperLeagueUIState {
  return {
    mode,
    symbol,
    gateStatus: "DISARMED",
    hasCredentials: false,
    isArming: false,
    isReplaying: false,
    leagueState: buildInitialLeagueState(),
    candleTotal: sampleDataset.candles.length,
    auditEntries: [],
    error: null,
    isMarketOpen: false,
    lastBarAt: null,
    barsReceived: 0,
    wsStatus: "disconnected",
  };
}

// ─── usePaperLeague ───────────────────────────────────────────────────────────

export function usePaperLeague() {
  const [uiState, setUIState] = useState<PaperLeagueUIState>(buildInitialUIState);

  // ── Refs for latest callbacks (avoids stale closures in gate subscribers) ─
  const onArmedRef  = useRef<() => void>(() => {});
  const onDisarmedRef = useRef<() => void>(() => {});

  // ── Governance stack — rebuilt on mode/symbol change ────────────────────
  const stackRef = useRef<LeagueStack | null>(null);
  if (stackRef.current === null) {
    stackRef.current = buildStack(
      "simulated",
      "ARENA",
      () => onArmedRef.current(),
      () => onDisarmedRef.current(),
    );
  }

  // ── PaperLeagueRunner — created per session, torn down on stop ──────────
  const runnerRef = useRef<PaperLeagueRunner | null>(null);

  // ── PaperLiveRunner — drives alpaca-paper mode with live WS/REST data ───
  const liveRunnerRef = useRef<PaperLiveRunner | null>(null);

  // ── Replay interval control ─────────────────────────────────────────────
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickingRef = useRef(false);

  // ── Dataset used for replay timing ─────────────────────────────────────
  // For now both modes replay through sampleDataset for candle timing.
  // In alpaca-paper mode the fill prices come from Alpaca at market price.
  const datasetRef = useRef<Dataset>(sampleDataset);

  // ── React state sync helper ─────────────────────────────────────────────
  const syncUIState = useCallback(
    (overrides?: Partial<PaperLeagueUIState>) => {
      const stack = stackRef.current!;
      const runner = runnerRef.current;
      setUIState((prev) => ({
        ...prev,
        mode: stack ? prev.mode : prev.mode,
        gateStatus: stack.gate.status,
        hasCredentials: stack.store.hasCredentials,
        leagueState: runner?.getState() ?? prev.leagueState,
        auditEntries: stack.auditLog.getEntries(),
        error: null,
        ...overrides,
      }));
    },
    [],
  );

  // Keep the subscriber callbacks up to date with the latest syncUIState.
  // The subscribers are registered in buildStack() and always call through
  // these refs, so they work correctly even after a stack rebuild.
  onArmedRef.current = () => syncUIState({ isArming: false });
  onDisarmedRef.current = () => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    const liveRunner = liveRunnerRef.current;
    if (liveRunner) {
      liveRunner.stop("gate disarmed").catch(() => {/* best-effort */});
      liveRunnerRef.current = null;
    }
    syncUIState({ isArming: false, isReplaying: false });
  };

  // ── Unmount cleanup ─────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      const liveRunner = liveRunnerRef.current;
      if (liveRunner) {
        liveRunner.stop("panel closed").catch(() => {/* best-effort */});
        liveRunnerRef.current = null;
      }
      const runner = runnerRef.current;
      if (runner) {
        runner.end().catch(() => {/* best-effort */});
        runnerRef.current = null;
      }
      stackRef.current?.gate.disarm("panel closed");
    };
  }, []);

  // ─── Shared teardown helper ────────────────────────────────────────────

  const _cleanupAndDisarm = useCallback(async (reason: string) => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    const liveRunner = liveRunnerRef.current;
    if (liveRunner) {
      try { await liveRunner.stop(reason); } catch {/* best-effort */}
      liveRunnerRef.current = null;
    }
    const runner = runnerRef.current;
    if (runner) {
      try { await runner.end(); } catch {/* best-effort */}
      runnerRef.current = null;
    }
    stackRef.current!.gate.disarm(reason);
    // React state updated by gate subscriber → syncUIState
  }, []);

  // ─── Actions ──────────────────────────────────────────────────────────

  /**
   * Switch between "simulated" and "alpaca-paper" modes.
   * Only allowed when the gate is DISARMED. Rebuilds the governance stack.
   */
  const setMode = useCallback((newMode: LeagueMode, newSymbol?: string) => {
    const { gate } = stackRef.current!;
    if (gate.status === "ARMED" || gate.status === "ARMING") {
      setUIState((prev) => ({ ...prev, error: "Disarm first before switching mode" }));
      return;
    }
    // Cleanup any lingering session/interval
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    const liveRunner = liveRunnerRef.current;
    if (liveRunner) {
      liveRunner.stop("mode changed").catch(() => {});
      liveRunnerRef.current = null;
    }
    const runner = runnerRef.current;
    if (runner) {
      runner.end().catch(() => {});
      runnerRef.current = null;
    }
    const symbol = newSymbol ?? (newMode === "alpaca-paper" ? "SPY" : "ARENA");
    const newStack = buildStack(
      newMode,
      symbol,
      () => onArmedRef.current(),
      () => onDisarmedRef.current(),
    );
    stackRef.current = newStack;
    const newState = buildInitialUIState(newMode, symbol);
    newState.candleTotal = datasetRef.current.candles.length;
    setUIState(newState);
  }, []);

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
    const { gate, governance, auditLog, adapter, symbol } = stackRef.current!;

    if (gate.status !== "ARMED") {
      setUIState((prev) => ({
        ...prev, error: "Gate must be ARMED before starting a session",
      }));
      return;
    }

    // Determine reset mode: simulated replay always gets a full reset;
    // real Alpaca Paper mode uses date-aware reset to preserve daily limits
    // if the session is restarted within the same UTC calendar day.
    const isSimulated = stackRef.current!.adapter instanceof SimulatedPaperAdapter;
    for (const spec of LEAGUE_BOT_SPECS) {
      governance.resetStats(spec.id, /* forceReset */ isSimulated);
      governance.setEligibilityStatus(spec.id, "ACTIVE");
    }

    // ── Alpaca Paper: fetch account cash to compute initialUnallocatedCash ──
    // The engine's total portfolio cash (sum of all sleeves) must match the
    // broker account cash at session start so the first reconciliation does not
    // produce a spurious drift. The broker account usually holds more cash than
    // the sleeves collectively require — the surplus is tracked as
    // `initialUnallocatedCash` and included in `_buildTotalPortfolio()`.
    const TOTAL_SLEEVE_CAPITAL = Object.values(LEAGUE_ALLOCATIONS).reduce(
      (sum, v) => sum + v,
      0,
    );

    let initialUnallocatedCash = 0;
    if (!isSimulated) {
      let brokerCash: number;
      try {
        brokerCash = await (adapter as AlpacaPaperAdapter).fetchAccountCash();
      } catch (err) {
        syncUIState({
          error: `Failed to fetch Alpaca account cash: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
      if (brokerCash < TOTAL_SLEEVE_CAPITAL) {
        syncUIState({
          error:
            `Alpaca Paper account uninvested cash ($${brokerCash.toFixed(2)}) is less than ` +
            `the required sleeve capital ($${TOTAL_SLEEVE_CAPITAL.toFixed(2)}). ` +
            `The league needs $${TOTAL_SLEEVE_CAPITAL.toFixed(2)} in free (uninvested) cash — ` +
            `existing positions do not count. Add cash to your paper account or close open ` +
            `positions, then retry.`,
        });
        return;
      }
      initialUnallocatedCash = brokerCash - TOTAL_SLEEVE_CAPITAL;
    }

    const runner = new PaperLeagueRunner(
      SIM_CONFIG,
      LEAGUE_BOT_SPECS,
      LEAGUE_ALLOCATIONS,
      adapter,
      governance,
      auditLog,
      gate,
      symbol,
      initialUnallocatedCash,
    );
    runnerRef.current = runner;

    // ── Alpaca Paper mode: drive with PaperLiveRunner (real 1-min bars) ────
    if (!isSimulated) {
      const liveRunner = new PaperLiveRunner(
        runner,
        stackRef.current!.store,
        governance,
        auditLog,
        gate,
        symbol,
        DEFAULT_PAPER_LIVE_CONFIG,
        LEAGUE_BOT_SPECS.map((s) => s.id),
      );

      liveRunner.onSnapshot = (snap) => {
        syncUIState({
          isMarketOpen: snap.isMarketOpen,
          lastBarAt: snap.lastBarAt,
          barsReceived: snap.barsReceived,
          wsStatus: snap.wsStatus,
          isReplaying: true,
        });
      };

      liveRunner.onError = (err) => {
        syncUIState({ error: err.message, isReplaying: false });
      };

      try {
        await liveRunner.start();
      } catch (err) {
        runnerRef.current = null;
        syncUIState({
          error: err instanceof Error ? err.message : String(err),
          isReplaying: false,
        });
        return;
      }

      liveRunnerRef.current = liveRunner;
      syncUIState({ isReplaying: true, error: null });
      return; // Do NOT start the setInterval loop in alpaca-paper mode
    }

    // ── Simulated mode: start the PaperLeagueRunner + replay interval ──────
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

    // ── Replay interval ────────────────────────────────────────────────────
    intervalRef.current = setInterval(async () => {
      if (tickingRef.current) return;
      tickingRef.current = true;
      try {
        const currentRunner = runnerRef.current;
        const currentStack = stackRef.current;
        if (!currentRunner || !currentStack) return;

        const candles = datasetRef.current.candles;
        const processed = currentRunner.getState().candlesProcessed;

        if (processed >= candles.length) {
          clearInterval(intervalRef.current!);
          intervalRef.current = null;
          await currentRunner.end();
          const finalLeagueState = currentRunner.getState();
          runnerRef.current = null;
          syncUIState({ isReplaying: false, leagueState: finalLeagueState });
          return;
        }

        const candle = candles[processed]!;
        const history = candles.slice(0, processed + 1);

        // SimulatedPaperAdapter needs the current price injected before tick().
        // AlpacaPaperAdapter submits real orders; price injection is not needed.
        if (currentStack.adapter instanceof SimulatedPaperAdapter) {
          currentStack.adapter.setCurrentCandle(candle.close, candle.timestamp);
        }

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

  // ─── Per-bot actions (all wrapped in try/catch for error surfacing) ──────

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
    setMode,
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
