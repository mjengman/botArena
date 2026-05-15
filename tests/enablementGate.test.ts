import { describe, it, expect, vi, beforeEach } from "vitest";
import { ConcreteEnablementGate } from "../src/engine/governance/enablementGate.ts";
import { AuditLog } from "../src/engine/governance/auditLog.ts";
import { GateDisarmedError } from "../src/engine/brokerTypes.ts";
import type { ArmingPrecondition, GateLifecycleSubscriber } from "../src/engine/brokerTypes.ts";

function makePassingPrecondition(label = "mock-check"): ArmingPrecondition {
  return async () => ({ check: label, passed: true });
}

function makeFailingPrecondition(label = "mock-check", detail = "intentional failure"): ArmingPrecondition {
  return async () => ({ check: label, passed: false, detail });
}

function makeThrowingPrecondition(label = "throwing-check"): ArmingPrecondition {
  return async () => {
    throw new Error(`${label} exploded`);
  };
}

function makeSubscriber(): GateLifecycleSubscriber & { armedCount: number; disarmedCount: number; lastDisarmReason: string } {
  const sub = {
    armedCount: 0,
    disarmedCount: 0,
    lastDisarmReason: "",
    onArmed() { this.armedCount++; },
    onDisarmed(reason: string) { this.disarmedCount++; this.lastDisarmReason = reason; },
  };
  return sub;
}

describe("ConcreteEnablementGate — initial state", () => {
  it("starts DISARMED", () => {
    const gate = new ConcreteEnablementGate([], new AuditLog());
    expect(gate.status).toBe("DISARMED");
  });

  it("assertArmed() throws GateDisarmedError when DISARMED", () => {
    const gate = new ConcreteEnablementGate([], new AuditLog());
    expect(() => gate.assertArmed()).toThrow(GateDisarmedError);
  });
});

describe("ConcreteEnablementGate — arm()", () => {
  it("transitions to ARMED when all preconditions pass", async () => {
    const gate = new ConcreteEnablementGate(
      [makePassingPrecondition("creds"), makePassingPrecondition("account")],
      new AuditLog(),
      60_000,
    );
    const result = await gate.arm();
    expect(result).toBe(true);
    expect(gate.status).toBe("ARMED");
  });

  it("transitions to DISARMED when a precondition fails", async () => {
    const gate = new ConcreteEnablementGate(
      [makePassingPrecondition(), makeFailingPrecondition("account-check")],
      new AuditLog(),
      60_000,
    );
    const result = await gate.arm();
    expect(result).toBe(false);
    expect(gate.status).toBe("DISARMED");
  });

  it("short-circuits on first failing precondition", async () => {
    const afterFail = vi.fn(async () => ({ check: "after-fail", passed: true }));
    const gate = new ConcreteEnablementGate(
      [makeFailingPrecondition("first"), afterFail],
      new AuditLog(),
      60_000,
    );
    await gate.arm();
    expect(afterFail).not.toHaveBeenCalled();
  });

  it("treats a throwing precondition as a failure", async () => {
    const gate = new ConcreteEnablementGate(
      [makeThrowingPrecondition()],
      new AuditLog(),
      60_000,
    );
    const result = await gate.arm();
    expect(result).toBe(false);
    expect(gate.status).toBe("DISARMED");
  });

  it("arm() with zero preconditions succeeds immediately", async () => {
    const gate = new ConcreteEnablementGate([], new AuditLog(), 60_000);
    const result = await gate.arm();
    expect(result).toBe(true);
    expect(gate.status).toBe("ARMED");
  });

  it("arm() is idempotent when already ARMED — returns true without re-running preconditions", async () => {
    const precondition = vi.fn(async () => ({ check: "check", passed: true }));
    const gate = new ConcreteEnablementGate([precondition], new AuditLog(), 60_000);
    await gate.arm();
    expect(precondition).toHaveBeenCalledTimes(1);
    const result = await gate.arm(); // second call
    expect(result).toBe(true);
    expect(gate.status).toBe("ARMED");
    expect(precondition).toHaveBeenCalledTimes(1); // not called again
  });

  it("arm() failure path notifies subscribers so credential store is wiped", async () => {
    // Regression: arm() failure used to set status→DISARMED without calling
    // _notifyDisarmed(), leaving the credential store's armed flag set to true.
    const { ConcreteCredentialStore } = await import(
      "../src/engine/governance/credentialStore.ts"
    );
    const store = new ConcreteCredentialStore();
    const log = new AuditLog();
    const gate = new ConcreteEnablementGate(
      [makePassingPrecondition("first"), makeFailingPrecondition("second")],
      log,
      60_000,
    );
    gate.subscribe(store);
    store.set({ apiKey: "KEY", apiSecret: "SECRET", baseUrl: "https://paper-api.alpaca.markets" });

    const result = await gate.arm();
    expect(result).toBe(false);
    expect(gate.status).toBe("DISARMED");
    // Credential store must be wiped — _notifyDisarmed() must have been called
    expect(store.hasCredentials).toBe(false);
    expect(() => store.get()).toThrow(GateDisarmedError);
  });

  it("assertArmed() no longer throws after successful arm()", async () => {
    const gate = new ConcreteEnablementGate(
      [makePassingPrecondition()],
      new AuditLog(),
      60_000,
    );
    await gate.arm();
    expect(() => gate.assertArmed()).not.toThrow();
  });
});

describe("ConcreteEnablementGate — disarm()", () => {
  it("disarm() transitions to DISARMED from ARMED", async () => {
    const gate = new ConcreteEnablementGate([], new AuditLog(), 60_000);
    await gate.arm();
    gate.disarm("user clicked disarm");
    expect(gate.status).toBe("DISARMED");
  });

  it("disarm() with error reason transitions to DISARMED_ON_ERROR", async () => {
    const gate = new ConcreteEnablementGate([], new AuditLog(), 60_000);
    await gate.arm();
    gate.disarm("broker error: connection refused");
    expect(gate.status).toBe("DISARMED_ON_ERROR");
  });

  it("disarm() with drift reason transitions to DISARMED_ON_ERROR", async () => {
    const gate = new ConcreteEnablementGate([], new AuditLog(), 60_000);
    await gate.arm();
    gate.disarm("reconciliation drift at session end");
    expect(gate.status).toBe("DISARMED_ON_ERROR");
  });

  it("disarm() is safe to call when already DISARMED", () => {
    const gate = new ConcreteEnablementGate([], new AuditLog());
    expect(() => gate.disarm("no-op")).not.toThrow();
  });

  it("assertArmed() throws after disarm()", async () => {
    const gate = new ConcreteEnablementGate([], new AuditLog(), 60_000);
    await gate.arm();
    gate.disarm();
    expect(() => gate.assertArmed()).toThrow(GateDisarmedError);
  });
});

describe("ConcreteEnablementGate — auto-disarm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("auto-disarms after autoDisarmAfterMs", async () => {
    const gate = new ConcreteEnablementGate([], new AuditLog(), 1_000);
    await gate.arm();
    expect(gate.status).toBe("ARMED");
    vi.advanceTimersByTime(1_001);
    expect(gate.status).toBe("DISARMED");
  });

  it("does not auto-disarm before the timeout", async () => {
    const gate = new ConcreteEnablementGate([], new AuditLog(), 5_000);
    await gate.arm();
    vi.advanceTimersByTime(4_999);
    expect(gate.status).toBe("ARMED");
  });

  it("disarm() cancels pending auto-disarm timer", async () => {
    const gate = new ConcreteEnablementGate([], new AuditLog(), 1_000);
    await gate.arm();
    gate.disarm("manual");
    vi.advanceTimersByTime(2_000);
    expect(gate.status).toBe("DISARMED");
  });
});

// ─── Lifecycle subscriber ─────────────────────────────────────────────────────

describe("ConcreteEnablementGate — subscribe()", () => {
  it("calls onArmed() after successful arm()", async () => {
    const gate = new ConcreteEnablementGate([], new AuditLog(), 60_000);
    const sub = makeSubscriber();
    gate.subscribe(sub);
    await gate.arm();
    expect(sub.armedCount).toBe(1);
  });

  it("does NOT call onArmed() when arm() fails a precondition", async () => {
    const gate = new ConcreteEnablementGate(
      [makeFailingPrecondition("creds")],
      new AuditLog(),
      60_000,
    );
    const sub = makeSubscriber();
    gate.subscribe(sub);
    await gate.arm();
    expect(sub.armedCount).toBe(0);
  });

  it("calls onDisarmed() when disarm() is called manually", async () => {
    const gate = new ConcreteEnablementGate([], new AuditLog(), 60_000);
    const sub = makeSubscriber();
    gate.subscribe(sub);
    await gate.arm();
    gate.disarm("test");
    expect(sub.disarmedCount).toBeGreaterThanOrEqual(1);
    expect(sub.lastDisarmReason).toBe("test");
  });

  it("calls onDisarmed() on auto-disarm", async () => {
    vi.useFakeTimers();
    const gate = new ConcreteEnablementGate([], new AuditLog(), 500);
    const sub = makeSubscriber();
    gate.subscribe(sub);
    await gate.arm();
    vi.advanceTimersByTime(600);
    expect(sub.disarmedCount).toBeGreaterThanOrEqual(1);
    expect(sub.lastDisarmReason).toContain("elapsed");
    vi.useRealTimers();
  });

  it("notifies all subscribers (multiple subscribers)", async () => {
    const gate = new ConcreteEnablementGate([], new AuditLog(), 60_000);
    const sub1 = makeSubscriber();
    const sub2 = makeSubscriber();
    gate.subscribe(sub1);
    gate.subscribe(sub2);
    await gate.arm();
    expect(sub1.armedCount).toBe(1);
    expect(sub2.armedCount).toBe(1);
    gate.disarm("test");
    expect(sub1.disarmedCount).toBeGreaterThanOrEqual(1);
    expect(sub2.disarmedCount).toBeGreaterThanOrEqual(1);
  });

  it("a throwing subscriber does not prevent other subscribers from being notified", async () => {
    const gate = new ConcreteEnablementGate([], new AuditLog(), 60_000);
    const throwingSub: GateLifecycleSubscriber = {
      onArmed() { throw new Error("subscriber exploded"); },
      onDisarmed() { throw new Error("subscriber exploded"); },
    };
    const goodSub = makeSubscriber();
    gate.subscribe(throwingSub);
    gate.subscribe(goodSub);
    await expect(gate.arm()).resolves.toBe(true); // gate.arm() should not throw
    expect(goodSub.armedCount).toBe(1);
  });

  it("subscribe() may be called before arm() with no effect until arm()", async () => {
    const gate = new ConcreteEnablementGate([], new AuditLog(), 60_000);
    const sub = makeSubscriber();
    gate.subscribe(sub);
    expect(sub.armedCount).toBe(0); // not armed yet
    await gate.arm();
    expect(sub.armedCount).toBe(1);
  });
});

// ─── CredentialStore integration via subscribe() ─────────────────────────────

describe("ConcreteEnablementGate — CredentialStore lifecycle wiring", () => {
  it("credential store's get() works after arm() when wired via subscribe()", async () => {
    const { ConcreteCredentialStore } = await import(
      "../src/engine/governance/credentialStore.ts"
    );
    const store = new ConcreteCredentialStore();
    const gate = new ConcreteEnablementGate([], new AuditLog(), 60_000);
    gate.subscribe(store);

    // Set credentials before arming (precondition-first flow)
    store.set({ apiKey: "KEY", apiSecret: "SECRET", baseUrl: "https://paper-api.alpaca.markets" });

    // get() must throw before arming
    expect(() => store.get()).toThrow(GateDisarmedError);

    await gate.arm();

    // get() must succeed after arming
    expect(() => store.get()).not.toThrow();
    expect(store.get().apiKey).toBe("KEY");
  });

  it("credential store's get() throws and credentials cleared after disarm()", async () => {
    const { ConcreteCredentialStore } = await import(
      "../src/engine/governance/credentialStore.ts"
    );
    const store = new ConcreteCredentialStore();
    const gate = new ConcreteEnablementGate([], new AuditLog(), 60_000);
    gate.subscribe(store);

    store.set({ apiKey: "KEY", apiSecret: "SECRET", baseUrl: "https://paper-api.alpaca.markets" });
    await gate.arm();
    expect(store.get().apiKey).toBe("KEY"); // works while armed

    gate.disarm("test");
    expect(() => store.get()).toThrow(GateDisarmedError); // wiped on disarm
    expect(store.hasCredentials).toBe(false);            // credentials cleared
  });

  it("auto-disarm wipes credentials via subscriber", async () => {
    vi.useFakeTimers();
    const { ConcreteCredentialStore } = await import(
      "../src/engine/governance/credentialStore.ts"
    );
    const store = new ConcreteCredentialStore();
    const gate = new ConcreteEnablementGate([], new AuditLog(), 500);
    gate.subscribe(store);

    store.set({ apiKey: "KEY", apiSecret: "SECRET", baseUrl: "https://paper-api.alpaca.markets" });
    await gate.arm();
    expect(store.hasCredentials).toBe(true);

    vi.advanceTimersByTime(600);

    expect(gate.status).toBe("DISARMED");
    expect(store.hasCredentials).toBe(false);
    vi.useRealTimers();
  });
});

// ─── Audit log integration ────────────────────────────────────────────────────

describe("ConcreteEnablementGate — audit log integration", () => {
  it("records GATE_ARMED and PRECONDITION_RESULT entries on successful arm()", async () => {
    const log = new AuditLog();
    const gate = new ConcreteEnablementGate([makePassingPrecondition("creds")], log, 60_000);
    await gate.arm();

    const armed = log.filter("GATE_ARMED");
    const precond = log.filter("PRECONDITION_RESULT");
    expect(armed.length).toBeGreaterThanOrEqual(1);
    expect(precond).toHaveLength(1);
    expect(precond[0]!.payload["check"]).toBe("creds");
    expect(precond[0]!.payload["passed"]).toBe(true);
  });

  it("records GATE_DISARMED on failed arm()", async () => {
    const log = new AuditLog();
    const gate = new ConcreteEnablementGate([makeFailingPrecondition("account")], log, 60_000);
    await gate.arm();

    const disarmed = log.filter("GATE_DISARMED");
    expect(disarmed.length).toBeGreaterThanOrEqual(1);
    expect(disarmed[0]!.payload["failedCheck"]).toBe("account");
  });

  it("records GATE_DISARMED when disarm() is called manually", async () => {
    const log = new AuditLog();
    const gate = new ConcreteEnablementGate([], log, 60_000);
    await gate.arm();
    gate.disarm("user disarmed");

    const disarmed = log.filter("GATE_DISARMED");
    expect(disarmed.length).toBeGreaterThanOrEqual(1);
  });
});
