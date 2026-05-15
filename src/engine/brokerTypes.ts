/**
 * Broker-adjacent types for paper and live trading.
 *
 * This file is a DESIGN DOCUMENT expressed as TypeScript types — Milestone 6.
 * No runtime logic is implemented here. All types compile and are referenced
 * by the paper adapter stub, but no API calls are made anywhere in the
 * codebase at this milestone.
 *
 * Sections:
 *   1. Secrets Management Plan
 *   2. Manual Enablement Gates
 *   3. Alpaca Paper API — Order Types
 *   4. Alpaca Paper API — Account Snapshot
 *   5. Account and Order Reconciliation Model
 *   6. Broker Event Ingestion Design
 *   7. Paper Adapter Configuration
 */

import type { PortfolioSnapshot } from "./types.ts";

// ─── 1. Secrets Management Plan ───────────────────────────────────────────────
//
// PLAN (Milestone 6 — not yet implemented):
//
// API keys are NEVER stored in source code, committed to git, placed in
// localStorage, or passed as URL query parameters.
//
// Browser context (this app):
//   - The user pastes credentials into a locked in-memory CredentialStore
//     (a plain object; never written to any Web Storage API).
//   - The store is gated behind the EnablementGate: it refuses to vend the
//     secret unless the gate is ARMED.
//   - The UI shows a persistent warning banner while paper mode is armed.
//   - Credentials are wiped from memory on page unload.
//
// Node/CLI context (match runner, future server):
//   - Credentials are read from ALPACA_API_KEY / ALPACA_API_SECRET env vars.
//   - A .env file may be used locally via `dotenv`; it MUST be in .gitignore.
//
// Never use live-account API keys in the paper adapter. Alpaca issues separate
// keys for paper and live; the paper keys are stored here.

export interface AlpacaCredentials {
  readonly apiKey: string;     // ALPACA_API_KEY — paper trading key only
  readonly apiSecret: string;  // ALPACA_API_SECRET — paper trading secret only
  readonly baseUrl: string;    // "https://paper-api.alpaca.markets"
}

/**
 * In-memory credential store. Holds secrets only in memory; never serialised.
 * Implementation: Milestone 7+.
 */
export interface CredentialStore {
  /** Store credentials. Throws if gate is not ARMED. */
  set(credentials: AlpacaCredentials): void;
  /** Retrieve credentials. Throws GateDisarmedError if not ARMED. */
  get(): AlpacaCredentials;
  /** Wipe credentials from memory immediately. */
  clear(): void;
}

// ─── 2. Manual Enablement Gates ───────────────────────────────────────────────
//
// No order may be submitted to any broker API unless the gate is ARMED.
//
// The gate starts DISARMED and auto-disarms after `autoDisarmAfterMs`
// milliseconds (default: 4 hours). It also disarms on any reconciliation
// failure, any unhandled broker error, or explicit user action.
//
// Arming requires ALL of:
//   1. Credentials present in the CredentialStore.
//   2. Explicit user confirmation: UI checkbox + dialog, or CLI --arm-paper flag.
//   3. A successful account snapshot fetch (proves credentials work and the
//      account is in good standing).
//
// The gate is checked by the adapter BEFORE every outbound API call.

export type GateStatus =
  | "DISARMED"           // initial state; no broker calls allowed
  | "ARMING"             // arming preconditions are being verified
  | "ARMED"              // broker calls are allowed
  | "DISARMED_ON_ERROR"; // auto-disarmed after a broker error or drift

/**
 * Manual enablement gate interface.
 * Implementation: Milestone 7+.
 */
export interface EnablementGate {
  readonly status: GateStatus;
  /** Attempt to arm. Returns true on success; throws on precondition failure. */
  arm(): Promise<boolean>;
  /** Immediately disarm. Safe to call at any time. */
  disarm(reason?: string): void;
  /** Throws GateDisarmedError if status !== "ARMED". */
  assertArmed(): void;
}

/** Thrown by EnablementGate.assertArmed() and CredentialStore.get(). */
export class GateDisarmedError extends Error {
  constructor(reason?: string) {
    super(`EnablementGate is not ARMED${reason ? `: ${reason}` : ""}`);
    this.name = "GateDisarmedError";
  }
}

// ─── 3. Alpaca Paper API — Order Types ────────────────────────────────────────

/** Subset of Alpaca v2 create-order request fields for market orders. */
export interface AlpacaOrderRequest {
  symbol: string;
  side: "buy" | "sell";
  type: "market";
  time_in_force: "day" | "gtc";
  /** Whole-share quantity. Mutually exclusive with `notional`. */
  qty?: string;
  /** Notional USD amount — used for targetAllocation size. */
  notional?: string;
  /** Engine-generated UUID for idempotency; stored on the OrderIntent side. */
  client_order_id?: string;
}

/** Subset of Alpaca v2 order response fields needed for fill reconciliation. */
export interface AlpacaOrderResponse {
  id: string;               // Alpaca order UUID
  client_order_id: string;
  symbol: string;
  side: "buy" | "sell";
  type: "market";
  status: AlpacaOrderStatus;
  qty: string;              // requested quantity
  filled_qty: string;       // quantity filled so far
  filled_avg_price: string | null;
  created_at: string;       // ISO 8601
  filled_at: string | null; // ISO 8601; null until fully filled
}

export type AlpacaOrderStatus =
  | "new"
  | "partially_filled"
  | "filled"
  | "done_for_day"
  | "canceled"
  | "expired"
  | "replaced"
  | "pending_cancel"
  | "pending_replace"
  | "held"
  | "accepted"
  | "pending_new"
  | "accepted_for_bidding"
  | "stopped"
  | "rejected"
  | "suspended"
  | "calculated";

// ─── 4. Alpaca Paper API — Account Snapshot ───────────────────────────────────

/** Alpaca account fields used for reconciliation. */
export interface AlpacaAccountSnapshot {
  id: string;
  account_number: string;
  status: string;
  cash: string;             // available cash (USD string)
  portfolio_value: string;  // total portfolio value
  buying_power: string;
  positions: AlpacaPosition[];
  orders_pending: AlpacaOrderResponse[];
  fetched_at: number;       // Unix ms; set by the adapter when the snapshot is fetched
}

export interface AlpacaPosition {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  market_value: string;
  unrealized_pl: string;
}

// ─── 5. Account and Order Reconciliation Model ────────────────────────────────
//
// DESIGN (Milestone 6):
//
// Reconciliation compares the engine's internal PortfolioSnapshot against the
// broker's AlpacaAccountSnapshot and flags any drift.
//
// When to reconcile:
//   - On session start, before the first order is submitted.
//   - After any unexpected fill, cancel, or broker error event.
//   - On manual user request from the UI.
//
// What is a "drift":
//   - Position drift: engine qty !== broker qty by more than driftToleranceShares.
//   - Cash drift: engine cash !== broker cash by more than driftToleranceCash (USD).
//
// On any drift:
//   1. The gate is immediately DISARMED.
//   2. A RECONCILIATION_DRIFT ArenaEvent is emitted with the drift details.
//   3. The UI shows a blocking error panel; no further orders are submitted.
//   4. The user must review and manually re-arm after resolving the discrepancy.

export interface ReconciliationDrift {
  /** undefined = cash drift; string = position drift for the named symbol. */
  symbol?: string;
  /** Value from the engine's internal state. */
  engineValue: number;
  /** Value from the broker's account snapshot. */
  brokerValue: number;
  /** brokerValue - engineValue */
  delta: number;
}

export interface BrokerReconciliationResult {
  ok: boolean;
  drifts: ReconciliationDrift[];
  engineSnapshot: PortfolioSnapshot;
  brokerSnapshot: AlpacaAccountSnapshot;
  reconciledAt: number;  // Unix ms
}

// ─── 6. Broker Event Ingestion Design ────────────────────────────────────────
//
// DESIGN (Milestone 6):
//
// Alpaca delivers order and account updates over a WebSocket stream:
//   wss://paper-api.alpaca.markets/stream
//
// The ingestion layer will:
//   1. Maintain a WebSocket connection ONLY while the gate is ARMED.
//   2. Parse each message into a BrokerEventEnvelope.
//   3. Pass each envelope to PaperBrokerAdapter.ingestBrokerEvent().
//   4. Emit the resulting ArenaEvent to the engine's EventLog.
//   5. If the event is a fill, call applyFill() on the affected BotInstance.
//   6. Trigger reconciliation on any unexpected cancel, reject, or error.
//
// The WebSocket is torn down immediately when the gate is DISARMED.
// The raw payload is preserved in BrokerEventEnvelope.raw for audit purposes.

export type BrokerEventType =
  | "trade_updates"    // Alpaca order lifecycle events (fills, cancels, etc.)
  | "account_updates"  // Alpaca account balance / position changes
  | "connection_error" // Transport-level WebSocket error
  | "auth_error";      // Authentication failure from Alpaca

export interface BrokerEventEnvelope {
  type: BrokerEventType;
  receivedAt: number;              // Unix ms; set by the ingestion layer
  raw: Record<string, unknown>;    // The unparsed JSON payload, preserved for audit
}

// ─── 7. Paper Adapter Configuration ─────────────────────────────────────────

export interface PaperAdapterConfig {
  /** Only these symbols may be traded in paper mode (allowlist). */
  allowedSymbols: string[];
  /** Maximum number of open orders at any time. */
  maxOpenOrders: number;
  /** Maximum single order notional value in USD. */
  maxOrderNotional: number;
  /** Position quantity drift tolerance (in shares) before reconciliation fails. */
  driftToleranceShares: number;
  /** Cash drift tolerance (in USD) before reconciliation fails. */
  driftToleranceCash: number;
  /** Gate auto-disarms after this many milliseconds. Default: 4 hours. */
  autoDisarmAfterMs: number;
}
