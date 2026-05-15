/**
 * Audit log for paper and live trading sessions.
 *
 * Every governance-relevant event — order intents, submissions, fills,
 * cancels, errors, gate transitions, and reconciliation results — is
 * recorded here as an immutable append-only entry.
 *
 * Entries are kept in memory for the session lifetime. They can be
 * serialised to JSON for export or off-session review.
 *
 * Design constraints:
 *   - Append-only: entries are never mutated or deleted at runtime.
 *   - Synchronous: record() is sync so callers never need to await it.
 *   - No I/O: the log does not write to disk or send data anywhere. Callers
 *     that want persistence should call export() and write the result.
 */

// ─── Audit Entry Types ────────────────────────────────────────────────────────

export type AuditEventType =
  | "GATE_ARMED"              // Gate transitioned to ARMED
  | "GATE_DISARMED"           // Gate disarmed (reason included)
  | "PRECONDITION_RESULT"     // One arming precondition was evaluated
  | "ORDER_INTENT"            // A strategy emitted an OrderIntent
  | "GOVERNANCE_CHECK"        // GovernanceEngine evaluated an intent
  | "ORDER_SUBMITTED"         // Adapter submitted the order to the broker
  | "ORDER_FILL"              // Broker confirmed a fill
  | "ORDER_REJECTED"          // Broker rejected the order
  | "ORDER_CANCELLED"         // Order was cancelled
  | "RECONCILIATION"          // Account reconciliation was run
  | "RECONCILIATION_DRIFT"    // Reconciliation found drift
  | "SESSION_START"           // Paper session started
  | "SESSION_END"             // Paper session ended
  | "ERROR";                  // Unexpected error (broker or internal)

export interface AuditEntry {
  /** Monotonically increasing sequence number within this session. */
  readonly seq: number;
  /** Wall-clock timestamp (Unix ms) when the entry was recorded. */
  readonly timestamp: number;
  /** Structured event type for filtering and analysis. */
  readonly type: AuditEventType;
  /** Human-readable summary of the event. */
  readonly message: string;
  /**
   * Arbitrary structured payload — varies by event type.
   * Serialisable to JSON (no class instances, no circular refs).
   */
  readonly payload: Readonly<Record<string, unknown>>;
}

// ─── AuditLog ─────────────────────────────────────────────────────────────────

export class AuditLog {
  private readonly entries: AuditEntry[] = [];
  private seq = 0;

  /**
   * Record a new entry in the audit log.
   * Synchronous; never throws. Returns the recorded entry.
   */
  record(
    type: AuditEventType,
    message: string,
    payload: Record<string, unknown> = {},
  ): AuditEntry {
    const entry: AuditEntry = Object.freeze({
      seq: this.seq++,
      timestamp: Date.now(),
      type,
      message,
      payload: Object.freeze({ ...payload }),
    });
    this.entries.push(entry);
    return entry;
  }

  /**
   * Return a snapshot of all entries recorded so far.
   * The array is a copy — mutations do not affect the log.
   */
  getEntries(): readonly AuditEntry[] {
    return this.entries.slice();
  }

  /**
   * Return entries matching the given event types.
   */
  filter(...types: AuditEventType[]): readonly AuditEntry[] {
    const typeSet = new Set(types);
    return this.entries.filter((e) => typeSet.has(e.type));
  }

  /**
   * Return a JSON-serialisable representation of the full log.
   * Suitable for file export or localStorage persistence.
   */
  export(): readonly AuditEntry[] {
    return this.getEntries();
  }

  /** Number of entries recorded so far. */
  get size(): number {
    return this.entries.length;
  }
}
