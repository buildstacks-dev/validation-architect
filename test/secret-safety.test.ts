import { describe, expect, it } from "vitest";
import {
  containsSecretPattern,
  redactSecretPatterns,
} from "../src/secret-safety.js";

describe("credential token boundaries", () => {
  it("does not reinterpret embedded reviewed prose as a credential", () => {
    for (const value of [
      "risk-review-gated",
      "E1/E2 (risk-review-gated)",
      "prefixsk-abcdefghijklmnop",
      "already authorization=[REDACTED]",
    ]) {
      expect(containsSecretPattern(value), value).toBe(false);
      expect(redactSecretPatterns(value), value).toBe(value);
    }
  });

  it("detects and redacts complete credential-shaped tokens", () => {
    const secret = "sk-abcdefghijklmnop";
    expect(containsSecretPattern(secret)).toBe(true);
    expect(containsSecretPattern(`value=${secret}`)).toBe(true);
    expect(redactSecretPatterns(`value=${secret}`)).toBe("value=[REDACTED]");
    expect(redactSecretPatterns("authorization=private-value"))
      .toBe("authorization=[REDACTED]");
  });
});
