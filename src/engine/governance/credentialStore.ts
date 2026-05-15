/**
 * In-memory credential store for paper trading API keys.
 *
 * Secrets are held only in a plain object in heap memory — never written
 * to localStorage, sessionStorage, IndexedDB, cookies, or URL parameters.
 *
 * Arming flow (wired via GateLifecycleSubscriber):
 *   1. User calls set() to store credentials (BEFORE arming — credentials
 *      are a precondition for arming, not a result of it).
 *   2. An ArmingPrecondition checks store.hasCredentials === true.
 *   3. Another ArmingPrecondition fetches an account snapshot to verify
 *      the credentials work.
 *   4. Gate transitions to ARMED → calls store.onArmed() via subscriber.
 *   5. The adapter calls get() to retrieve credentials for API calls.
 *      get() throws GateDisarmedError if not armed.
 *   6. Gate disarms (user, error, or timeout) → calls store.onDisarmed()
 *      via subscriber. Credentials are wiped immediately.
 *
 * Wire-up:
 *   const store = new ConcreteCredentialStore();
 *   const gate  = new ConcreteEnablementGate(preconditions, auditLog);
 *   gate.subscribe(store);      ← connects the lifecycle
 *   store.set(credentials);     ← may be called before or after subscribe()
 *
 * Credentials are also cleared on page unload (browser context).
 */

import type {
  AlpacaCredentials,
  CredentialStore,
  GateLifecycleSubscriber,
} from "../brokerTypes.ts";
import { GateDisarmedError } from "../brokerTypes.ts";

export class ConcreteCredentialStore
  implements CredentialStore, GateLifecycleSubscriber
{
  private credentials: AlpacaCredentials | null = null;
  private armed = false;

  constructor() {
    // Wipe credentials from memory when the page unloads (browser only).
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", () => this.clear());
    }
  }

  // ─── GateLifecycleSubscriber ───────────────────────────────────────────────

  /**
   * Called by the gate (via subscriber notification) after it transitions to
   * ARMED. Unlocks get() for the armed adapter.
   * Never called directly — always called via gate.subscribe(this).
   */
  onArmed(): void {
    this.armed = true;
  }

  /**
   * Called by the gate (via subscriber notification) after it disarms.
   * Wipes credentials from memory immediately so they cannot be retrieved
   * after the gate drops. The user must re-enter credentials to re-arm.
   * Never called directly — always called via gate.subscribe(this).
   */
  onDisarmed(_reason: string): void {
    this.armed = false;
    this.credentials = null;
  }

  // ─── CredentialStore ───────────────────────────────────────────────────────

  /**
   * Store credentials. May be called BEFORE arming — credentials must exist
   * before arm() can verify them as a precondition. Does not throw.
   */
  set(credentials: AlpacaCredentials): void {
    this.credentials = { ...credentials };
  }

  /**
   * Retrieve stored credentials.
   * Throws GateDisarmedError if the gate has not called onArmed() or if
   * no credentials have been stored.
   */
  get(): AlpacaCredentials {
    if (!this.armed || this.credentials === null) {
      throw new GateDisarmedError(
        "no credentials available — gate must be ARMED and credentials set via set()",
      );
    }
    return { ...this.credentials };
  }

  /**
   * Wipe credentials from memory immediately.
   * Safe to call at any time; does not throw.
   */
  clear(): void {
    this.credentials = null;
  }

  /** True if credentials have been stored (regardless of gate state). */
  get hasCredentials(): boolean {
    return this.credentials !== null;
  }
}
