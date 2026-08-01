import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeManifest, type CaseCatalogManifest } from "../src/catalog.js";
import { runCampaign, type OrchestratorDeps } from "../src/orchestrator.js";
import { RambleWatcher } from "../src/ramble.js";
import { Transcript, readTranscript } from "../src/transcript.js";
import type { AuditState, RunConfig, RunState } from "../src/types.js";
import { FakeAuditor, FakeDesigner, FakeReaders, FakeStakeholder, type ScriptStep } from "./fakes.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vda-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    fixture: "fixture-x",
    runId: "run-x",
    designerModel: "m1",
    stakeholderModel: "m2",
    readerModel: "m3",
    claudeAuth: "subscription",
    codexAuth: "chatgpt",
    maxExchanges: 10,
    maxWallMinutes: 60,
    designerMaxTurns: 50,
    ...overrides,
  };
}

/**
 * Tests exercising flow that predates (or sidesteps) the audit stage pre-set
 * a completed audit, exactly as readersRan is pre-set — the gate itself is
 * never weakened.
 */
function doneAudit(): AuditState {
  return {
    iteration: 2,
    phase: "done",
    windowExchanges: 0,
    findings: [],
    dispositions: {},
    verdict: "clean",
  };
}

function makeState(
  config: RunConfig,
  opts: { readersRan?: boolean; auditDone?: boolean } = {},
): RunState {
  return {
    ...(opts.readersRan !== undefined ? { readersRan: opts.readersRan } : {}),
    ...(opts.auditDone ? { audit: doneAudit() } : {}),
    runId: config.runId,
    fixture: config.fixture,
    workspace: dir,
    status: "running",
    exchanges: 0,
    seq: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config,
  };
}

function makeDeps(
  designerScript: ScriptStep[],
  stakeholderScript: ScriptStep[],
  auditorScript: ScriptStep[] = [],
  opts: { auditSectionPresent?: () => boolean } = {},
): {
  deps: OrchestratorDeps;
  designer: FakeDesigner;
  stakeholder: FakeStakeholder;
  readers: FakeReaders;
  auditor: FakeAuditor;
  auditFiles: Map<string, string>;
  saved: RunState[];
} {
  const designer = new FakeDesigner(designerScript);
  const stakeholder = new FakeStakeholder(stakeholderScript);
  const readers = new FakeReaders();
  const auditor = new FakeAuditor(auditorScript);
  const auditFiles = new Map<string, string>();
  const saved: RunState[] = [];
  const deps: OrchestratorDeps = {
    designer,
    stakeholder,
    readers,
    auditor,
    transcript: new Transcript(dir),
    ramble: new RambleWatcher(join(dir, "rambling.txt")),
    saveState: (s) => saved.push(structuredClone(s)),
    saveAuditFile: (name, content) => auditFiles.set(name, content),
    auditSectionPresent: opts.auditSectionPresent ?? (() => true),
    log: () => {},
    retryDelayMs: 1,
  };
  return { deps, designer, stakeholder, readers, auditor, auditFiles, saved };
}

const kickoffs = { designer: "DESIGNER-KICKOFF", stakeholder: "STAKEHOLDER-KICKOFF" };

describe("runCampaign", () => {
  it("primes the stakeholder, loops, and completes on the marker", async () => {
    const { deps, designer, stakeholder } = makeDeps(
      [
        "Phase 0 proposal\n<<AWAITING-HUMAN>>",
        "Thanks. Done and ratified.\n<<CAMPAIGN-COMPLETE>>",
      ],
      ["Acknowledged, I read docs and rambling.", "CONFIRMED: phase 0 — checked: module map"],
    );
    const state = await runCampaign(deps, makeState(makeConfig(), { readersRan: true, auditDone: true }), kickoffs);

    expect(state.status).toBe("completed");
    expect(state.exchanges).toBe(1);
    // Priming went to the stakeholder first, then the designer kickoff.
    expect(stakeholder.received[0]).toBe("STAKEHOLDER-KICKOFF");
    expect(designer.received[0]).toBe("DESIGNER-KICKOFF");
    // Marker was stripped before reaching the stakeholder.
    expect(stakeholder.received[1]).toBe("Phase 0 proposal");
    // Stakeholder's reply was relayed to the designer verbatim.
    expect(designer.received[1]).toBe("CONFIRMED: phase 0 — checked: module map");
    const entries = readTranscript(dir);
    expect(entries.map((e) => e.role)).toEqual(["stakeholder", "designer", "stakeholder", "designer"]);
  });

  it("runs the three readers on REQUEST-READER-TEST without counting an exchange", async () => {
    const { deps, designer, readers } = makeDeps(
      [
        "Artifacts done.\n<<REQUEST-READER-TEST>>",
        (incoming) =>
          incoming.includes("Reader: operator") && incoming.includes("Reader: coding-agent")
            ? "Folded findings.\n<<CAMPAIGN-COMPLETE>>"
            : "did not receive reader reports\n<<AWAITING-HUMAN>>",
      ],
      ["ack"],
    );
    const state = await runCampaign(deps, makeState(makeConfig(), { auditDone: true }), kickoffs);

    expect(state.status).toBe("completed");
    expect(state.exchanges).toBe(0);
    expect(readers.ran.sort()).toEqual(["coding-agent", "new-engineer", "operator"]);
    expect(designer.received).toHaveLength(2);
    const entries = readTranscript(dir);
    expect(entries.filter((e) => e.role.startsWith("reader:"))).toHaveLength(3);
  });

  it("rejects a premature CAMPAIGN-COMPLETE until the reader test has run", async () => {
    const { deps, readers } = makeDeps(
      [
        "done early!\n<<CAMPAIGN-COMPLETE>>",
        (incoming) =>
          incoming.includes("CAMPAIGN-COMPLETE rejected")
            ? "fine, readers then\n<<REQUEST-READER-TEST>>"
            : "unexpected\n<<AWAITING-HUMAN>>",
        "folded findings, final gate confirmed earlier\n<<CAMPAIGN-COMPLETE>>",
      ],
      ["ack"],
    );
    const state = await runCampaign(deps, makeState(makeConfig(), { auditDone: true }), kickoffs);
    expect(state.status).toBe("completed");
    expect(state.readersRan).toBe(true);
    expect(readers.ran).toHaveLength(3);
    const notes = readTranscript(dir).filter((e) => e.role === "orchestrator");
    expect(notes.some((n) => n.note?.includes("CAMPAIGN-COMPLETE rejected"))).toBe(true);
  });

  it("aborts when the designer refuses the reader test repeatedly", async () => {
    const { deps } = makeDeps(
      [
        "done!\n<<CAMPAIGN-COMPLETE>>",
        "still done!\n<<CAMPAIGN-COMPLETE>>",
        "no readers needed!\n<<CAMPAIGN-COMPLETE>>",
      ],
      ["ack"],
    );
    const state = await runCampaign(deps, makeState(makeConfig()), kickoffs);
    expect(state.status).toBe("aborted");
    expect(state.statusReason).toContain("refused the reader test");
  });

  it("aborts at the exchange cap", async () => {
    const { deps } = makeDeps(
      ["q1\n<<AWAITING-HUMAN>>", "q2\n<<AWAITING-HUMAN>>", "q3\n<<AWAITING-HUMAN>>"],
      ["ack", "a1", "a2"],
    );
    const state = await runCampaign(deps, makeState(makeConfig({ maxExchanges: 2 })), kickoffs);
    expect(state.status).toBe("aborted");
    expect(state.statusReason).toContain("exchange cap");
    expect(state.exchanges).toBe(2);
    // The un-relayed stakeholder reply is preserved for resume.
    expect(state.pending?.to).toBe("designer");
  });

  it("aborts when the wall clock is exceeded", async () => {
    const { deps } = makeDeps(["never-sent"], ["ack"]);
    let calls = 0;
    deps.now = () => {
      calls++;
      return Date.now() + (calls > 1 ? 10 * 60 * 60 * 1000 : 0);
    };
    const state = await runCampaign(deps, makeState(makeConfig({ maxWallMinutes: 1 })), kickoffs);
    expect(state.status).toBe("aborted");
    expect(state.statusReason).toContain("wall clock");
  });

  it("notes missing markers but still routes to the stakeholder", async () => {
    const { deps, stakeholder } = makeDeps(
      ["no marker here at all", "bye\n<<CAMPAIGN-COMPLETE>>"],
      ["ack", "still answering"],
    );
    const state = await runCampaign(deps, makeState(makeConfig(), { readersRan: true, auditDone: true }), kickoffs);
    expect(state.status).toBe("completed");
    expect(stakeholder.received[1]).toBe("no marker here at all");
    const notes = readTranscript(dir).filter((e) => e.role === "orchestrator");
    expect(notes.some((n) => n.note?.includes("no protocol marker"))).toBe(true);
  });

  it("prepends a re-read note when rambling.txt changes mid-run", async () => {
    const ramblePath = join(dir, "rambling.txt");
    writeFileSync(ramblePath, "initial thoughts");
    const { deps, stakeholder } = makeDeps(
      [
        () => {
          // Simulate the human appending mid-run, between designer turn and routing.
          writeFileSync(ramblePath, "initial thoughts\nnew idea!");
          utimesSync(ramblePath, new Date(), new Date(Date.now() + 5000));
          return "please think about invariants\n<<AWAITING-HUMAN>>";
        },
        "done\n<<CAMPAIGN-COMPLETE>>",
      ],
      ["ack", "rambled"],
    );
    const state = await runCampaign(deps, makeState(makeConfig(), { readersRan: true, auditDone: true }), kickoffs);
    expect(state.status).toBe("completed");
    expect(stakeholder.received[1]).toContain("rambling.txt has been updated");
    expect(stakeholder.received[1]).toContain("please think about invariants");
  });

  it("retries a failed turn once and succeeds", async () => {
    const { deps } = makeDeps(
      [new Error("transient provider blip"), "recovered\n<<CAMPAIGN-COMPLETE>>"],
      ["ack"],
    );
    const state = await runCampaign(deps, makeState(makeConfig(), { readersRan: true, auditDone: true }), kickoffs);
    expect(state.status).toBe("completed");
  });

  it("resumes from pending state without re-priming the stakeholder", async () => {
    const { deps, stakeholder, designer } = makeDeps(
      ["continuing\n<<CAMPAIGN-COMPLETE>>"],
      [],
    );
    const state = makeState(makeConfig(), { readersRan: true, auditDone: true });
    state.pending = { to: "designer", text: "stakeholder said: CONFIRMED earlier" };
    state.exchanges = 3;
    const final = await runCampaign(deps, state, kickoffs);
    expect(final.status).toBe("completed");
    expect(stakeholder.received).toHaveLength(0); // no priming repeat
    expect(designer.received[0]).toBe("stakeholder said: CONFIRMED earlier");
    expect(final.exchanges).toBe(3);
  });

  // The lumen-full-audit-1 crash: after the reader test the designer did all
  // its folding work in tool calls and returned an EMPTY final message; the
  // orchestrator relayed "" to the stakeholder and the Codex exec died on an
  // empty prompt. The relay must never carry an empty message.
  it("nudges the designer instead of relaying an empty turn to the stakeholder", async () => {
    const { deps, stakeholder, designer } = makeDeps(
      [
        "",
        (incoming) =>
          incoming.includes("no content")
            ? "Here is the real summary.\n<<AWAITING-HUMAN>>"
            : "unexpected\n<<AWAITING-HUMAN>>",
        "done\n<<CAMPAIGN-COMPLETE>>",
      ],
      ["ack", "CONFIRMED: fine — checked artifacts"],
    );
    const state = await runCampaign(deps, makeState(makeConfig(), { readersRan: true, auditDone: true }), kickoffs);
    expect(state.status).toBe("completed");
    // The stakeholder never saw an empty message.
    expect(stakeholder.received.every((m) => m.trim().length > 0)).toBe(true);
    expect(designer.received[1]).toContain("no content");
    expect(state.emptyDesignerTurns).toBe(0); // reset by the recovery turn
    const notes = readTranscript(dir).filter((e) => e.role === "orchestrator");
    expect(notes.some((n) => n.note?.includes("no relayable content"))).toBe(true);
  });

  it("recovers on resume from an already-persisted empty stakeholder-bound message", async () => {
    const { deps, stakeholder } = makeDeps(
      [
        (incoming) =>
          incoming.includes("no content")
            ? "Recovered summary for the owner.\n<<AWAITING-HUMAN>>"
            : "unexpected\n<<AWAITING-HUMAN>>",
        "done\n<<CAMPAIGN-COMPLETE>>",
      ],
      ["CONFIRMED: fine — checked artifacts"],
    );
    const state = makeState(makeConfig(), { readersRan: true, auditDone: true });
    state.pending = { to: "stakeholder", text: "" }; // what the crashed run persisted
    const final = await runCampaign(deps, state, kickoffs);
    expect(final.status).toBe("completed");
    expect(stakeholder.received).toEqual(["Recovered summary for the owner."]);
  });

  it("aborts after repeated empty designer turns instead of looping", async () => {
    const { deps } = makeDeps(["", "", ""], ["ack"]);
    const state = await runCampaign(deps, makeState(makeConfig(), { readersRan: true, auditDone: true }), kickoffs);
    expect(state.status).toBe("aborted");
    expect(state.statusReason).toContain("empty turns");
  });

  it("persists session ids and seq after every turn", async () => {
    const { deps, saved } = makeDeps(
      ["q\n<<AWAITING-HUMAN>>", "done\n<<CAMPAIGN-COMPLETE>>"],
      ["ack", "a"],
    );
    await runCampaign(deps, makeState(makeConfig(), { readersRan: true, auditDone: true }), kickoffs);
    expect(saved.length).toBeGreaterThanOrEqual(4);
    const last = saved[saved.length - 1] as RunState;
    expect(last.designerSessionId).toBe("fake-designer-session");
    expect(last.codexThreadId).toBe("fake-codex-thread");
    expect(last.seq).toBe(4);
  });
});

describe("runCampaign audit stage", () => {
  const REPORT_1 = [
    "AUD-101 (blocking) — invariants.md — INV-003's oracle cannot fail",
    "Evidence: the falsification shape quotes no observable.",
    "AUD-102 (minor) — system-map.md — heading style drifts",
    "",
    "What I checked: invariants.md, boundary-map.md.",
  ].join("\n");

  it("gates CAMPAIGN-COMPLETE through the full two-iteration audit loop", async () => {
    const { deps, auditor, auditFiles } = makeDeps(
      [
        "All done, gate confirmed.\n<<CAMPAIGN-COMPLETE>>",
        (incoming) =>
          incoming.includes("audit iteration 1") && incoming.includes("AUD-101")
            ? "DISPOSITION: AUD-101 = fixed — rewrote the oracle in invariants.md rev 6\nDISPOSITION: AUD-102 = deferred — cosmetic, human's call\nOwner, please confirm.\n<<AWAITING-HUMAN>>"
            : "did not get the audit report\n<<AWAITING-HUMAN>>",
        "Dispositions confirmed by owner.\n<<CAMPAIGN-COMPLETE>>",
        (incoming) =>
          incoming.includes("audit iteration 2")
            ? "Verification acknowledged.\n<<CAMPAIGN-COMPLETE>>"
            : "did not get the verification report\n<<AWAITING-HUMAN>>",
        (incoming) =>
          incoming.includes('verdict "clean"')
            ? "Audit section written to ratification-package.md.\n<<CAMPAIGN-COMPLETE>>"
            : "did not get the package instruction\n<<AWAITING-HUMAN>>",
      ],
      ["ack", "CONFIRMED: audit dispositions — checked: invariants.md rev 6"],
      [
        REPORT_1,
        "AUD-101: VERIFIED — the oracle now names an observable\nAUD-102: VERIFIED — deferral recorded in the package\n\nWhat I checked: dispositions and neighbors.",
      ],
    );
    const state = await runCampaign(deps, makeState(makeConfig(), { readersRan: true }), kickoffs);

    expect(state.status).toBe("completed");
    expect(state.audit?.phase).toBe("done");
    expect(state.audit?.verdict).toBe("clean");
    expect(state.audit?.iteration).toBe(2);
    expect(state.audit?.findings.map((f) => f.id)).toEqual(["AUD-101", "AUD-102"]);
    expect(state.audit?.dispositions["AUD-101"]?.kind).toBe("fixed");
    expect(state.audit?.dispositions["AUD-102"]?.kind).toBe("deferred");
    // Both iterations were fresh auditor calls with the right scoping.
    expect(auditor.prompts).toHaveLength(2);
    expect(auditor.prompts[0]).toContain("design-conformance");
    expect(auditor.prompts[1]).toContain("admissible ONLY at blocking tier");
    // Artifacts persisted to the run dir + corpus.
    expect([...auditFiles.keys()].sort()).toEqual([
      "audit-1-dispositions.md",
      "audit-report-1.md",
      "audit-report-2.md",
    ]);
    expect(auditFiles.get("audit-1-dispositions.md")).toContain("AUD-101");
    expect(auditFiles.get("audit-1-dispositions.md")).toContain("fixed");
    const roles = readTranscript(dir).filter((e) => e.role === "auditor");
    expect(roles).toHaveLength(2);
  });

  it("records a stakeholder-arbitrated dispute as clean-with-disputes", async () => {
    const { deps } = makeDeps(
      [
        "done\n<<CAMPAIGN-COMPLETE>>",
        "DISPOSITION: AUD-101 = disputed — D-004 ratified exactly this oracle shape\nOwner, arbitrate.\n<<AWAITING-HUMAN>>",
        "Owner upheld the dispute.\n<<CAMPAIGN-COMPLETE>>",
        "ack verification\n<<CAMPAIGN-COMPLETE>>",
        (incoming) =>
          incoming.includes('verdict "clean-with-disputes"')
            ? "Audit section written.\n<<CAMPAIGN-COMPLETE>>"
            : "wrong verdict\n<<AWAITING-HUMAN>>",
      ],
      ["ack", "CONFIRMED: dispute upheld — the auditor relitigated ratified decision D-004"],
      [
        "AUD-101 (blocking) — invariants.md — oracle contradicts D-004",
        "AUD-101: VERIFIED — dispute and arbitration honestly recorded",
      ],
    );
    const state = await runCampaign(deps, makeState(makeConfig(), { readersRan: true }), kickoffs);
    expect(state.status).toBe("completed");
    expect(state.audit?.verdict).toBe("clean-with-disputes");
  });

  it("caps the feedback window at 12 exchanges and advances", async () => {
    const designerScript: ScriptStep[] = ["done\n<<CAMPAIGN-COMPLETE>>"];
    for (let i = 0; i < 13; i++) designerScript.push(`window chatter ${i}\n<<AWAITING-HUMAN>>`);
    designerScript.push("ack verification\n<<CAMPAIGN-COMPLETE>>");
    designerScript.push("Audit section written.\n<<CAMPAIGN-COMPLETE>>");
    const stakeholderScript: ScriptStep[] = ["ack"];
    for (let i = 0; i < 12; i++) stakeholderScript.push(`still discussing ${i}`);

    const { deps, auditor } = makeDeps(designerScript, stakeholderScript, [
      REPORT_1,
      "AUD-101: NOT-FIXED — nothing changed\nAUD-102: VERIFIED — fine",
    ]);
    const state = await runCampaign(
      deps,
      makeState(makeConfig({ maxExchanges: 40 }), { readersRan: true }),
      kickoffs,
    );
    expect(state.status).toBe("completed");
    // The cap fired: iteration 2 still ran despite the designer never closing
    // the window, and the un-dispositioned blocking finding exits as
    // reservations — fail-closed, not fail-smooth.
    expect(auditor.prompts).toHaveLength(2);
    expect(state.audit?.verdict).toBe("reservations");
    const notes = readTranscript(dir).filter((e) => e.role === "orchestrator");
    expect(notes.some((n) => n.note?.includes("window cap reached"))).toBe(true);
  });

  it("enforces iteration-2 scope: reopens NOT-FIXED, admits only blocking, exits reservations", async () => {
    const { deps } = makeDeps(
      [
        "done\n<<CAMPAIGN-COMPLETE>>",
        "DISPOSITION: AUD-101 = fixed — patched\nDISPOSITION: AUD-102 = fixed — patched\n<<AWAITING-HUMAN>>",
        "confirmed\n<<CAMPAIGN-COMPLETE>>",
        "nothing more to say\n<<CAMPAIGN-COMPLETE>>",
        (incoming) =>
          incoming.includes('verdict "reservations"')
            ? "Audit section written, reservations recorded.\n<<CAMPAIGN-COMPLETE>>"
            : "wrong verdict\n<<AWAITING-HUMAN>>",
      ],
      ["ack", "CONFIRMED: dispositions — checked"],
      [
        "AUD-101 (blocking) — invariants.md — oracle cannot fail\nAUD-102 (significant) — boundary-map.md — missing failure mode",
        [
          "AUD-101: NOT-FIXED — the patch renames the oracle without making it falsifiable",
          "AUD-102: VERIFIED — failure mode added",
          "AUD-201 (blocking) — case-catalog.md — the AUD-101 patch broke CF-003's trace",
          "AUD-202 (minor) — style drift in the patched section",
        ].join("\n"),
      ],
    );
    const state = await runCampaign(deps, makeState(makeConfig(), { readersRan: true }), kickoffs);

    expect(state.status).toBe("completed");
    expect(state.audit?.verdict).toBe("reservations");
    // NOT-FIXED reopened the round-1 finding over the designer's "fixed".
    expect(state.audit?.dispositions["AUD-101"]?.kind).toBe("reopened");
    // New blocking finding admitted; new minor finding dropped as inadmissible.
    const ids = state.audit?.findings.map((f) => f.id);
    expect(ids).toContain("AUD-201");
    expect(ids).not.toContain("AUD-202");
    const notes = readTranscript(dir).filter((e) => e.role === "orchestrator");
    expect(notes.some((n) => n.note?.includes("inadmissible"))).toBe(true);
  });

  it("skips the window and iteration 2 when the first audit reports zero findings", async () => {
    const { deps, auditor } = makeDeps(
      [
        "done\n<<CAMPAIGN-COMPLETE>>",
        (incoming) =>
          incoming.includes('verdict "clean"')
            ? "Audit section written.\n<<CAMPAIGN-COMPLETE>>"
            : "unexpected\n<<AWAITING-HUMAN>>",
      ],
      ["ack"],
      ["No findings.\n\nWhat I checked: the full corpus against the conformance rubric."],
    );
    const state = await runCampaign(deps, makeState(makeConfig(), { readersRan: true }), kickoffs);
    expect(state.status).toBe("completed");
    expect(state.audit?.verdict).toBe("clean");
    expect(auditor.prompts).toHaveLength(1);
    const notes = readTranscript(dir).filter((e) => e.role === "orchestrator");
    expect(notes.some((n) => n.note?.includes("zero findings"))).toBe(true);
  });

  it("resumes mid-audit-loop from a pending auditor iteration", async () => {
    const { deps, stakeholder, designer, auditor } = makeDeps(
      [
        (incoming) =>
          incoming.includes("audit iteration 2")
            ? "ack verification\n<<CAMPAIGN-COMPLETE>>"
            : "unexpected resume point\n<<AWAITING-HUMAN>>",
        "Audit section written.\n<<CAMPAIGN-COMPLETE>>",
      ],
      [],
      ["AUD-101: VERIFIED — fix landed"],
    );
    const state = makeState(makeConfig(), { readersRan: true });
    state.audit = {
      iteration: 1,
      phase: "window",
      windowExchanges: 3,
      findings: [{ id: "AUD-101", tier: "blocking", title: "oracle cannot fail", iteration: 1 }],
      dispositions: { "AUD-101": { kind: "fixed", note: "rewrote oracle" } },
    };
    state.pending = { to: "auditor", iteration: 2 };
    state.exchanges = 20;

    const final = await runCampaign(deps, state, kickoffs);
    expect(final.status).toBe("completed");
    expect(final.audit?.verdict).toBe("clean");
    expect(auditor.prompts).toHaveLength(1);
    expect(stakeholder.received).toHaveLength(0); // no re-priming
    expect(designer.received[0]).toContain("audit iteration 2");
  });

  it("rejects the final CAMPAIGN-COMPLETE until the ratification package has an Audit section", async () => {
    let present = false;
    const { deps } = makeDeps(
      [
        "Package updated (not really).\n<<CAMPAIGN-COMPLETE>>",
        (incoming) => {
          if (!incoming.includes("no Audit heading") && !incoming.includes('"Audit" heading')) {
            return "unexpected\n<<AWAITING-HUMAN>>";
          }
          present = true;
          return "Actually written now.\n<<CAMPAIGN-COMPLETE>>";
        },
      ],
      [],
      [],
      { auditSectionPresent: () => present },
    );
    const state = makeState(makeConfig(), { readersRan: true });
    state.audit = {
      iteration: 2,
      phase: "package",
      windowExchanges: 0,
      findings: [],
      dispositions: {},
      verdict: "clean",
    };
    state.pending = { to: "designer", text: "[Environment: write the Audit section]" };

    const final = await runCampaign(deps, state, kickoffs);
    expect(final.status).toBe("completed");
    const notes = readTranscript(dir).filter((e) => e.role === "orchestrator");
    expect(notes.some((n) => n.note?.includes("no Audit section"))).toBe(true);
  });

  it("aborts when the designer never writes the Audit section", async () => {
    const { deps } = makeDeps(
      [
        "done\n<<CAMPAIGN-COMPLETE>>",
        "done\n<<CAMPAIGN-COMPLETE>>",
        "done\n<<CAMPAIGN-COMPLETE>>",
      ],
      [],
      [],
      { auditSectionPresent: () => false },
    );
    const state = makeState(makeConfig(), { readersRan: true });
    state.audit = {
      iteration: 2,
      phase: "package",
      windowExchanges: 0,
      findings: [],
      dispositions: {},
      verdict: "clean",
    };
    state.pending = { to: "designer", text: "[Environment: write the Audit section]" };

    const final = await runCampaign(deps, state, kickoffs);
    expect(final.status).toBe("aborted");
    expect(final.statusReason).toContain("Audit section");
  });

  it("rejects CAMPAIGN-COMPLETE when case-catalog.md exists but the manifest disagrees", async () => {
    mkdirSync(join(dir, "validation-design"), { recursive: true });
    writeFileSync(
      join(dir, "validation-design", "case-catalog.md"),
      [
        "# Case catalog",
        "",
        "## 1. Journey matrix",
        "",
        "| Cell | Case family | Layer | Oracle | Risk |",
        "|---|---|---|---|---|",
        "| CF-X01-S | happy path | 2 | state | STD |",
        "",
      ].join("\n"),
    );
    // Manifest invents a different family — agreement must fire.
    const bad: CaseCatalogManifest = {
      schema: "validation-architect/case-catalog/v1",
      families: [{ id: "CF-WRONG", section: "Journey matrix", status: "implementable" }],
      tickets: [],
    };
    writeFileSync(join(dir, "validation-design", "case-catalog.yaml"), serializeManifest(bad));

    let fixed = false;
    const { deps } = makeDeps(
      [
        "Package done.\n<<CAMPAIGN-COMPLETE>>",
        (incoming) => {
          if (!incoming.includes("case-catalog") && !incoming.includes("does not agree")) {
            return "unexpected\n<<AWAITING-HUMAN>>";
          }
          // Repair: rewrite the manifest to match the markdown.
          const good: CaseCatalogManifest = {
            schema: "validation-architect/case-catalog/v1",
            families: [{ id: "CF-X01-S", section: "Journey matrix", status: "implementable", layers: "2", oracle: "state", risk: "STD" }],
            tickets: [],
          };
          writeFileSync(join(dir, "validation-design", "case-catalog.yaml"), serializeManifest(good));
          fixed = true;
          return "Manifest repaired.\n<<CAMPAIGN-COMPLETE>>";
        },
      ],
      [],
      [],
    );
    const state = makeState(makeConfig(), { readersRan: true });
    state.audit = {
      iteration: 2,
      phase: "package",
      windowExchanges: 0,
      findings: [],
      dispositions: {},
      verdict: "clean",
    };
    state.pending = { to: "designer", text: "[Environment: write the Audit section]" };

    const final = await runCampaign(deps, state, kickoffs);
    expect(final.status).toBe("completed");
    expect(fixed).toBe(true);
    const notes = readTranscript(dir).filter((e) => e.role === "orchestrator");
    expect(notes.some((n) => n.note?.includes("catalog agreement"))).toBe(true);
  });
});
