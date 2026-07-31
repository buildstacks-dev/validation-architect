import { describe, expect, it } from "vitest";
import {
  computeVerdict,
  parseDispositions,
  parseFindings,
  parseVerifications,
  renderDispositionRecord,
} from "../src/audit.js";
import type { AuditState } from "../src/types.js";

function auditWith(
  findings: Array<{ id: string; tier: "blocking" | "significant" | "minor" }>,
  dispositions: Record<string, { kind: "fixed" | "disputed" | "deferred" | "reopened"; note: string }>,
): AuditState {
  return {
    iteration: 2,
    phase: "window",
    windowExchanges: 0,
    findings: findings.map((f) => ({ ...f, title: "t", iteration: 1 })),
    dispositions,
  };
}

describe("parseFindings", () => {
  it("parses header lines in md headings, bullets, and bare lines; first mention wins", () => {
    const text = [
      "### AUD-101 (blocking) — invariants.md — INV-003 has no falsifier",
      "Some evidence quoting AUD-101 (blocking) again inline.",
      "- AUD-102 (significant): boundary-map.md misses crash-mid-step",
      "AUD-103 (minor) — style drift",
      "AUD-999 mentioned without a tier is prose, not a finding.",
    ].join("\n");
    const found = parseFindings(text, 1);
    expect(found.map((f) => f.id)).toEqual(["AUD-101", "AUD-102", "AUD-103"]);
    expect(found[0]?.tier).toBe("blocking");
    expect(found[1]?.tier).toBe("significant");
    expect(found[0]?.title).toContain("invariants.md");
    expect(found.every((f) => f.iteration === 1)).toBe(true);
  });

  it("returns empty on a no-findings report", () => {
    expect(parseFindings("No findings.\n\nWhat I checked: everything.", 1)).toEqual([]);
  });
});

describe("parseDispositions", () => {
  it("parses fixed/disputed/deferred lines and ignores prose mentions", () => {
    const text = [
      "I will now record dispositions.",
      "DISPOSITION: AUD-101 = fixed — rewrote the oracle",
      "  DISPOSITION: AUD-102 = disputed: D-004 ratified this",
      "DISPOSITION: AUD-103 = deferred",
      "Note that DISPOSITION lines like `DISPOSITION: AUD-xxx = fixed` are parsed.",
    ].join("\n");
    const ds = parseDispositions(text);
    expect(ds).toHaveLength(3);
    expect(ds[0]).toMatchObject({ id: "AUD-101", kind: "fixed" });
    expect(ds[1]).toMatchObject({ id: "AUD-102", kind: "disputed" });
    expect(ds[2]).toMatchObject({ id: "AUD-103", kind: "deferred", note: "" });
  });
});

describe("parseVerifications", () => {
  it("parses VERIFIED / NOT-FIXED / REGRESSION verdict lines", () => {
    const text = [
      "AUD-101: VERIFIED — fix landed with changelog",
      "- AUD-102: NOT-FIXED — patch renames, does not fix",
      "AUD-103: REGRESSION — broke CF-003",
    ].join("\n");
    const vs = parseVerifications(text);
    expect(vs.map((v) => v.verdict)).toEqual(["VERIFIED", "NOT-FIXED", "REGRESSION"]);
    expect(vs[1]?.id).toBe("AUD-102");
  });
});

describe("computeVerdict", () => {
  it("is clean when all graded findings are fixed (minors never move it)", () => {
    const audit = auditWith(
      [
        { id: "AUD-101", tier: "blocking" },
        { id: "AUD-102", tier: "minor" },
      ],
      { "AUD-101": { kind: "fixed", note: "" } },
    );
    expect(computeVerdict(audit)).toBe("clean");
  });

  it("is clean-with-disputes on an arbitrated dispute or an open significant", () => {
    expect(
      computeVerdict(
        auditWith([{ id: "AUD-101", tier: "blocking" }], {
          "AUD-101": { kind: "disputed", note: "D-004" },
        }),
      ),
    ).toBe("clean-with-disputes");
    expect(computeVerdict(auditWith([{ id: "AUD-102", tier: "significant" }], {}))).toBe(
      "clean-with-disputes",
    );
  });

  it("is reservations when a blocking finding is open, deferred, or reopened", () => {
    expect(computeVerdict(auditWith([{ id: "AUD-101", tier: "blocking" }], {}))).toBe("reservations");
    expect(
      computeVerdict(
        auditWith([{ id: "AUD-101", tier: "blocking" }], {
          "AUD-101": { kind: "deferred", note: "" },
        }),
      ),
    ).toBe("reservations");
    expect(
      computeVerdict(
        auditWith([{ id: "AUD-101", tier: "blocking" }], {
          "AUD-101": { kind: "reopened", note: "NOT-FIXED" },
        }),
      ),
    ).toBe("reservations");
  });
});

describe("renderDispositionRecord", () => {
  it("renders one row per finding with its disposition", () => {
    const audit = auditWith(
      [
        { id: "AUD-101", tier: "blocking" },
        { id: "AUD-102", tier: "minor" },
      ],
      { "AUD-101": { kind: "fixed", note: "rewrote" } },
    );
    const md = renderDispositionRecord(audit);
    expect(md).toContain("| AUD-101 | blocking |");
    expect(md).toContain("fixed");
    expect(md).toContain("| AUD-102 | minor |");
    expect(md).toContain("none");
  });
});
