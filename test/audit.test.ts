import { describe, expect, it } from "vitest";
import {
  computeVerdict,
  nextPostHocAuditIteration,
  parseDispositions,
  parseFindings,
  parseVerifications,
  renderDispositionRecord,
  validateAuditReport,
} from "../src/audit.js";
import { auditorPrompt } from "../src/prompts.js";
import type { AuditDisposition, AuditState } from "../src/types.js";

function auditWith(
  findings: Array<{ id: string; tier: "blocking" | "significant" | "minor" }>,
  dispositions: Record<string, AuditDisposition>,
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

describe("validateAuditReport", () => {
  it("fails closed on blank/progress/malformed first-pass responses", () => {
    expect(validateAuditReport("", 1).problems).toContain("report is blank");
    expect(validateAuditReport("I am still checking the corpus.", 1).problems).toContain(
      "report has neither parseable findings nor an explicit standalone 'No findings' result",
    );
    expect(
      validateAuditReport("No findings.\n\nI checked everything, trust me.", 1).problems,
    ).toContain('missing a non-empty structured "What I checked" section');
  });

  it("accepts an explicit no-findings result only with a populated structured check section", () => {
    expect(
      validateAuditReport("No findings.\n\n## What I checked\n\nAll corpus artifacts and rubric axes.", 1)
        .problems,
    ).toEqual([]);
  });

  it("rejects finding ids that merely share the iteration prefix", () => {
    const report = [
      "AUD-1001 (blocking) — invariants.md — wrong-width range escape",
      "",
      "## What I checked",
      "invariants.md and policy conformance.",
    ].join("\n");
    expect(validateAuditReport(report, 1).problems).toContain(
      "finding ids outside iteration 1's AUD-1xx range: AUD-1001",
    );
  });

  it("applies first-pass fail-closed rules to post-hoc iterations", () => {
    expect(validateAuditReport("## What I checked\nEverything.", 3).problems).toContain(
      "report has neither parseable findings nor an explicit standalone 'No findings' result",
    );
  });

  it("requires recorded blind source evidence for target first-pass audits", () => {
    const base = "No findings.\n\n## What I checked\nAll corpus artifacts and rubric axes.";
    expect(validateAuditReport(base, 1, [], { requireBlindSource: true }).problems).toEqual([
      "target audit does not record the mandatory Phase 0 blind derivation",
      "target audit does not record any target-source/ evidence",
    ]);
    expect(
      validateAuditReport(
        `${base}\n\n### Phase 0 blind derivation\nWalked ./target-source/src and unblinded against the corpus.`,
        1,
        [],
        { requireBlindSource: true },
      ).problems,
    ).toEqual([]);
  });

  it("requires exactly one iteration-2 verdict for every round-1 finding", () => {
    const missing = validateAuditReport(
      "## Disposition verification\nAUD-101: VERIFIED — landed\n\n## What I checked\nAUD-101 only.",
      2,
      ["AUD-101", "AUD-102"],
    );
    expect(missing.problems).toContain("missing round-1 verification verdicts: AUD-102");

    const complete = validateAuditReport(
      [
        "## Disposition verification",
        "AUD-101: VERIFIED — landed",
        "AUD-102: NOT-FIXED — still open",
        "",
        "## What I checked",
        "Both findings and neighboring artifacts.",
      ].join("\n"),
      2,
      ["AUD-101", "AUD-102"],
    );
    expect(complete.problems).toEqual([]);
  });
});

describe("first-pass audit grounding", () => {
  it("orders blind source derivation before corpus ingestion", () => {
    const prompt = auditorPrompt(1);
    const blind = prompt.indexOf("Before you open, list, or grep anything under ./validation-design/");
    const unblind = prompt.indexOf("Only after recording that blind result may");
    expect(blind).toBeGreaterThan(0);
    expect(unblind).toBeGreaterThan(blind);
    expect(prompt).toContain("./target-source/");
    expect(prompt).toContain("./TARGET-DIFF.md");
    expect(prompt).not.toContain("Begin: read the skill, then the corpus");
  });
});

describe("post-hoc audit numbering", () => {
  it("skips verification range 2 and never reuses iteration 3", () => {
    expect(nextPostHocAuditIteration([])).toBe(1);
    expect(
      nextPostHocAuditIteration([
        { role: "auditor", note: "audit-iteration-1" },
        { role: "auditor", note: "audit-iteration-2" },
      ]),
    ).toBe(3);
    expect(
      nextPostHocAuditIteration([
        { role: "auditor", note: "audit-iteration-1" },
        { role: "auditor", note: "audit-iteration-3 (post-hoc)" },
      ]),
    ).toBe(4);
  });
});

describe("computeVerdict", () => {
  it("is clean when all graded findings are fixed (minors never move it)", () => {
    const audit = auditWith(
      [
        { id: "AUD-101", tier: "blocking" },
        { id: "AUD-102", tier: "minor" },
      ],
      { "AUD-101": { kind: "fixed", note: "", confirmed: true } },
    );
    expect(computeVerdict(audit)).toBe("clean");
  });

  it("is clean-with-disputes on an arbitrated dispute or an open significant", () => {
    expect(
      computeVerdict(
        auditWith([{ id: "AUD-101", tier: "blocking" }], {
          "AUD-101": {
            kind: "disputed",
            note: "D-004",
            confirmed: true,
            confirmationNote: "CONFIRMED: D-004 governs",
            arbitrated: true,
            arbitrationNote: "CONFIRMED: D-004 governs",
          },
        }),
      ),
    ).toBe("clean-with-disputes");
    expect(computeVerdict(auditWith([{ id: "AUD-102", tier: "significant" }], {}))).toBe(
      "clean-with-disputes",
    );
  });

  it("fails closed when a blocking dispute has not been arbitrated", () => {
    expect(
      computeVerdict(
        auditWith([{ id: "AUD-101", tier: "blocking" }], {
          "AUD-101": { kind: "disputed", note: "designer says D-004 governs" },
        }),
      ),
    ).toBe("reservations");
  });

  it("keeps an unarbitrated significant dispute at reservations", () => {
    expect(
      computeVerdict(
        auditWith([{ id: "AUD-102", tier: "significant" }], {
          "AUD-102": { kind: "disputed", note: "designer disagrees" },
        }),
      ),
    ).toBe("reservations");
  });

  it("keeps an unconfirmed fixed disposition at reservations", () => {
    expect(
      computeVerdict(
        auditWith([{ id: "AUD-101", tier: "blocking" }], {
          "AUD-101": { kind: "fixed", note: "designer claims fixed" },
        }),
      ),
    ).toBe("reservations");
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

  it("renders persisted arbitration status and evidence", () => {
    const audit = auditWith([{ id: "AUD-101", tier: "blocking" }], {
      "AUD-101": {
        kind: "disputed",
        note: "D-004",
        arbitrated: true,
        arbitrationNote: "CONFIRMED: decision record governs",
      },
    });
    const md = renderDispositionRecord(audit);
    expect(md).toContain("| confirmed | CONFIRMED: decision record governs |");
  });
});
