import { describe, expect, it } from "vitest";
import {
  buildRunConfig,
  claudeAuthFlag,
  codexAuthFlag,
  nonNegativeIntegerFlag,
  positiveIntegerFlag,
} from "../src/options.js";

describe("campaign option validation", () => {
  it("accepts finite positive integer caps", () => {
    expect(positiveIntegerFlag("12", "max-exchanges")).toBe(12);
    expect(positiveIntegerFlag(undefined, "wall-minutes", 300)).toBe(300);
    expect(nonNegativeIntegerFlag("0", "stale-days")).toBe(0);
  });

  it.each(["true", "", "NaN", "Infinity", "0", "-1", "1.5"])(
    "rejects an unsafe numeric value %j",
    (raw) => {
      expect(() => positiveIntegerFlag(raw, "wall-minutes")).toThrow(/positive integer/);
    },
  );

  it("rejects unsupported authentication modes", () => {
    expect(() => claudeAuthFlag("apikey")).toThrow(/subscription \| api-key/);
    expect(() => codexAuthFlag("subscription")).toThrow(/chatgpt \| api-key/);
  });

  it("fails configuration before a NaN cap can disable guards", () => {
    const flags = new Map<string, string>([
      ["wall-minutes", "true"],
      ["max-exchanges", "typo"],
    ]);
    expect(() => buildRunConfig("fixture", "run", flags)).toThrow();
  });
});
