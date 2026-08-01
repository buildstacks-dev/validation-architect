import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ownerBacklogNames, runTrace } from "../src/trace.js";

const fixtures = resolve(__dirname, "fixtures", "trace");

describe("runTrace — hermetic synthetic trees", () => {
  it("is green on a conforming target (clean path)", () => {
    const r = runTrace(resolve(fixtures, "conforming"));
    expect(r.ok).toBe(true);
    expect(r.reds).toEqual([]);
    expect(r.checks.forward).toEqual([]);
    expect(r.checks.backward).toEqual([]);
    expect(r.checks.statusHonesty).toEqual([]);
    expect(r.checks.agreement).toEqual([]);
    expect(r.specs).toHaveLength(2);
    expect(r.specs.reduce((n, s) => n + s.tests, 0)).toBe(5);
  });

  it("fires backward closure on a seeded orphan-spec citation", () => {
    const r = runTrace(resolve(fixtures, "orphan-spec"));
    expect(r.ok).toBe(false);
    expect(r.checks.backward.some((x) => x.includes("CF-ZZ-999"))).toBe(true);
    expect(r.reds.some((x) => x.startsWith("backward:"))).toBe(true);
  });

  it("fires forward closure on a seeded family-without-spec (and no pending wave)", () => {
    const r = runTrace(resolve(fixtures, "missing-family"));
    expect(r.ok).toBe(false);
    expect(r.checks.forward.some((x) => x.includes("CF-W04-S") && x.includes("no owning ticket"))).toBe(
      true,
    );
  });

  it("fires status honesty (and forward) on a seeded false-LANDED ticket", () => {
    const r = runTrace(resolve(fixtures, "false-landed"));
    expect(r.ok).toBe(false);
    expect(r.checks.statusHonesty.some((x) => x.includes("HB-002") && x.includes("CF-W02"))).toBe(true);
    expect(r.checks.forward.some((x) => x.includes("CF-W02") && x.includes("LANDED"))).toBe(true);
  });

  it("fires the agreement check when the markdown catalog drifts from the manifest", () => {
    const r = runTrace(resolve(fixtures, "manifest-drift"));
    expect(r.ok).toBe(false);
    expect(r.checks.agreement.some((x) => x.includes("CF-W05-S"))).toBe(true);
  });

  it("fails closed when the tests root is missing", () => {
    const r = runTrace(resolve(fixtures, "conforming"), { testsRoot: "no-such-tests" });
    expect(r.ok).toBe(false);
    expect(r.reds.some((x) => x.includes("not found"))).toBe(true);
  });
});

describe("trace report", () => {
  it("reuses owner-backlog.md plain-language ticket names when present", () => {
    const r = runTrace(resolve(fixtures, "conforming"));
    expect(r.report).toContain("Widgets can't be created twice");
    expect(r.report).toMatch(/HB-001.*Widgets can't be created twice/);
    expect(r.report).toContain("Wave 0");
    expect(r.report).toContain("Wave 1");
    expect(r.report).toContain("**Forward closure:** green");
  });

  it("falls back to backlog names (then ids) when owner-backlog.md is absent", () => {
    // The false-landed fixture has no owner-backlog.md; the report must
    // still render, using the ticket's name field from the manifest.
    const r = runTrace(resolve(fixtures, "false-landed"));
    expect(r.report).toContain("Widget boundary double");
    expect(r.report).toContain("**Status honesty:** RED");
  });

  it("ownerBacklogNames parses the companion's HB — name shape", () => {
    const names = ownerBacklogNames(
      "## Wave\n\n### HB-014 — Agents can't grant themselves authority\n\nStory.\n",
    );
    expect(names.get("HB-014")).toBe("Agents can't grant themselves authority");
  });
});
