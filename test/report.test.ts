import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countVerdicts, generateReport } from "../src/report.js";
import type { RunState, TranscriptEntry } from "../src/types.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vda-report-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function entry(partial: Partial<TranscriptEntry> & { role: TranscriptEntry["role"]; text: string }): TranscriptEntry {
  return { ts: new Date().toISOString(), seq: partial.seq ?? 0, ...partial };
}

describe("countVerdicts", () => {
  it("counts verdict lines at line starts only", () => {
    const entries: TranscriptEntry[] = [
      entry({
        role: "stakeholder",
        seq: 3,
        text: [
          "Let me push back here.",
          "OBJECTION: the invariant about payouts is not falsifiable as written",
          "Also, discussing what CONFIRMED: means inline should not count.",
          "GATE-REFUSED: boundary map omits the Stripe webhook seam",
        ].join("\n"),
      }),
      entry({
        role: "stakeholder",
        seq: 5,
        text: "CONFIRMED: phase 3 — checked: boundary-map.md, all 12 boundaries",
      }),
      // Designer messages never contribute verdicts.
      entry({ role: "designer", seq: 4, text: "OBJECTION: not mine to raise" }),
    ];
    const v = countVerdicts(entries);
    expect(v.objections).toBe(1);
    expect(v.refusals).toBe(1);
    expect(v.confirmations).toBe(1);
    expect(v.lines).toHaveLength(3);
  });
});

describe("generateReport", () => {
  function writeRun(opts: {
    stakeholderTexts: string[];
    withRatification: boolean;
    exchanges?: number;
    extraEntries?: TranscriptEntry[];
    audit?: RunState["audit"];
  }): void {
    const workspace = join(dir, "workspace");
    mkdirSync(join(workspace, "validation-design"), { recursive: true });
    writeFileSync(join(workspace, "validation-design", "invariants.md"), "# inv");
    if (opts.withRatification) {
      writeFileSync(join(workspace, "validation-design", "ratification-package.md"), "# ratify");
    }
    writeFileSync(join(workspace, "rambling.txt"), "thoughts");
    const state: RunState = {
      runId: "r1",
      fixture: "lumen-webapp",
      workspace,
      status: "completed",
      exchanges: opts.exchanges ?? 2,
      seq: 4,
      ...(opts.audit ? { audit: opts.audit } : {}),
      startedAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T01:00:00.000Z",
      config: {
        fixture: "lumen-webapp",
        runId: "r1",
        designerModel: "claude-fable-5",
        stakeholderModel: "gpt-5.6-sol",
        readerModel: "claude-sonnet-5",
        claudeAuth: "subscription",
        codexAuth: "chatgpt",
        maxExchanges: 60,
        maxWallMinutes: 300,
        designerMaxTurns: 250,
      },
    };
    writeFileSync(join(dir, "state.json"), JSON.stringify(state));
    const lines = [
      ...opts.stakeholderTexts.map((t, i) => entry({ role: "stakeholder", seq: i, text: t })),
      ...(opts.extraEntries ?? []),
    ].map((e) => JSON.stringify(e));
    writeFileSync(join(dir, "transcript.jsonl"), `${lines.join("\n")}\n`);
  }

  it("reports counts, artifacts, and ratification pointer", () => {
    writeRun({
      stakeholderTexts: ["OBJECTION: too vague", "CONFIRMED: gate 1 — checked: invariants.md"],
      withRatification: true,
    });
    const md = generateReport(dir);
    expect(md).toContain("| OBJECTION | 1 |");
    expect(md).toContain("| CONFIRMED | 1 |");
    expect(md).toContain("invariants.md");
    expect(md).toContain("human-amplified");
    expect(md).not.toContain("RUBBER-STAMP SUSPECT");
    expect(md).not.toContain("⚠ missing");
  });

  it("flags a rubber-stamp-suspect run and a missing ratification package", () => {
    writeRun({
      stakeholderTexts: ["CONFIRMED: everything — checked: nothing really", "CONFIRMED: sure"],
      withRatification: false,
    });
    const md = generateReport(dir);
    expect(md).toContain("RUBBER-STAMP SUSPECT");
    expect(md).toContain("⚠ missing");
  });

  it("points completed audit-less runs at vda audit", () => {
    writeRun({ stakeholderTexts: ["OBJECTION: x"], withRatification: true });
    const md = generateReport(dir);
    expect(md).toContain("## Audit");
    expect(md).toContain("vda audit r1");
  });

  it("renders the audit section from state bookkeeping: tiers, dispositions, verdict", () => {
    writeRun({
      stakeholderTexts: ["OBJECTION: x", "CONFIRMED: dispositions — checked"],
      withRatification: true,
      extraEntries: [
        entry({
          role: "auditor",
          seq: 2,
          text: "AUD-101 (blocking) — invariants.md — no falsifier\nAUD-102 (minor) — style",
          note: "audit-iteration-1",
        }),
        entry({
          role: "auditor",
          seq: 3,
          text: "AUD-101: VERIFIED — fixed",
          note: "audit-iteration-2",
        }),
      ],
      audit: {
        iteration: 2,
        phase: "done",
        windowExchanges: 2,
        findings: [
          { id: "AUD-101", tier: "blocking", title: "invariants.md — no falsifier", iteration: 1 },
          { id: "AUD-102", tier: "minor", title: "style", iteration: 1 },
        ],
        dispositions: {
          "AUD-101": { kind: "fixed", note: "rewrote oracle" },
          "AUD-102": { kind: "deferred", note: "cosmetic" },
        },
        verdict: "clean",
      },
    });
    const md = generateReport(dir);
    expect(md).toContain("**Audit verdict:** **clean**");
    expect(md).toContain("**Iterations run:** 2");
    expect(md).toContain("| 1 (seq 2) | 1 | 0 | 1 |");
    expect(md).toContain("`AUD-101` (blocking, iter 1)");
    expect(md).toContain("**fixed**: rewrote oracle");
    expect(md).not.toContain("AUDIT-SUSPECT");
  });

  it("renders a post-hoc audit (no state bookkeeping) from the transcript alone", () => {
    writeRun({
      stakeholderTexts: ["OBJECTION: x"],
      withRatification: true,
      extraEntries: [
        entry({
          role: "auditor",
          seq: 2,
          text: "AUD-101 (significant) — case-catalog.md — CF-003 traces to a retired invariant",
          note: "audit-iteration-1 (post-hoc)",
        }),
      ],
    });
    const md = generateReport(dir);
    expect(md).toContain("post-hoc audit only");
    expect(md).toContain("`AUD-101` (significant, iter 1)");
    expect(md).toContain("**no disposition**");
  });

  it("flags AUDIT-SUSPECT when a zero-finding first pass meets a 30+ exchange design", () => {
    writeRun({
      stakeholderTexts: ["OBJECTION: real pushback happened"],
      withRatification: true,
      exchanges: 34,
      extraEntries: [
        entry({
          role: "auditor",
          seq: 2,
          text: "No findings.\n\nWhat I checked: everything.",
          note: "audit-iteration-1",
        }),
      ],
    });
    const md = generateReport(dir);
    expect(md).toContain("AUDIT-SUSPECT");
  });
});
