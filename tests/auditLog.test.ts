import { describe, it, expect } from "vitest";
import { AuditLog } from "../src/engine/governance/auditLog.ts";

describe("AuditLog", () => {
  it("starts empty", () => {
    const log = new AuditLog();
    expect(log.size).toBe(0);
    expect(log.getEntries()).toHaveLength(0);
  });

  it("records an entry with monotonically increasing seq", () => {
    const log = new AuditLog();
    const e0 = log.record("SESSION_START", "started");
    const e1 = log.record("ORDER_INTENT", "intent");
    expect(e0.seq).toBe(0);
    expect(e1.seq).toBe(1);
  });

  it("records correct type and message", () => {
    const log = new AuditLog();
    const entry = log.record("GATE_ARMED", "gate is armed", { detail: "test" });
    expect(entry.type).toBe("GATE_ARMED");
    expect(entry.message).toBe("gate is armed");
    expect(entry.payload).toEqual({ detail: "test" });
  });

  it("sets a timestamp close to Date.now()", () => {
    const before = Date.now();
    const log = new AuditLog();
    const entry = log.record("SESSION_START", "now");
    const after = Date.now();
    expect(entry.timestamp).toBeGreaterThanOrEqual(before);
    expect(entry.timestamp).toBeLessThanOrEqual(after);
  });

  it("entries are frozen (immutable)", () => {
    const log = new AuditLog();
    const entry = log.record("GATE_ARMED", "armed");
    expect(() => {
      // @ts-expect-error intentional mutation attempt
      entry.message = "mutated";
    }).toThrow();
  });

  it("getEntries returns a copy — mutations don't affect the log", () => {
    const log = new AuditLog();
    log.record("SESSION_START", "start");
    const entries = log.getEntries();
    // @ts-expect-error coerce to mutable for test
    (entries as AuditEntry[]).push({ seq: 99, timestamp: 0, type: "ERROR", message: "injected", payload: {} });
    expect(log.size).toBe(1);
  });

  it("filter returns only matching types", () => {
    const log = new AuditLog();
    log.record("SESSION_START", "start");
    log.record("ORDER_INTENT", "intent");
    log.record("ORDER_FILL", "fill");
    log.record("ORDER_INTENT", "intent 2");

    const intents = log.filter("ORDER_INTENT");
    expect(intents).toHaveLength(2);
    expect(intents.every((e) => e.type === "ORDER_INTENT")).toBe(true);
  });

  it("filter with multiple types returns all matching", () => {
    const log = new AuditLog();
    log.record("GATE_ARMED", "armed");
    log.record("GATE_DISARMED", "disarmed");
    log.record("ORDER_SUBMITTED", "submitted");

    const gateEvents = log.filter("GATE_ARMED", "GATE_DISARMED");
    expect(gateEvents).toHaveLength(2);
  });

  it("export returns all entries serialisable as JSON", () => {
    const log = new AuditLog();
    log.record("SESSION_START", "start", { symbol: "ARENA", botCount: 3 });
    log.record("ORDER_INTENT", "buy", { side: "buy", symbol: "ARENA" });

    const exported = log.export();
    const json = JSON.stringify(exported);
    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].type).toBe("SESSION_START");
    expect(parsed[1].type).toBe("ORDER_INTENT");
  });

  it("size tracks entry count", () => {
    const log = new AuditLog();
    expect(log.size).toBe(0);
    log.record("SESSION_START", "start");
    expect(log.size).toBe(1);
    log.record("SESSION_END", "end");
    expect(log.size).toBe(2);
  });

  it("default payload is empty object when not provided", () => {
    const log = new AuditLog();
    const entry = log.record("ERROR", "something went wrong");
    expect(entry.payload).toEqual({});
  });
});
