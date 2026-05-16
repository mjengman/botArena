/**
 * Alpaca Paper API arming precondition chain.
 *
 * Returns an ordered array of three ArmingPrecondition functions that the
 * ConcreteEnablementGate runs in sequence before transitioning to ARMED:
 *
 *   1. credentials-present  — store has an API key and secret
 *   2. account-reachable    — GET /v2/account returns 200 OK
 *   3. account-active       — account.status === "ACTIVE"
 *
 * Preconditions 2 and 3 share a single fetch via a closure-scoped variable,
 * so the account endpoint is only hit once per arming attempt.
 *
 * Usage:
 *   const preconditions = makeAlpacaArmingPreconditions(store);
 *   const gate = new ConcreteEnablementGate(preconditions, auditLog);
 */

import type { ArmingPrecondition } from "../brokerTypes.ts";
import type { ConcreteCredentialStore } from "../governance/credentialStore.ts";

/** Minimal subset of the Alpaca account response needed for arming checks. */
interface AlpacaAccountMinimal {
  id: string;
  account_number: string;
  status: string;
}

/**
 * Create the Alpaca Paper arming precondition chain.
 *
 * @param store    Credential store that holds the API key / secret.
 *                 Uses `peekForArming()` to access credentials without requiring
 *                 the gate to be ARMED (the gate is still transitioning at this point).
 * @param baseUrl  Alpaca Paper base URL. Defaults to the live paper endpoint.
 *                 Override in tests to avoid real network calls.
 */
export function makeAlpacaArmingPreconditions(
  store: ConcreteCredentialStore,
  baseUrl = "https://paper-api.alpaca.markets",
): ArmingPrecondition[] {
  // Shared across preconditions 2 and 3 so the fetch is only made once.
  let _fetchedAccount: AlpacaAccountMinimal | null = null;

  return [
    // ── 1. Credentials present ──────────────────────────────────────────────
    async () => ({
      check: "credentials-present",
      passed: store.hasCredentials,
      detail: store.hasCredentials
        ? undefined
        : "Enter your Alpaca Paper API key and secret first",
    }),

    // ── 2. Account reachable (GET /v2/account) ──────────────────────────────
    async () => {
      _fetchedAccount = null; // Reset on each arm attempt
      const creds = store.peekForArming();
      if (!creds) {
        return {
          check: "account-reachable",
          passed: false,
          detail: "No credentials available to verify",
        };
      }
      try {
        const response = await fetch(`${baseUrl}/v2/account`, {
          headers: {
            "APCA-API-KEY-ID": creds.apiKey,
            "APCA-API-SECRET-KEY": creds.apiSecret,
          },
        });
        if (!response.ok) {
          let bodyText = "";
          try { bodyText = await response.text(); } catch { /* ignore */ }
          return {
            check: "account-reachable",
            passed: false,
            detail: `Alpaca API error ${response.status}${bodyText ? `: ${bodyText}` : ""}`,
          };
        }
        _fetchedAccount = (await response.json()) as AlpacaAccountMinimal;
        return {
          check: "account-reachable",
          passed: true,
          detail: `Account ${_fetchedAccount.account_number} fetched`,
        };
      } catch (err) {
        return {
          check: "account-reachable",
          passed: false,
          detail: `Network error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },

    // ── 3. Account status ACTIVE ────────────────────────────────────────────
    async () => {
      if (!_fetchedAccount) {
        return {
          check: "account-active",
          passed: false,
          detail: "Account fetch did not succeed — cannot verify status",
        };
      }
      const active = _fetchedAccount.status === "ACTIVE";
      return {
        check: "account-active",
        passed: active,
        detail: active
          ? undefined
          : `Account status is "${_fetchedAccount.status}" — must be ACTIVE to trade`,
      };
    },
  ];
}
