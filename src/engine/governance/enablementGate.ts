/**
 * Concrete implementation of the EnablementGate.
 *
 * The gate is the primary safety lock for paper and live trading. No order
 * may reach the broker adapter while the gate is DISARMED.
 *
 * Lifecycle:
 *   DISARMED  →  arm() called  →  ARMING  →  all preconditions pass  →  ARMED
 *   ARMED     →  autoDisarmAfterMs elapsed                           →  DISARMED
 *   ARMED     →  disarm() called or broker/reconcile error           →  DISARMED_ON_ERROR
 *
 * arm() is async: it runs all registered ArmingPreconditions in sequence and
 * records each result in the AuditLog before transitioning.
 *
 * Lifecycle subscribers (GateLifecycleSubscriber) are notified synchronously
 * on every state transition. Use gate.subscribe(store) to connect a
 * ConcreteCredentialStore so it arms/wipes automatically with the gate.
 */

import type {
  ArmingPrecondition,
  ArmingPreconditionResult,
  EnablementGate,
  GateLifecycleSubscriber,
  GateStatus,
} from "../brokerTypes.ts";
import { GateDisarmedError } from "../brokerTypes.ts";
import type { AuditLog } from "./auditLog.ts";

export class ConcreteEnablementGate implements EnablementGate {
  private _status: GateStatus = "DISARMED";
  private autoDisarmTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly subscribers: GateLifecycleSubscriber[] = [];

  constructor(
    private readonly preconditions: ArmingPrecondition[],
    private readonly auditLog: AuditLog,
    private readonly autoDisarmAfterMs: number = 4 * 60 * 60 * 1000,
  ) {}

  get status(): GateStatus {
    return this._status;
  }

  /**
   * Register a lifecycle subscriber. Notified synchronously on every
   * arm/disarm transition. Safe to call at any time.
   */
  subscribe(subscriber: GateLifecycleSubscriber): void {
    this.subscribers.push(subscriber);
  }

  /**
   * Attempt to arm the gate.
   *
   * Runs all preconditions in sequence. If any fails, transitions to DISARMED
   * and returns false. On full success, transitions to ARMED, schedules
   * auto-disarm, and notifies all subscribers via onArmed().
   *
   * Throws if already ARMING (re-entrant arm() calls are not allowed).
   */
  async arm(): Promise<boolean> {
    if (this._status === "ARMING") {
      throw new GateDisarmedError("arm() already in progress");
    }

    // Idempotent: re-arming an already-ARMED gate is a no-op.
    // This prevents the following lifecycle bug: if arm() were allowed to
    // proceed from ARMED, a mid-sequence precondition failure would set
    // status → DISARMED without calling _notifyDisarmed(), leaving the
    // credential store's `armed` flag set to true even though the gate is not.
    // To re-arm from scratch, call disarm() first.
    if (this._status === "ARMED") {
      return true;
    }

    this._status = "ARMING";
    this.auditLog.record("GATE_ARMED", "Arming sequence started", {
      preconditionCount: this.preconditions.length,
    });

    const results: ArmingPreconditionResult[] = [];

    for (const precondition of this.preconditions) {
      let result: ArmingPreconditionResult;
      try {
        result = await precondition();
      } catch (err) {
        result = {
          check: "unknown",
          passed: false,
          detail: err instanceof Error ? err.message : String(err),
        };
      }

      results.push(result);
      this.auditLog.record(
        "PRECONDITION_RESULT",
        `${result.check}: ${result.passed ? "PASSED" : "FAILED"}`,
        {
          check: result.check,
          passed: result.passed,
          detail: result.detail ?? null,
        },
      );

      if (!result.passed) {
        // Cancel any lingering auto-disarm timer and notify subscribers so
        // any credential store that was previously armed gets wiped.
        this._clearAutoDisarmTimer();
        this._status = "DISARMED";
        this.auditLog.record("GATE_DISARMED", "Arming failed — precondition not met", {
          failedCheck: result.check,
          detail: result.detail ?? null,
        });
        this._notifyDisarmed("arming failed: precondition not met");
        return false;
      }
    }

    this._status = "ARMED";
    this._scheduleAutoDisarm();
    this.auditLog.record("GATE_ARMED", "Gate is now ARMED", {
      autoDisarmAfterMs: this.autoDisarmAfterMs,
      preconditionResults: results,
    });

    // Notify subscribers after the status is set and the audit entry is written
    this._notifyArmed();
    return true;
  }

  /**
   * Immediately disarm the gate. Safe to call at any time.
   * Cancels any pending auto-disarm timer and notifies all subscribers.
   */
  disarm(reason = "manual disarm"): void {
    const wasArmed = this._status === "ARMED" || this._status === "ARMING";
    this._clearAutoDisarmTimer();

    const newStatus: GateStatus =
      reason.includes("error") || reason.includes("drift") || reason.includes("Error")
        ? "DISARMED_ON_ERROR"
        : "DISARMED";
    this._status = newStatus;

    if (wasArmed || newStatus !== "DISARMED") {
      this.auditLog.record("GATE_DISARMED", `Gate disarmed: ${reason}`, {
        reason,
        status: newStatus,
      });
    }

    // Notify subscribers after status and audit entry are settled
    this._notifyDisarmed(reason);
  }

  /**
   * Assert the gate is ARMED. Throws GateDisarmedError if not.
   * Called by adapters and session runners before every outbound API request.
   */
  assertArmed(): void {
    if (this._status !== "ARMED") {
      throw new GateDisarmedError(`gate status is ${this._status}`);
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private _scheduleAutoDisarm(): void {
    this._clearAutoDisarmTimer();
    this.autoDisarmTimer = setTimeout(() => {
      const reason = "autoDisarmAfterMs elapsed";
      this._status = "DISARMED";
      this.auditLog.record("GATE_DISARMED", "Gate auto-disarmed after timeout", {
        reason,
        autoDisarmAfterMs: this.autoDisarmAfterMs,
      });
      this._notifyDisarmed(reason);
    }, this.autoDisarmAfterMs);
  }

  private _clearAutoDisarmTimer(): void {
    if (this.autoDisarmTimer !== null) {
      clearTimeout(this.autoDisarmTimer);
      this.autoDisarmTimer = null;
    }
  }

  private _notifyArmed(): void {
    for (const sub of this.subscribers) {
      try {
        sub.onArmed();
      } catch {
        // Subscribers must not throw, but swallow defensively.
      }
    }
  }

  private _notifyDisarmed(reason: string): void {
    for (const sub of this.subscribers) {
      try {
        sub.onDisarmed(reason);
      } catch {
        // Subscribers must not throw, but swallow defensively.
      }
    }
  }
}
