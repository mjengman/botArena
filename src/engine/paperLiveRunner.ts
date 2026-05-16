/**
 * PaperLiveRunner — real-time 1-minute bar driver for the Alpaca Paper league.
 *
 * Wraps PaperLeagueRunner and drives it with live market data instead of the
 * synthetic candle dataset. Two data sources are used in priority order:
 *
 *   1. Alpaca WebSocket (wss://stream.data.alpaca.markets/v2/iex)
 *      Subscribes to completed 1-minute bars for the target symbol. Falls back
 *      to REST polling if WebSocket is unavailable after maxReconnectAttempts.
 *
 *   2. REST polling (data.alpaca.markets/v2/stocks/{symbol}/bars/latest)
 *      Runs in parallel with WebSocket as a redundant fallback. Becomes the
 *      sole data source when wsStatus === "fallback".
 *
 * Market-hours guard:
 *   Clock is re-fetched on every bar. If the market is closed, the bar is
 *   logged and dropped — no tick() is called.
 *
 * Deduplication:
 *   Bars with a timestamp ≤ lastBarAt are silently skipped. This prevents
 *   double-ticking when both WS and REST deliver the same bar.
 *
 * Same-day recovery:
 *   On start(), if a same-day session exists in localStorage, bar history and
 *   governance stats are restored before the first tick so strategies have
 *   context and daily limits are preserved across page reloads.
 *
 * Usage:
 *   const liveRunner = new PaperLiveRunner(leagueRunner, store, governance,
 *                                          auditLog, gate, symbol);
 *   liveRunner.onSnapshot = (snap) => updateUI(snap);
 *   await liveRunner.start();
 *   // ... later ...
 *   await liveRunner.stop("user stopped");
 */

import type { Candle } from "./types.ts";
import type { PaperLeagueRunner } from "./paperLeagueRunner.ts";
import type { ConcreteCredentialStore } from "./governance/credentialStore.ts";
import type { GovernanceEngine } from "./governance/governanceEngine.ts";
import type { AuditLog } from "./governance/auditLog.ts";
import type { EnablementGate } from "./brokerTypes.ts";
import { saveLiveSession, loadLiveSession, utcDateKey } from "./liveSessionStorage.ts";
import type { PersistedSleeveState } from "./liveSessionStorage.ts";
import type { GovernanceBotStats } from "./governance/governanceEngine.ts";

// ─── Public types ─────────────────────────────────────────────────────────────

export type WsStatus = "disconnected" | "connecting" | "connected" | "fallback";

export interface PaperLiveConfig {
  /** Alpaca IEX WebSocket URL. */
  wsUrl: string;
  /** Alpaca data REST API base URL. */
  dataApiUrl: string;
  /** Alpaca broker REST API base URL (for clock and account endpoints). */
  brokerApiUrl: string;
  /** Interval in ms for REST polling fallback. */
  restPollIntervalMs: number;
  /** Delay in ms before attempting a WebSocket reconnect. */
  wsReconnectDelayMs: number;
  /** Maximum number of WebSocket reconnect attempts before switching to fallback. */
  maxReconnectAttempts: number;
  /** Number of historical bars to fetch from REST on start (0 = skip bootstrap). */
  bootstrapBars: number;
}

export const DEFAULT_PAPER_LIVE_CONFIG: PaperLiveConfig = {
  wsUrl: "wss://stream.data.alpaca.markets/v2/iex",
  dataApiUrl: "https://data.alpaca.markets",
  brokerApiUrl: "https://paper-api.alpaca.markets",
  restPollIntervalMs: 60_000,
  wsReconnectDelayMs: 5_000,
  maxReconnectAttempts: 3,
  bootstrapBars: 200,
};

export interface LiveRunnerSnapshot {
  isMarketOpen: boolean;
  barsReceived: number;
  lastBarAt: number | null;
  wsStatus: WsStatus;
}

// ─── Internal Alpaca API types ────────────────────────────────────────────────

interface AlpacaBarMsg {
  T: "b";
  S: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  t: string;
  vw?: number;
}

interface AlpacaBarsResponse {
  bars: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }>;
  next_page_token?: string | null;
}

interface AlpacaLatestBarResponse {
  symbol: string;
  bar: { t: string; o: number; h: number; l: number; c: number; v: number };
}

interface AlpacaClock {
  is_open: boolean;
  next_open: string;
  next_close: string;
}

// ─── PaperLiveRunner ──────────────────────────────────────────────────────────

export class PaperLiveRunner {
  /** Called on every meaningful state change (bar received, WS status, etc.). */
  onSnapshot?: (s: LiveRunnerSnapshot) => void;
  /** Called when an unrecoverable error occurs (gate disarm, etc.). */
  onError?: (err: Error) => void;

  private running = false;
  private _isMarketOpen = false;
  private _barsReceived = 0;
  private _lastBarAt: number | null = null;
  private _wsStatus: WsStatus = "disconnected";

  private _barHistory: Candle[] = [];

  private _ws: WebSocket | null = null;
  private _wsReconnectAttempts = 0;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _restPollTimer: ReturnType<typeof setInterval> | null = null;

  private readonly _wsFactory: (url: string) => WebSocket;
  private readonly _fetchFn: typeof fetch;

  /**
   * @param leagueRunner  The PaperLeagueRunner to drive with live bars.
   * @param store         Credential store — must be ARMED before start().
   * @param governance    GovernanceEngine — for stats injection on recovery.
   * @param auditLog      Audit log for structured event recording.
   * @param gate          Enablement gate — assertArmed() is called in start().
   * @param symbol        The symbol to subscribe to (e.g. "SPY").
   * @param config        Configuration overrides.
   * @param botIds        Bot IDs whose governance stats should be persisted.
   * @param _wsFactory    Injectable WebSocket constructor (for tests).
   * @param _fetchFn      Injectable fetch function (for tests).
   */
  constructor(
    private readonly leagueRunner: PaperLeagueRunner,
    private readonly store: ConcreteCredentialStore,
    private readonly governance: GovernanceEngine,
    private readonly auditLog: AuditLog,
    private readonly gate: EnablementGate,
    private readonly symbol: string,
    private readonly config: PaperLiveConfig = DEFAULT_PAPER_LIVE_CONFIG,
    private readonly botIds: string[] = [],
    _wsFactory?: (url: string) => WebSocket,
    _fetchFn?: typeof fetch,
  ) {
    this._wsFactory = _wsFactory ?? ((url) => new WebSocket(url));
    this._fetchFn = _fetchFn ?? fetch.bind(globalThis);
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Start the live runner.
   *
   * 1. Asserts gate is ARMED.
   * 2. Restores any same-day session from localStorage.
   * 3. Bootstraps bar history from REST.
   * 4. Fetches market clock.
   * 5. Starts the underlying PaperLeagueRunner.
   * 6. Connects WebSocket and starts REST polling.
   */
  async start(): Promise<void> {
    this.gate.assertArmed();

    // ── Restore same-day session ──────────────────────────────────────────
    const persisted = loadLiveSession(this.symbol);
    if (persisted) {
      this._barHistory = persisted.barHistory.slice();
      this._barsReceived = persisted.barsReceived;
      this._lastBarAt = persisted.lastBarAt;

      // Re-inject governance stats for each bot so daily limits survive reload.
      for (const stats of persisted.botStats) {
        const govStats: GovernanceBotStats = {
          dailyOrderCount: stats.dailyOrderCount,
          realizedDailyLossUsd: stats.realizedDailyLossUsd,
          committedCapitalUsd: 0, // always reset — open positions are session-scoped
          dayKey: stats.dayKey,
        };
        this.governance.injectStats(stats.botId, govStats);
      }

      // Re-inject sleeve state (cash, positions, allocation, eligibility) so the
      // new PaperLeagueRunner starts with the correct portfolio rather than fresh
      // $startingCapital sleeves. Must happen before leagueRunner.start() so that
      // the session-start reconciliation sees the recovered portfolio (P0 fix).
      if (persisted.sleeves && persisted.sleeves.length > 0) {
        const latestClose = this._barHistory.length > 0
          ? this._barHistory[this._barHistory.length - 1]!.close
          : 0;
        this.leagueRunner.injectSleeveState(
          persisted.sleeves,
          persisted.unallocatedCash ?? 0,
          latestClose,
        );
      }

      this.auditLog.record("SESSION_START", "Restored same-day live session from localStorage", {
        symbol: this.symbol,
        barsRestored: this._barHistory.length,
        barsReceived: this._barsReceived,
        lastBarAt: this._lastBarAt,
        sleevesRestored: persisted.sleeves?.length ?? 0,
        unallocatedCash: persisted.unallocatedCash ?? 0,
      });
    }

    // ── Bootstrap bar history from REST ───────────────────────────────────
    if (this.config.bootstrapBars > 0) {
      await this._bootstrapBars();
    }

    // ── Fetch initial market clock ─────────────────────────────────────────
    try {
      const clock = await this._fetchClock();
      this._isMarketOpen = clock.is_open;
    } catch {
      // Non-fatal — will retry on each bar
      this._isMarketOpen = false;
    }

    // ── Start league runner ───────────────────────────────────────────────
    await this.leagueRunner.start();

    this.running = true;

    // ── Connect WS + start REST polling ──────────────────────────────────
    this._connectWS();
    this._startRestPolling();

    this._emitSnapshot();
  }

  /**
   * Stop the live runner gracefully.
   * Closes WS, clears timers, ends the league runner, and persists the session.
   */
  async stop(reason?: string): Promise<void> {
    this.running = false;

    // Close WebSocket
    if (this._ws !== null) {
      try { this._ws.close(); } catch {/* ignore */}
      this._ws = null;
    }

    // Clear REST poll interval
    if (this._restPollTimer !== null) {
      clearInterval(this._restPollTimer);
      this._restPollTimer = null;
    }

    // Clear reconnect timer
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    // End the league runner
    try {
      await this.leagueRunner.end();
    } catch {/* best-effort */}

    this._saveSession();

    if (reason) {
      this.auditLog.record("SESSION_END", `PaperLiveRunner stopped: ${reason}`, {
        symbol: this.symbol,
        barsReceived: this._barsReceived,
      });
    }
  }

  /** Current state snapshot. */
  get snapshot(): LiveRunnerSnapshot {
    return {
      isMarketOpen: this._isMarketOpen,
      barsReceived: this._barsReceived,
      lastBarAt: this._lastBarAt,
      wsStatus: this._wsStatus,
    };
  }

  /** Read-only access to the accumulated bar history. */
  get barHistory(): readonly Candle[] {
    return this._barHistory;
  }

  // ─── WebSocket ────────────────────────────────────────────────────────────

  private _connectWS(): void {
    this._wsStatus = "connecting";
    this._emitSnapshot();

    let creds;
    try {
      creds = this.store.get();
    } catch (err) {
      this.auditLog.record("ERROR", "PaperLiveRunner: cannot get credentials for WS auth", {
        error: String(err),
      });
      this._wsStatus = "fallback";
      this._emitSnapshot();
      return;
    }

    const ws = this._wsFactory(this.config.wsUrl);
    this._ws = ws;

    ws.onopen = () => {
      // Send auth message
      ws.send(JSON.stringify({
        action: "auth",
        key: creds.apiKey,
        secret: creds.apiSecret,
      }));
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const msgs = JSON.parse(event.data as string) as unknown[];
        void this._handleWSMessages(msgs);
      } catch (err) {
        this.auditLog.record("ERROR", "PaperLiveRunner: WS message parse error", {
          error: String(err),
        });
      }
    };

    ws.onclose = (event: CloseEvent) => {
      if (!this.running) return;

      this.auditLog.record("ERROR", `PaperLiveRunner: WS closed (code ${event.code})`, {
        code: event.code,
        reason: event.reason,
      });

      // Attempt reconnect or fall back to REST-only
      if (this._wsReconnectAttempts < this.config.maxReconnectAttempts) {
        this._wsReconnectAttempts++;
        this._wsStatus = "connecting";
        this._emitSnapshot();

        this._reconnectTimer = setTimeout(() => {
          if (this.running) {
            this._connectWS();
          }
        }, this.config.wsReconnectDelayMs);
      } else {
        this._wsStatus = "fallback";
        this.auditLog.record("ERROR",
          "PaperLiveRunner: WS max reconnect attempts reached — switching to REST-only polling", {
            attempts: this._wsReconnectAttempts,
          },
        );
        this._emitSnapshot();
      }
    };

    ws.onerror = (_event: Event) => {
      this.auditLog.record("ERROR", "PaperLiveRunner: WS error event", {
        symbol: this.symbol,
      });
    };
  }

  private async _handleWSMessages(msgs: unknown[]): Promise<void> {
    for (const msg of msgs) {
      if (typeof msg !== "object" || msg === null) continue;
      const m = msg as Record<string, unknown>;

      // Auth success → subscribe to bars
      if (m["T"] === "success" && m["msg"] === "authenticated") {
        this._ws?.send(JSON.stringify({
          action: "subscribe",
          bars: [this.symbol],
        }));
        continue;
      }

      // Subscription confirmation → connected
      if (m["T"] === "subscription") {
        this._wsStatus = "connected";
        this._wsReconnectAttempts = 0; // reset on successful connection
        this._emitSnapshot();
        continue;
      }

      // Bar message
      if (m["T"] === "b") {
        await this._processBar(m as unknown as AlpacaBarMsg);
        continue;
      }

      // Error message
      if (m["T"] === "error") {
        const code = m["code"] as number | undefined;
        const errMsg = m["msg"] as string | undefined;
        this.auditLog.record("ERROR", `PaperLiveRunner: WS error from server: ${errMsg}`, {
          code,
          msg: errMsg,
        });

        // Auth error → disarm gate
        if (code === 402 || code === 403) {
          this.gate.disarm(`Alpaca WS auth error (code ${code}): ${errMsg}`);
          const err = new Error(`Alpaca WS auth error: ${errMsg}`);
          this.onError?.(err);
        }
      }
    }
  }

  // ─── Bar processing ───────────────────────────────────────────────────────

  private async _processBar(raw: AlpacaBarMsg): Promise<void> {
    const timestamp = Date.parse(raw.t);
    if (!Number.isFinite(timestamp)) {
      this.auditLog.record("ERROR", "PaperLiveRunner: invalid bar timestamp", {
        t: raw.t,
      });
      return;
    }

    // Dedup: skip bars we've already processed
    if (this._lastBarAt !== null && timestamp <= this._lastBarAt) {
      return;
    }

    // Re-fetch clock to check market hours
    try {
      const clock = await this._fetchClock();
      this._isMarketOpen = clock.is_open;
    } catch {
      // Use cached value on error
    }

    if (!this._isMarketOpen) {
      // Update _lastBarAt even for closed-market bars so that REST polling does
      // not re-deliver the same bar on every poll interval while the market is
      // closed (P1b dedup fix).
      this._lastBarAt = timestamp;
      this.auditLog.record("GOVERNANCE_CHECK", "BAR_SKIPPED — market closed", {
        symbol: this.symbol,
        timestamp,
        barTime: raw.t,
      });
      this._emitSnapshot();
      return;
    }

    const candle: Candle = {
      symbol: raw.S,
      timestamp,
      open: raw.o,
      high: raw.h,
      low: raw.l,
      close: raw.c,
      volume: raw.v,
    } as unknown as Candle;

    // Gap detection: warn if gap > 2 minutes
    if (this._barHistory.length > 0) {
      const prevBar = this._barHistory[this._barHistory.length - 1]!;
      const gapMs = timestamp - prevBar.timestamp;
      if (gapMs > 2 * 60 * 1000) {
        this.auditLog.record("ERROR", `BAR_GAP detected: ${(gapMs / 60000).toFixed(1)} min gap`, {
          symbol: this.symbol,
          prevTimestamp: prevBar.timestamp,
          currTimestamp: timestamp,
          gapMs,
          gapMinutes: gapMs / 60000,
        });
      }
    }

    this._barHistory.push(candle);

    // Tick the league runner
    try {
      await this.leagueRunner.tick(candle, this._barHistory);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.auditLog.record("ERROR", `PaperLiveRunner: leagueRunner.tick() threw: ${msg}`, {
        symbol: this.symbol,
        timestamp,
        error: msg,
      });
      // If this looks like a broker error, the gate may already be disarmed.
      // Propagate to onError so the UI can react.
      if (this.gate.status !== "ARMED") {
        this.onError?.(err instanceof Error ? err : new Error(msg));
      }
      return;
    }

    this._lastBarAt = timestamp;
    this._barsReceived++;
    this._saveSession();
    this._emitSnapshot();
  }

  // ─── REST polling ─────────────────────────────────────────────────────────

  private _startRestPolling(): void {
    this._restPollTimer = setInterval(() => {
      void this._pollRestBar();
    }, this.config.restPollIntervalMs);
  }

  private async _pollRestBar(): Promise<void> {
    // True fallback behaviour: skip REST poll while WebSocket is healthy (P1a fix).
    // REST only drives ticks when wsStatus is "fallback" or "disconnected".
    if (!this.running || this._wsStatus === "connected") return;

    try {
      const creds = this.store.get();
      const url = `${this.config.dataApiUrl}/v2/stocks/${this.symbol}/bars/latest`;
      const resp = await this._fetchFn(url, {
        headers: {
          "APCA-API-KEY-ID": creds.apiKey,
          "APCA-API-SECRET-KEY": creds.apiSecret,
        },
      });

      if (!resp.ok) {
        this.auditLog.record("ERROR", `PaperLiveRunner: REST latest bar returned ${resp.status}`, {
          status: resp.status,
          symbol: this.symbol,
        });
        return;
      }

      const data = await resp.json() as AlpacaLatestBarResponse;
      const barTimestamp = Date.parse(data.bar.t);
      if (!Number.isFinite(barTimestamp)) return;

      if (barTimestamp > (this._lastBarAt ?? 0)) {
        const raw: AlpacaBarMsg = {
          T: "b",
          S: data.symbol,
          o: data.bar.o,
          h: data.bar.h,
          l: data.bar.l,
          c: data.bar.c,
          v: data.bar.v,
          t: data.bar.t,
        };
        await this._processBar(raw);
      }
    } catch (err) {
      this.auditLog.record("ERROR", `PaperLiveRunner: REST poll error: ${String(err)}`, {
        symbol: this.symbol,
        error: String(err),
      });
    }
  }

  // ─── Bootstrap ────────────────────────────────────────────────────────────

  private async _bootstrapBars(): Promise<void> {
    try {
      const creds = this.store.get();
      const url =
        `${this.config.dataApiUrl}/v2/stocks/${this.symbol}/bars` +
        `?timeframe=1Min&limit=${this.config.bootstrapBars}&sort=desc`;

      const resp = await this._fetchFn(url, {
        headers: {
          "APCA-API-KEY-ID": creds.apiKey,
          "APCA-API-SECRET-KEY": creds.apiSecret,
        },
      });

      if (!resp.ok) {
        this.auditLog.record("ERROR",
          `PaperLiveRunner: bootstrap REST returned ${resp.status}`, {
            status: resp.status, symbol: this.symbol,
          },
        );
        return;
      }

      const data = await resp.json() as AlpacaBarsResponse;
      if (!Array.isArray(data.bars) || data.bars.length === 0) return;

      // REST returns newest-first with sort=desc; reverse to chronological order.
      const newBars: Candle[] = data.bars.reverse().map((b) => ({
        timestamp: Date.parse(b.t),
        open: b.o,
        high: b.h,
        low: b.l,
        close: b.c,
        volume: b.v,
      } as Candle));

      // Merge: append bootstrap bars that are newer than any restored bar.
      const cutoff = this._barHistory.length > 0
        ? this._barHistory[this._barHistory.length - 1]!.timestamp
        : -Infinity;

      const toAppend = newBars.filter((b) => b.timestamp > cutoff);
      this._barHistory.push(...toAppend);

      this.auditLog.record("SESSION_START",
        `PaperLiveRunner: bootstrapped ${toAppend.length} bars from REST`, {
          symbol: this.symbol,
          fetched: newBars.length,
          appended: toAppend.length,
        },
      );
    } catch (err) {
      this.auditLog.record("ERROR",
        `PaperLiveRunner: bootstrap error: ${String(err)}`, {
          symbol: this.symbol,
          error: String(err),
        },
      );
    }
  }

  // ─── Clock ────────────────────────────────────────────────────────────────

  private async _fetchClock(): Promise<AlpacaClock> {
    const creds = this.store.get();
    const url = `${this.config.brokerApiUrl}/v2/clock`;
    const resp = await this._fetchFn(url, {
      headers: {
        "APCA-API-KEY-ID": creds.apiKey,
        "APCA-API-SECRET-KEY": creds.apiSecret,
      },
    });
    if (!resp.ok) {
      throw new Error(`Clock fetch returned ${resp.status}`);
    }
    return resp.json() as Promise<AlpacaClock>;
  }

  // ─── Session persistence ──────────────────────────────────────────────────

  private _saveSession(): void {
    const botStats = this.botIds.flatMap((botId) => {
      const stats = this.governance.getStats(botId);
      if (!stats) return [];
      return [{
        botId,
        dailyOrderCount: stats.dailyOrderCount,
        realizedDailyLossUsd: stats.realizedDailyLossUsd,
        dayKey: stats.dayKey,
      }];
    });

    // Persist sleeve state (cash, positions, allocation, eligibility) so that a
    // same-day page reload can reconstruct the correct portfolio before start()
    // rather than initialising fresh $startingCapital sleeves (P0 fix).
    let sleeves: PersistedSleeveState[] = [];
    let unallocatedCash = 0;
    try {
      sleeves = this.leagueRunner.getSleeveSnapshots();
      unallocatedCash = this.leagueRunner.getState().unallocatedCash;
    } catch {
      // If the runner hasn't started yet (e.g. stop() called before start()
      // completes), getSleeveSnapshots() may fail — fall back to empty.
    }

    saveLiveSession({
      symbol: this.symbol,
      sessionDate: utcDateKey(),
      barHistory: this._barHistory as Candle[],
      barsReceived: this._barsReceived,
      lastBarAt: this._lastBarAt,
      botStats,
      sleeves,
      unallocatedCash,
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private _emitSnapshot(): void {
    this.onSnapshot?.(this.snapshot);
  }
}
