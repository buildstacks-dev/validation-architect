import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeManifest, type CaseCatalogManifest } from "../src/catalog.js";
import {
  auditedCoreFingerprint,
  corpusFingerprint,
  runCampaign,
  type OrchestratorDeps,
} from "../src/orchestrator.js";
import { ownerDocsMessage } from "../src/prompts.js";
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

/** Seed structurally valid owner-facing docs. */
function writeOwnerDocs(root: string = dir): void {
  mkdirSync(join(root, "validation-design"), { recursive: true });
  writeFileSync(
    join(root, "validation-design", "owner-briefing.md"),
    [
      "# Owner briefing",
      "",
      "This non-normative briefing is not a second source of truth; ratified artifacts win.",
      "",
      "## What this product can break",
      "Stakes.",
      "## The promises",
      "Promises.",
      "## The seams",
      "Seams.",
      "## What we deliberately will NOT test, and why",
      "Pruned work.",
      "## The decisions on your desk",
      "Decisions.",
      "## What is still unknown",
      "Unknowns.",
      "## What gets built, in what order",
      "Waves.",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "validation-design", "owner-backlog.md"),
    [
      "# Owner backlog",
      "",
      "This is a non-normative living companion, not a second source of truth.",
      "Backlog revision: 1, generated from harness-backlog.md.",
      "",
      "## Wave 0",
      "",
      "### HB-001 — Minimal harness",
      "Implements CF-X01-S.",
      "",
    ].join("\n"),
  );
}

function ensureValidCorpus(root: string = dir): void {
  const design = join(root, "validation-design");
  mkdirSync(design, { recursive: true });
  const catalogPath = join(design, "case-catalog.md");
  if (!existsSync(catalogPath)) {
    writeFileSync(
      catalogPath,
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
  }
  const manifestPath = join(design, "case-catalog.yaml");
  if (!existsSync(manifestPath)) {
    const manifest: CaseCatalogManifest = {
      schema: "validation-architect/case-catalog/v1",
      families: [
        {
          id: "CF-X01-S",
          section: "Journey matrix",
          status: "implementable",
          layers: "2",
          oracle: "state",
          risk: "STD",
          ticket: "HB-001",
          wave: "0",
        },
      ],
      tickets: [
        {
          id: "HB-001",
          name: "Minimal harness",
          wave: "0",
          status: "pending",
          families: ["CF-X01-S"],
        },
      ],
    };
    writeFileSync(manifestPath, serializeManifest(manifest));
  }
  const backlogPath = join(design, "harness-backlog.md");
  if (!existsSync(backlogPath)) {
    writeFileSync(
      backlogPath,
      [
        "# Harness backlog",
        "",
        "Revision: 1",
        "",
        "## Wave 0",
        "",
        "**HB-001 — Minimal harness.** Implements CF-X01-S.",
        "",
      ].join("\n"),
    );
  }
  if (!existsSync(join(design, "owner-briefing.md")) || !existsSync(join(design, "owner-backlog.md"))) {
    writeOwnerDocs(root);
  }
}

/**
 * Designer script step for the owner-docs phase: write the two files when
 * asked, then emit CAMPAIGN-COMPLETE. Used by every test that walks the
 * audit loop all the way to completion.
 */
function ownerDocsStep(): ScriptStep {
  return (incoming) => {
    if (!incoming.includes("owner-briefing.md") || !incoming.includes("owner-backlog.md")) {
      return "unexpected — expected the owner-docs instruction\n<<AWAITING-HUMAN>>";
    }
    writeOwnerDocs();
    return "Owner briefing and backlog companion written.\n<<CAMPAIGN-COMPLETE>>";
  };
}

function makeState(
  config: RunConfig,
  opts: { readersRan?: boolean; auditDone?: boolean } = {},
): RunState {
  ensureValidCorpus();
  const state: RunState = {
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
  if (opts.readersRan) state.readerReviewFingerprint = corpusFingerprint(dir);
  if (opts.auditDone && state.audit) state.audit.auditedCoreFingerprint = auditedCoreFingerprint(dir);
  return state;
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
  const designer = new FakeDesigner([
    ...designerScript,
    (incoming) =>
      incoming.includes("mandatory post-audit review")
        ? "Final owner-corpus review accepted without edits.\n<<CAMPAIGN-COMPLETE>>"
        : "unexpected extra designer turn\n<<AWAITING-HUMAN>>",
  ]);
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
        ownerDocsStep(),
      ],
      ["ack", "CONFIRMED: audit dispositions — checked: invariants.md rev 6"],
      [
        REPORT_1,
        "## Disposition verification\nAUD-101: VERIFIED — the oracle now names an observable\nAUD-102: VERIFIED — deferral recorded in the package\n\n## What I checked\nDispositions and neighbors.",
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
        ownerDocsStep(),
      ],
      ["ack", "CONFIRMED: dispute upheld — the auditor relitigated ratified decision D-004"],
      [
        "AUD-101 (blocking) — invariants.md — oracle contradicts D-004\n\n## What I checked\nD-004 and the oracle.",
        "## Disposition verification\nAUD-101: VERIFIED — dispute and arbitration honestly recorded\n\n## What I checked\nDisposition record and D-004.",
      ],
    );
    const state = await runCampaign(deps, makeState(makeConfig(), { readersRan: true }), kickoffs);
    expect(state.status).toBe("completed");
    expect(state.audit?.verdict).toBe("clean-with-disputes");
  });

  it("caps the feedback window at 12 exchanges and advances", async () => {
    const designerScript: ScriptStep[] = ["done\n<<CAMPAIGN-COMPLETE>>"];
    for (let i = 0; i < 13; i++) designerScript.push(`window chatter ${i}\n<<AWAITING-HUMAN>>`);
    designerScript.push(
      "DISPOSITION: AUD-102 = fixed — verified\nOwner, confirm AUD-102; AUD-101 remains verifier-reopened.\n<<AWAITING-HUMAN>>",
    );
    designerScript.push("Stakeholder confirmation received.\n<<CAMPAIGN-COMPLETE>>");
    designerScript.push("Audit section written.\n<<CAMPAIGN-COMPLETE>>");
    designerScript.push(ownerDocsStep());
    const stakeholderScript: ScriptStep[] = ["ack"];
    for (let i = 0; i < 12; i++) stakeholderScript.push(`still discussing ${i}`);
    stakeholderScript.push("CONFIRMED: AUD-102 disposition checked; AUD-101 remains reopened.");

    const { deps, auditor } = makeDeps(designerScript, stakeholderScript, [
      REPORT_1,
      "## Disposition verification\nAUD-101: NOT-FIXED — nothing changed\nAUD-102: VERIFIED — fine\n\n## What I checked\nBoth dispositions and neighbors.",
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
        "DISPOSITION: AUD-201 = deferred — blocking regression remains\nOwner, confirm AUD-201; AUD-101 remains verifier-reopened.\n<<AWAITING-HUMAN>>",
        "Round-2 disposition confirmed.\n<<CAMPAIGN-COMPLETE>>",
        (incoming) =>
          incoming.includes('verdict "reservations"')
            ? "Audit section written, reservations recorded.\n<<CAMPAIGN-COMPLETE>>"
            : "wrong verdict\n<<AWAITING-HUMAN>>",
        ownerDocsStep(),
      ],
      [
        "ack",
        "CONFIRMED: AUD-101 and AUD-102 dispositions — checked",
        "CONFIRMED: AUD-201 deferral — blocking regression remains visible",
      ],
      [
        "AUD-101 (blocking) — invariants.md — oracle cannot fail\nAUD-102 (significant) — boundary-map.md — missing failure mode\n\n## What I checked\nInvariants and boundaries.",
        [
          "## Disposition verification",
          "AUD-101: NOT-FIXED — the patch renames the oracle without making it falsifiable",
          "AUD-102: VERIFIED — failure mode added",
          "AUD-201 (blocking) — case-catalog.md — the AUD-101 patch broke CF-003's trace",
          "AUD-202 (minor) — style drift in the patched section",
          "",
          "## What I checked",
          "Both dispositions and all changed neighbors.",
        ].join("\n"),
      ],
    );
    const state = await runCampaign(deps, makeState(makeConfig(), { readersRan: true }), kickoffs);

    expect(state.status).toBe("completed");
    expect(state.audit?.verdict).toBe("reservations");
    // Terminal NOT-FIXED is authoritative; designer prose cannot relabel it.
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
        ownerDocsStep(),
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
        ownerDocsStep(),
      ],
      [],
      ["## Disposition verification\nAUD-101: VERIFIED — fix landed\n\n## What I checked\nAUD-101 and its neighbors."],
    );
    const state = makeState(makeConfig(), { readersRan: true });
    state.audit = {
      iteration: 1,
      phase: "window",
      windowExchanges: 3,
      findings: [{ id: "AUD-101", tier: "blocking", title: "oracle cannot fail", iteration: 1 }],
      dispositions: {
        "AUD-101": {
          kind: "fixed",
          note: "rewrote oracle",
          confirmed: true,
          confirmationNote: "CONFIRMED: round-1 disposition",
        },
      },
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

  it("persists the return-to-auditor continuation before a corpus-repair detour", async () => {
    const first = makeDeps([], []);
    const state = makeState(makeConfig(), { readersRan: true });
    state.pending = { to: "auditor", iteration: 1 };
    unlinkSync(join(dir, "validation-design", "case-catalog.yaml"));

    let crashSnapshot: RunState | undefined;
    first.deps.saveState = (current) => {
      crashSnapshot = structuredClone(current);
      throw new Error("simulated crash at the corpus-repair save point");
    };

    await expect(runCampaign(first.deps, state, kickoffs)).rejects.toThrow("simulated crash");
    expect(crashSnapshot?.pending?.to).toBe("designer");
    expect(crashSnapshot?.audit?.resumeIteration).toBe(1);

    const resumed = crashSnapshot as RunState;
    const second = makeDeps(
      [
        (incoming) => {
          expect(incoming).toContain("case-catalog.yaml is missing");
          ensureValidCorpus();
          return "Catalog restored; re-run fresh readers.\n<<REQUEST-READER-TEST>>";
        },
        (incoming) =>
          incoming.includes("Reader: operator")
            ? "Repaired corpus reviewed without further edits.\n<<CAMPAIGN-COMPLETE>>"
            : "reader reports missing\n<<AWAITING-HUMAN>>",
        (incoming) =>
          incoming.includes('verdict "clean"')
            ? "Audit section written.\n<<CAMPAIGN-COMPLETE>>"
            : "unexpected package prompt\n<<AWAITING-HUMAN>>",
        ownerDocsStep(),
      ],
      [],
      ["No findings.\n\n## What I checked\nThe complete repaired corpus."],
    );
    const final = await runCampaign(second.deps, resumed, kickoffs);

    expect(final.status).toBe("completed");
    expect(second.auditor.prompts).toHaveLength(1);
    expect(final.audit?.iteration).toBe(1);
    expect(final.audit?.verdict).toBe("clean");
  });

  it("freezes dispositions after the feedback window so the verdict cannot go stale", async () => {
    const { deps } = makeDeps(
      [
        "DISPOSITION: AUD-101 = deferred — relabeled after verification\n<<CAMPAIGN-COMPLETE>>",
        ownerDocsStep(),
      ],
      [],
    );
    const state = makeState(makeConfig(), { readersRan: true });
    state.audit = {
      iteration: 2,
      phase: "package",
      windowExchanges: 0,
      findings: [{ id: "AUD-101", tier: "blocking", title: "oracle could not fail", iteration: 1 }],
      dispositions: {
        "AUD-101": {
          kind: "fixed",
          note: "verifier accepted the corrected oracle",
          confirmed: true,
          confirmationNote: "CONFIRMED: fixed disposition",
        },
      },
      verdict: "clean",
      auditedCoreFingerprint: auditedCoreFingerprint(dir),
    };
    state.pending = { to: "designer", text: "write the ratification package Audit section" };

    const final = await runCampaign(deps, state, kickoffs);

    expect(final.status).toBe("completed");
    expect(final.audit?.verdict).toBe("clean");
    expect(final.audit?.dispositions["AUD-101"]?.kind).toBe("fixed");
    const notes = readTranscript(dir).filter((entry) => entry.role === "orchestrator");
    expect(notes.some((entry) => entry.note?.includes("outside the audit feedback window"))).toBe(true);
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
        ownerDocsStep(),
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
      auditedCoreFingerprint: auditedCoreFingerprint(dir),
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
      auditedCoreFingerprint: auditedCoreFingerprint(dir),
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
        ownerDocsStep(),
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
      auditedCoreFingerprint: auditedCoreFingerprint(dir),
    };
    state.pending = { to: "designer", text: "[Environment: write the Audit section]" };

    const final = await runCampaign(deps, state, kickoffs);
    expect(final.status).toBe("aborted");
    expect(fixed).toBe(true);
    const notes = readTranscript(dir).filter((e) => e.role === "orchestrator");
    expect(notes.some((n) => n.note?.includes("deterministic corpus gate rejected"))).toBe(true);
    expect(notes.some((n) => n.note?.includes("post-audit core mutation rejected"))).toBe(true);
  });

  it("gates completion on owner-briefing.md and owner-backlog.md after the Audit section", async () => {
    const { deps } = makeDeps(
      [
        "Audit section written.\n<<CAMPAIGN-COMPLETE>>",
        // First attempt: claim done without writing the files → rejected.
        () => {
          unlinkSync(join(dir, "validation-design", "owner-briefing.md"));
          unlinkSync(join(dir, "validation-design", "owner-backlog.md"));
          return "I removed the owner docs but I'm done anyway.\n<<CAMPAIGN-COMPLETE>>";
        },
        ownerDocsStep(),
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
      auditedCoreFingerprint: auditedCoreFingerprint(dir),
    };
    state.pending = { to: "designer", text: "[Environment: write the Audit section]" };

    const final = await runCampaign(deps, state, kickoffs);
    expect(final.status).toBe("completed");
    expect(final.audit?.phase).toBe("done");
    const notes = readTranscript(dir).filter((e) => e.role === "orchestrator");
    expect(notes.some((n) => n.note?.includes("requesting owner-briefing.md"))).toBe(true);
    expect(notes.some((n) => n.note?.includes("owner-briefing.md is missing"))).toBe(true);
  });

  it("resumes mid-owner-docs phase from a pending designer message", async () => {
    const { deps, stakeholder, readers } = makeDeps([ownerDocsStep()], []);
    const state = makeState(makeConfig(), { readersRan: true });
    state.audit = {
      iteration: 2,
      phase: "owner-docs",
      windowExchanges: 0,
      findings: [],
      dispositions: {},
      verdict: "clean",
      auditedCoreFingerprint: auditedCoreFingerprint(dir),
    };
    state.pending = { to: "designer", text: ownerDocsMessage() };
    state.exchanges = 25;

    const final = await runCampaign(deps, state, kickoffs);
    expect(final.status).toBe("completed");
    expect(stakeholder.received).toHaveLength(0);
    expect(readers.ran).toHaveLength(3); // mandatory post-audit fresh-reader pass
    expect(existsSync(join(dir, "validation-design", "owner-briefing.md"))).toBe(true);
    expect(existsSync(join(dir, "validation-design", "owner-backlog.md"))).toBe(true);
  });

  it("retries a blank iteration-1 response and accepts only the complete report", async () => {
    const { deps, auditor, auditFiles } = makeDeps(
      ["Audit section written.\n<<CAMPAIGN-COMPLETE>>", ownerDocsStep()],
      [],
      ["", "No findings.\n\n## What I checked\nEvery required artifact and rubric axis."],
    );
    const state = makeState(makeConfig(), { readersRan: true });
    state.audit = {
      iteration: 0,
      phase: "window",
      windowExchanges: 0,
      findings: [],
      dispositions: {},
    };
    state.pending = { to: "auditor", iteration: 1 };

    const final = await runCampaign(deps, state, kickoffs);
    expect(final.status).toBe("completed");
    expect(auditor.prompts).toHaveLength(2);
    expect(auditor.prompts[1]).toContain("previous response was rejected");
    expect(auditFiles.get("audit-report-1.md")).toContain("No findings");
    expect(auditFiles.has("audit-report-1-rejected-1.md")).toBe(true);
  });

  it("requires iteration-2 coverage for every round-1 finding before mutating audit state", async () => {
    const incomplete = [
      "## Disposition verification",
      "AUD-101: VERIFIED — landed",
      "",
      "## What I checked",
      "AUD-101 only.",
    ].join("\n");
    const complete = [
      "## Disposition verification",
      "AUD-101: VERIFIED — landed",
      "AUD-102: VERIFIED — landed",
      "",
      "## What I checked",
      "Both findings and changed neighbors.",
    ].join("\n");
    const { deps, auditor } = makeDeps(
      [
        "Verification accepted.\n<<CAMPAIGN-COMPLETE>>",
        "Audit section written.\n<<CAMPAIGN-COMPLETE>>",
        ownerDocsStep(),
      ],
      [],
      [incomplete, complete],
    );
    const state = makeState(makeConfig(), { readersRan: true });
    state.audit = {
      iteration: 1,
      phase: "window",
      windowExchanges: 0,
      findings: [
        { id: "AUD-101", tier: "blocking", title: "one", iteration: 1 },
        { id: "AUD-102", tier: "significant", title: "two", iteration: 1 },
      ],
      dispositions: {
        "AUD-101": { kind: "fixed", note: "landed", confirmed: true },
        "AUD-102": { kind: "fixed", note: "landed", confirmed: true },
      },
    };
    state.pending = { to: "auditor", iteration: 2 };

    const final = await runCampaign(deps, state, kickoffs);
    expect(final.status).toBe("completed");
    expect(auditor.prompts).toHaveLength(2);
    expect(auditor.prompts[1]).toContain("missing round-1 verification verdicts: AUD-102");
    expect(final.audit?.findings).toHaveLength(2); // rejected report admitted nothing
  });

  it("will not close a disputed disposition until stakeholder arbitration is persisted", async () => {
    const { deps } = makeDeps(
      [
        "Trying to close directly.\n<<CAMPAIGN-COMPLETE>>",
        "DISPOSITION: AUD-101 = disputed — D-004 controls\nOwner, arbitrate this disposition.\n<<AWAITING-HUMAN>>",
        "Arbitration received.\n<<CAMPAIGN-COMPLETE>>",
        "Verification accepted.\n<<CAMPAIGN-COMPLETE>>",
        "Audit section written.\n<<CAMPAIGN-COMPLETE>>",
        ownerDocsStep(),
      ],
      ["CONFIRMED: AUD-101 dispute upheld — decision D-004 is controlling product truth."],
      [
        "## Disposition verification\nAUD-101: VERIFIED — dispute and arbitration recorded\n\n## What I checked\nD-004 and the disposition record.",
      ],
    );
    const state = makeState(makeConfig(), { readersRan: true });
    state.audit = {
      iteration: 1,
      phase: "window",
      windowExchanges: 0,
      findings: [{ id: "AUD-101", tier: "blocking", title: "conflicts with D-004", iteration: 1 }],
      dispositions: { "AUD-101": { kind: "disputed", note: "D-004 controls" } },
    };
    state.pending = { to: "designer", text: "audit report" };

    const final = await runCampaign(deps, state, kickoffs);
    expect(final.status).toBe("completed");
    expect(final.audit?.dispositions["AUD-101"]?.arbitrated).toBe(true);
    expect(final.audit?.dispositions["AUD-101"]?.arbitrationNote).toContain("CONFIRMED:");
    const notes = readTranscript(dir).filter((entry) => entry.role === "orchestrator");
    expect(notes.some((entry) => entry.note?.includes("unarbitrated disputes [AUD-101]"))).toBe(true);
  });

  it("requires stakeholder confirmation for fixed and deferred dispositions before closing", async () => {
    const { deps } = makeDeps(
      [
        "Both dispositions are recorded, so close directly.\n<<CAMPAIGN-COMPLETE>>",
        "DISPOSITION: AUD-101 = fixed — landed\nDISPOSITION: AUD-102 = deferred — human follow-up\nOwner, confirm these dispositions.\n<<AWAITING-HUMAN>>",
        "Owner confirmation received.\n<<CAMPAIGN-COMPLETE>>",
        "Audit section written.\n<<CAMPAIGN-COMPLETE>>",
        ownerDocsStep(),
      ],
      ["CONFIRMED: AUD-101 fixed and AUD-102 deferred — checked both rationales."],
    );
    const state = makeState(makeConfig(), { readersRan: true });
    state.audit = {
      iteration: 2,
      phase: "window",
      windowExchanges: 0,
      findings: [
        { id: "AUD-101", tier: "blocking", title: "fixed claim", iteration: 1 },
        { id: "AUD-102", tier: "minor", title: "deferred cleanup", iteration: 1 },
      ],
      dispositions: {
        "AUD-101": { kind: "fixed", note: "landed" },
        "AUD-102": { kind: "deferred", note: "human follow-up" },
      },
      auditedCoreFingerprint: auditedCoreFingerprint(dir),
    };
    state.pending = { to: "designer", text: "audit window" };

    const final = await runCampaign(deps, state, kickoffs);
    expect(final.status).toBe("completed");
    expect(final.audit?.dispositions["AUD-101"]?.confirmed).toBe(true);
    expect(final.audit?.dispositions["AUD-102"]?.confirmed).toBe(true);
    const notes = readTranscript(dir).filter((entry) => entry.role === "orchestrator");
    expect(notes.some((entry) => entry.note?.includes("unconfirmed dispositions [AUD-101, AUD-102]"))).toBe(
      true,
    );
  });

  it("keeps a terminal NOT-FIXED reopening authoritative over a forged fixed disposition", async () => {
    const { deps } = makeDeps(
      [
        "DISPOSITION: AUD-101 = fixed — trust me, no bytes changed\n<<CAMPAIGN-COMPLETE>>",
        (incoming) =>
          incoming.includes('verdict "reservations"')
            ? "Audit section records the reopening.\n<<CAMPAIGN-COMPLETE>>"
            : "wrong verdict\n<<AWAITING-HUMAN>>",
        ownerDocsStep(),
      ],
      [],
    );
    const state = makeState(makeConfig(), { readersRan: true });
    state.audit = {
      iteration: 2,
      phase: "window",
      windowExchanges: 0,
      findings: [{ id: "AUD-101", tier: "blocking", title: "fix did not land", iteration: 1 }],
      dispositions: { "AUD-101": { kind: "reopened", note: "NOT-FIXED: unchanged oracle" } },
      auditedCoreFingerprint: auditedCoreFingerprint(dir),
    };
    state.pending = { to: "designer", text: "terminal verification" };

    const final = await runCampaign(deps, state, kickoffs);
    expect(final.status).toBe("completed");
    expect(final.audit?.verdict).toBe("reservations");
    expect(final.audit?.dispositions["AUD-101"]?.kind).toBe("reopened");
    const notes = readTranscript(dir).filter((entry) => entry.role === "orchestrator");
    expect(notes.some((entry) => entry.note?.includes("ignored designer disposition fixed"))).toBe(true);
  });

  it("fails the deterministic corpus gate before readers when either catalog is absent", async () => {
    const { deps, readers } = makeDeps(
      [
        "Run readers.\n<<REQUEST-READER-TEST>>",
        (incoming) => {
          expect(incoming).toContain("case-catalog.md is missing");
          ensureValidCorpus();
          return "Both catalogs restored.\n<<REQUEST-READER-TEST>>";
        },
        "Reviewed corpus unchanged.\n<<CAMPAIGN-COMPLETE>>",
        "Audit section written.\n<<CAMPAIGN-COMPLETE>>",
        ownerDocsStep(),
      ],
      ["ack"],
      ["No findings.\n\n## What I checked\nEvery artifact and rubric axis."],
    );
    const state = makeState(makeConfig());
    unlinkSync(join(dir, "validation-design", "case-catalog.md"));
    unlinkSync(join(dir, "validation-design", "case-catalog.yaml"));

    const final = await runCampaign(deps, state, kickoffs);
    expect(final.status).toBe("completed");
    expect(readers.ran).toHaveLength(6); // one accepted pre-audit pass + mandatory final pass
  });

  it("forces a second reader pass when the designer edits the reviewed pre-audit corpus", async () => {
    const { deps, readers, auditor } = makeDeps(
      [
        "Run readers.\n<<REQUEST-READER-TEST>>",
        () => {
          writeFileSync(join(dir, "validation-design", "system-map.md"), "# System map\n\nSubstantive new seam.\n");
          return "Folded reader feedback.\n<<CAMPAIGN-COMPLETE>>";
        },
        "Re-run readers.\n<<REQUEST-READER-TEST>>",
        "Current corpus reviewed with no edits.\n<<CAMPAIGN-COMPLETE>>",
        "Audit section written.\n<<CAMPAIGN-COMPLETE>>",
        ownerDocsStep(),
      ],
      ["ack"],
      ["No findings.\n\n## What I checked\nEvery corpus artifact, including system-map.md."],
    );
    const final = await runCampaign(deps, makeState(makeConfig()), kickoffs);
    expect(final.status).toBe("completed");
    expect(auditor.prompts).toHaveLength(1);
    expect(readers.ran).toHaveLength(9); // two pre-audit passes + mandatory final pass
  });

  it("re-runs final readers if any owner-corpus file changes after their report", async () => {
    const { deps, readers } = makeDeps(
      [
        ownerDocsStep(),
        () => {
          writeFileSync(
            join(dir, "validation-design", "owner-briefing.md"),
            `${readFileSync(join(dir, "validation-design", "owner-briefing.md"), "utf8")}\nClarified consequence.\n`,
          );
          return "Applied final-reader clarification.\n<<CAMPAIGN-COMPLETE>>";
        },
        "Second final review accepted without edits.\n<<CAMPAIGN-COMPLETE>>",
      ],
      [],
    );
    const state = makeState(makeConfig(), { readersRan: true });
    state.audit = {
      iteration: 2,
      phase: "owner-docs",
      windowExchanges: 0,
      findings: [],
      dispositions: {},
      verdict: "clean",
      auditedCoreFingerprint: auditedCoreFingerprint(dir),
    };
    state.pending = { to: "designer", text: ownerDocsMessage() };

    const final = await runCampaign(deps, state, kickoffs);
    expect(final.status).toBe("completed");
    expect(readers.ran).toHaveLength(6);
  });

  it("uses independent gate counters and ignores the legacy shared counter", async () => {
    const { deps } = makeDeps(
      [
        "Complete.\n<<CAMPAIGN-COMPLETE>>",
        (incoming) => {
          expect(incoming).toContain("case-catalog.yaml is missing");
          ensureValidCorpus();
          return "Catalog restored.\n<<REQUEST-READER-TEST>>";
        },
        "Reviewed and unchanged.\n<<CAMPAIGN-COMPLETE>>",
        "Audit section written.\n<<CAMPAIGN-COMPLETE>>",
        ownerDocsStep(),
      ],
      [],
      ["No findings.\n\n## What I checked\nEvery artifact and rubric axis."],
    );
    const state = makeState(makeConfig(), { readersRan: true });
    state.pending = { to: "designer", text: "complete now" };
    state.completionRejections = 999;
    state.gateRejections = { "reader-test": 2, "audit-section": 2, "owner-docs": 2 };
    unlinkSync(join(dir, "validation-design", "case-catalog.yaml"));

    const final = await runCampaign(deps, state, kickoffs);
    expect(final.status).toBe("completed");
    expect(final.statusReason).toBeUndefined();
  });

  it("rejects matching Markdown+YAML catalog edits made after the terminal audit", async () => {
    const mutateBothCatalogs = () => {
      writeFileSync(
        join(dir, "validation-design", "case-catalog.md"),
        "# Case catalog\n\n## 1. Journey matrix\n\n| Cell | Case family | Layer | Oracle | Risk |\n|---|---|---|---|---|\n| CF-X02-S | changed after audit | 2 | state | STD |\n",
      );
      const manifest: CaseCatalogManifest = {
        schema: "validation-architect/case-catalog/v1",
        families: [
          {
            id: "CF-X02-S",
            section: "Journey matrix",
            status: "implementable",
            layers: "2",
            oracle: "state",
            risk: "STD",
          },
        ],
        tickets: [],
      };
      writeFileSync(join(dir, "validation-design", "case-catalog.yaml"), serializeManifest(manifest));
    };
    const { deps, readers } = makeDeps(
      [
        () => {
          mutateBothCatalogs();
          return "Catalog revision complete.\n<<CAMPAIGN-COMPLETE>>";
        },
        "The catalogs agree, so complete.\n<<CAMPAIGN-COMPLETE>>",
        "Still complete.\n<<CAMPAIGN-COMPLETE>>",
      ],
      [],
    );
    const state = makeState(makeConfig(), { readersRan: true });
    state.audit = {
      iteration: 2,
      phase: "owner-docs",
      windowExchanges: 0,
      findings: [],
      dispositions: {},
      verdict: "clean",
      auditedCoreFingerprint: auditedCoreFingerprint(dir),
    };
    state.pending = { to: "designer", text: ownerDocsMessage() };

    const final = await runCampaign(deps, state, kickoffs);
    expect(final.status).toBe("aborted");
    expect(final.statusReason).toContain("frozen core corpus");
    expect(final.pending?.to).toBe("designer");
    expect(readers.ran).toHaveLength(0);
  });

  it("preserves the auditor pending message and resets only its gate budget across abort/resume", async () => {
    const first = makeDeps([], [], ["", "still not a report", "progress only"]);
    const state = makeState(makeConfig(), { readersRan: true });
    state.audit = {
      iteration: 0,
      phase: "window",
      windowExchanges: 0,
      findings: [],
      dispositions: {},
    };
    state.pending = { to: "auditor", iteration: 1 };

    const aborted = await runCampaign(first.deps, state, kickoffs);
    expect(aborted.status).toBe("aborted");
    expect(aborted.pending).toEqual({ to: "auditor", iteration: 1 });
    expect(aborted.gateRejections?.["audit-report"]).toBe(0);

    aborted.status = "running";
    aborted.statusReason = undefined;
    const resumed = makeDeps(
      ["Audit section written.\n<<CAMPAIGN-COMPLETE>>", ownerDocsStep()],
      [],
      ["No findings.\n\n## What I checked\nEvery artifact and rubric axis."],
    );
    const final = await runCampaign(resumed.deps, aborted, kickoffs);
    expect(final.status).toBe("completed");
    expect(resumed.auditor.prompts[0]).toContain("previous response was rejected");
  });
});

describe("reader-loop convergence rule", () => {
  const ZERO_FINDINGS_AUDIT = ["No findings.\n\n## What I checked\nEvery artifact and rubric axis."];

  const appendResidue = () => {
    const pkg = join(dir, "validation-design", "ratification-package.md");
    const prior = existsSync(pkg) ? readFileSync(pkg, "utf8") : "# Ratification package\n";
    writeFileSync(pkg, `${prior}\n## Reader-round residue\n\n- (minor) terminal-round nit, recorded for the human.\n`);
  };

  it("arms the terminal pass after two ratified rounds and accepts a package-only residue delta", async () => {
    let residueIncoming = "";
    const { deps, readers, saved } = makeDeps(
      [
        "Artifacts ready.\n<<REQUEST-READER-TEST>>",
        "Round 1 dispositioned.\n<<AWAITING-HUMAN>>",
        "Re-running readers.\n<<REQUEST-READER-TEST>>",
        "Round 2 dispositioned.\n<<AWAITING-HUMAN>>",
        "Re-running readers.\n<<REQUEST-READER-TEST>>",
        (incoming) => {
          residueIncoming = incoming;
          appendResidue();
          return "Residue recorded in the package.\n<<CAMPAIGN-COMPLETE>>";
        },
        (incoming) =>
          incoming.includes('verdict "clean"')
            ? "Audit section written.\n<<CAMPAIGN-COMPLETE>>"
            : "did not get the package instruction\n<<AWAITING-HUMAN>>",
        ownerDocsStep(),
      ],
      [
        "ack",
        "CONFIRMED: round 1 — checked invariants.md and the mirrors.",
        "Yes — I confirm the design campaign is complete on the current corpus.",
      ],
      ZERO_FINDINGS_AUDIT,
    );
    const state = await runCampaign(deps, makeState(makeConfig()), kickoffs);

    expect(state.status).toBe("completed");
    expect(state.readerConvergentRounds).toBe(2);
    expect(state.readerResidueMode).toBe(true);
    // The third pre-audit pass carried the terminal record-don't-fix instruction.
    expect(residueIncoming).toContain("terminal reader pass");
    expect(residueIncoming).toContain("Reader-round residue");
    // Three pre-audit passes plus the final owner review, three personas each.
    expect(readers.ran.length).toBe(12);
    // The acceptance is recorded, auditable in the transcript.
    const notes = readTranscript(dir).filter((t) => t.role === "orchestrator");
    expect(notes.some((t) => (t.note ?? "").includes("residue delta"))).toBe(true);
    expect(saved.length).toBeGreaterThan(0);
  });

  it("disarms residue mode and resets the counter when the terminal pass edits beyond the package", async () => {
    let secondPassAfterViolation = "";
    const { deps } = makeDeps(
      [
        "Artifacts ready.\n<<REQUEST-READER-TEST>>",
        "Round 1 dispositioned.\n<<AWAITING-HUMAN>>",
        "Re-running readers.\n<<REQUEST-READER-TEST>>",
        "Round 2 dispositioned.\n<<AWAITING-HUMAN>>",
        "Re-running readers.\n<<REQUEST-READER-TEST>>",
        (incoming) => {
          if (!incoming.includes("terminal reader pass")) return "expected terminal pass\n<<AWAITING-HUMAN>>";
          appendResidue();
          writeFileSync(join(dir, "validation-design", "invariants.md"), "# Invariants\n\nINV-001 amended beyond the package.\n");
          return "Fixed one more thing too.\n<<CAMPAIGN-COMPLETE>>";
        },
        (incoming) =>
          incoming.includes("corpus changed") || incoming.includes("stale")
            ? "Understood; re-running readers.\n<<REQUEST-READER-TEST>>"
            : "expected the re-review requirement\n<<AWAITING-HUMAN>>",
        (incoming) => {
          secondPassAfterViolation = incoming;
          return "No further edits.\n<<CAMPAIGN-COMPLETE>>";
        },
        (incoming) =>
          incoming.includes('verdict "clean"')
            ? "Audit section written.\n<<CAMPAIGN-COMPLETE>>"
            : "did not get the package instruction\n<<AWAITING-HUMAN>>",
        ownerDocsStep(),
      ],
      [
        "ack",
        "CONFIRMED: round 1 — checked invariants.md and the mirrors.",
        "CONFIRMED: round 2 — checked again; complete on the current corpus.",
      ],
      ZERO_FINDINGS_AUDIT,
    );
    const state = await runCampaign(deps, makeState(makeConfig()), kickoffs);

    expect(state.status).toBe("completed");
    // The violated terminal pass returned the campaign to the strict loop.
    expect(state.readerResidueMode).toBeUndefined();
    expect(state.readerConvergentRounds).toBe(0);
    expect(secondPassAfterViolation).not.toContain("terminal reader pass");
  });

  it("resets the convergence counter on GATE-REFUSED", async () => {
    let thirdPass = "";
    const { deps } = makeDeps(
      [
        "Artifacts ready.\n<<REQUEST-READER-TEST>>",
        "Round 1 dispositioned.\n<<AWAITING-HUMAN>>",
        "Re-running readers.\n<<REQUEST-READER-TEST>>",
        "Round 2 dispositioned.\n<<AWAITING-HUMAN>>",
        "Acknowledged the refusal; re-running readers.\n<<REQUEST-READER-TEST>>",
        (incoming) => {
          thirdPass = incoming;
          return "No further edits.\n<<CAMPAIGN-COMPLETE>>";
        },
        (incoming) =>
          incoming.includes('verdict "clean"')
            ? "Audit section written.\n<<CAMPAIGN-COMPLETE>>"
            : "did not get the package instruction\n<<AWAITING-HUMAN>>",
        ownerDocsStep(),
      ],
      [
        "ack",
        "CONFIRMED: round 1 — checked invariants.md and the mirrors.",
        "GATE-REFUSED: the mirrors disagree; round 2 is not acceptable.",
      ],
      ZERO_FINDINGS_AUDIT,
    );
    const state = await runCampaign(deps, makeState(makeConfig()), kickoffs);

    expect(state.status).toBe("completed");
    expect(state.readerConvergentRounds).toBe(0);
    expect(state.readerResidueMode).toBeUndefined();
    expect(thirdPass).not.toContain("terminal reader pass");
  });
});

describe("audit window confirmation formats", () => {
  const REPORT = [
    "AUD-101 (blocking) — invariants.md — INV-003's oracle cannot fail",
    "Evidence: the falsification shape quotes no observable.",
    "AUD-102 (minor) — system-map.md — heading style drifts",
    "",
    "What I checked: invariants.md, boundary-map.md.",
  ].join("\n");

  it("persists a bold em-dash blanket confirmation", async () => {
    const { deps } = makeDeps(
      [
        "All done, gate confirmed.\n<<CAMPAIGN-COMPLETE>>",
        (incoming) =>
          incoming.includes("audit iteration 1")
            ? "DISPOSITION: AUD-101 = fixed — rewrote the oracle\nDISPOSITION: AUD-102 = fixed — style aligned\nOwner, please confirm.\n<<AWAITING-HUMAN>>"
            : "did not get the audit report\n<<AWAITING-HUMAN>>",
        "Confirmed by owner.\n<<CAMPAIGN-COMPLETE>>",
        (incoming) =>
          incoming.includes("audit iteration 2")
            ? "Verification acknowledged.\n<<CAMPAIGN-COMPLETE>>"
            : "did not get the verification report\n<<AWAITING-HUMAN>>",
        (incoming) =>
          incoming.includes('verdict "clean"')
            ? "Audit section written.\n<<CAMPAIGN-COMPLETE>>"
            : "did not get the package instruction\n<<AWAITING-HUMAN>>",
        ownerDocsStep(),
      ],
      ["ack", "**CONFIRMED — audit window closed.** Both dispositions verified against the corpus."],
      [
        REPORT,
        "## Disposition verification\nAUD-101: VERIFIED — observable named\nAUD-102: VERIFIED — aligned\n\n## What I checked\nDispositions.",
      ],
    );
    const state = await runCampaign(deps, makeState(makeConfig(), { readersRan: true }), kickoffs);
    expect(state.status).toBe("completed");
    expect(state.audit?.dispositions["AUD-101"]?.confirmed).toBe(true);
    expect(state.audit?.dispositions["AUD-102"]?.confirmed).toBe(true);
  });

  it("persists per-finding table-row confirmations inside an otherwise refusing message", async () => {
    const { deps } = makeDeps(
      [
        "All done, gate confirmed.\n<<CAMPAIGN-COMPLETE>>",
        (incoming) =>
          incoming.includes("audit iteration 1")
            ? "DISPOSITION: AUD-101 = fixed — rewrote the oracle\nDISPOSITION: AUD-102 = fixed — style aligned\nOwner, please confirm.\n<<AWAITING-HUMAN>>"
            : "did not get the audit report\n<<AWAITING-HUMAN>>",
        "AUD-101 corrected as you ruled.\nDISPOSITION: AUD-101 = fixed — corrected per ruling\n<<AWAITING-HUMAN>>",
        "Both now confirmed.\n<<CAMPAIGN-COMPLETE>>",
        (incoming) =>
          incoming.includes("audit iteration 2")
            ? "Verification acknowledged.\n<<CAMPAIGN-COMPLETE>>"
            : "did not get the verification report\n<<AWAITING-HUMAN>>",
        (incoming) =>
          incoming.includes('verdict "clean"')
            ? "Audit section written.\n<<CAMPAIGN-COMPLETE>>"
            : "did not get the package instruction\n<<AWAITING-HUMAN>>",
        ownerDocsStep(),
      ],
      [
        "ack",
        "Overall ruling: **GATE-REFUSED**.\n\n| Finding | Ruling |\n|---|---|\n| AUD-101 | **OBJECTION** — oracle still vague |\n| AUD-102 | **CONFIRMED** |",
        "| Finding | Ruling |\n|---|---|\n| **AUD-101** | **CONFIRMED** |",
      ],
      [
        REPORT,
        "## Disposition verification\nAUD-101: VERIFIED — observable named\nAUD-102: VERIFIED — aligned\n\n## What I checked\nDispositions.",
      ],
    );
    const state = await runCampaign(deps, makeState(makeConfig(), { readersRan: true }), kickoffs);
    expect(state.status).toBe("completed");
    expect(state.audit?.dispositions["AUD-101"]?.confirmed).toBe(true);
    expect(state.audit?.dispositions["AUD-102"]?.confirmed).toBe(true);
  });
});
