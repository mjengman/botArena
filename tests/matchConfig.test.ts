import { describe, it, expect } from "vitest";
import { validateMatchConfig, defaultMatchConfig } from "../src/app/matchConfig.ts";
import type { MatchConfig } from "../src/app/matchConfig.ts";

function valid(overrides: Partial<MatchConfig> = {}): MatchConfig {
  return { ...defaultMatchConfig(), ...overrides };
}

describe("validateMatchConfig", () => {
  it("accepts default config with no errors", () => {
    expect(validateMatchConfig(defaultMatchConfig())).toHaveLength(0);
  });

  it("rejects startingCash of 0", () => {
    const errors = validateMatchConfig(valid({ startingCash: 0 }));
    expect(errors.some((e) => e.field === "startingCash")).toBe(true);
  });

  it("rejects negative startingCash", () => {
    const errors = validateMatchConfig(valid({ startingCash: -100 }));
    expect(errors.some((e) => e.field === "startingCash")).toBe(true);
  });

  it("rejects NaN startingCash", () => {
    const errors = validateMatchConfig(valid({ startingCash: NaN }));
    expect(errors.some((e) => e.field === "startingCash")).toBe(true);
  });

  it("rejects negative feeBps", () => {
    const errors = validateMatchConfig(valid({ feeBps: -1 }));
    expect(errors.some((e) => e.field === "feeBps")).toBe(true);
  });

  it("accepts feeBps of 0", () => {
    expect(validateMatchConfig(valid({ feeBps: 0 }))).toHaveLength(0);
  });

  it("rejects negative slippageBps", () => {
    const errors = validateMatchConfig(valid({ slippageBps: -1 }));
    expect(errors.some((e) => e.field === "slippageBps")).toBe(true);
  });

  it("rejects non-integer seed", () => {
    const errors = validateMatchConfig(valid({ seed: 1.5 }));
    expect(errors.some((e) => e.field === "seed")).toBe(true);
  });

  it("rejects negative seed", () => {
    const errors = validateMatchConfig(valid({ seed: -1 }));
    expect(errors.some((e) => e.field === "seed")).toBe(true);
  });

  it("rejects NaN seed", () => {
    const errors = validateMatchConfig(valid({ seed: NaN }));
    expect(errors.some((e) => e.field === "seed")).toBe(true);
  });

  it("rejects empty activeBotIds", () => {
    const errors = validateMatchConfig(valid({ activeBotIds: [] }));
    expect(errors.some((e) => e.field === "activeBotIds")).toBe(true);
  });

  it("rejects dataStartIdx >= dataEndIdx", () => {
    const errors = validateMatchConfig(valid({ dataStartIdx: 100, dataEndIdx: 100 }));
    expect(errors.some((e) => e.field === "dateRange")).toBe(true);
  });

  it("rejects dataStartIdx out of bounds", () => {
    const errors = validateMatchConfig(valid({ dataStartIdx: -1 }));
    expect(errors.some((e) => e.field === "dateRange")).toBe(true);
  });

  it("rejects dataEndIdx past dataset length", () => {
    const errors = validateMatchConfig(valid({ dataStartIdx: 0, dataEndIdx: 9999 }));
    expect(errors.some((e) => e.field === "dateRange")).toBe(true);
  });

  it("returns multiple errors for multiple invalid fields", () => {
    const errors = validateMatchConfig(
      valid({ startingCash: 0, feeBps: -1, activeBotIds: [] }),
    );
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
});
