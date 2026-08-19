import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  buildEnvelope,
  design,
  resume,
  type DesignPorts,
  type DesignRequest,
} from "../src/api/campaign-engine.js";
import {
  structuredHistoryBytes,
  type CampaignCheckpoint,
  type CampaignStorePort,
  type TurnReceipt,
} from "../src/api/campaign-contracts.js";
import { FakeRepositoryPort, InMemoryCampaignStore, ScriptedTurnPort, type ScriptedTurn } from "../src/api/conformance.js";
import { isPublicContractError } from "../src/api/errors.js";
import type { ExecutionIdentity, RepositoryPort, TurnResult } from "../src/api/ports.js";
import { writeValidModel } from "./model-corpus-fixture.js";

/**
 * VA-API-004 conformance with fake ports only: exact profile turn counts,
 * identity/independence refusal, typed failure outcomes without recovery
 * turns, the save-before-turn crash matrix, concurrent resume, version
 * binding, and escalation. No provider, network, filesystem effect, or spend.
 */

const tmp = mkdtempSync(join(tmpdir(), "va-campaign-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const DESIGNER_ID: ExecutionIdentity = { provider: "anthropic", model: "fable", session: "s-designer" };
const STAKEHOLDER_ID: ExecutionIdentity = { provider: "openai", model: "gpt", session: "s-stake" };
const AUDITOR_ID: ExecutionIdentity = { provider: "anthropic", model: "fable", session: "s-audit-1" };
const AUDITOR_2_ID: ExecutionIdentity = { provider: "anthropic", model: "fable", session: "s-audit-2" };

let corpusFilesCache: Array<{ path: string; content: string }> | undefined;
function corpusFiles(): Array<{ path: string; content: string }> {
  if (!corpusFilesCache) {
    const dir = join(tmp, "corpus");
    writeValidModel(dir);
    const walk = (root: string, current = root): string[] =>
      readdirSync(current).flatMap((entry) => {
        const path = join(current, entry);
        return statSync(path).isDirectory() ? walk(root, path) : [relative(root, path)];
      });
    corpusFilesCache = walk(dir).map((path) => ({
      path: path.replaceAll("\\", "/"),
      content: readFileSync(join(dir, path), "utf8"),
    }));
  }
  return corpusFilesCache;
}

const ok = (payload: unknown, identity: ExecutionIdentity, usage = { inputTokens: 5, outputTokens: 7 }): TurnResult => ({
  status: "ok",
  text: JSON.stringify(payload),
  identity,
  usage,
});

const designerComplete = (identity = DESIGNER_ID, extra: Record<string, unknown> = {}): TurnResult =>
  ok({ marker: "CAMPAIGN-COMPLETE", files: corpusFiles(), ...extra }, identity);

const cleanAudit = (identity = AUDITOR_ID): TurnResult => ok({ verdict: "clean", findings: [] }, identity);

function makePorts(
  script: ScriptedTurn[],
  store: CampaignStorePort = new InMemoryCampaignStore(),
  files: Record<string, string> = {},
): DesignPorts & { scripted: ScriptedTurnPort } {
  const scripted = new ScriptedTurnPort(script);
  return {
    repository: new FakeRepositoryPort({ revision: "rev-1", files }),
    turns: scripted,
    store,
    scripted,
  };
}

const request = (runId: string, profile: DesignRequest["profile"], extra: Partial<DesignRequest> = {}): DesignRequest => ({
  runId,
  profile,
  intake: "A small fixture product.",
  ...extra,
  admit: extra.admit ?? ((envelope) => envelope),
});

function watchedRepository(
  readIntake: () => string | null,
  readInstance: () => string | null = () => readIntake() === null ? null : "instance-1",
): RepositoryPort {
  const base = new FakeRepositoryPort({ revision: "rev-1", files: {} });
  return {
    revision: () => base.revision(),
    readFile: (path) => base.readFile(path),
    listFiles: (globs) => base.listFiles(globs),
    changedPaths: (before, after) => base.changedPaths(before, after),
    intakeSnapshot: async () => ({
      sourceId: "fixed:rambling.txt",
      content: readIntake(),
      instanceId: readInstance(),
    }),
  };
}

describe("append-only intake hot reload", () => {
  it("persists an append before constructing the next pending request", async () => {
    let intake: string | null = "base values\n";
    const turns = new ScriptedTurnPort([
      {
        result: (turnRequest) => {
          expect(turnRequest.prompt).toContain("base values");
          intake = "base values\nappended constraint\n";
          return ok({ marker: "CONTINUE", files: [] }, DESIGNER_ID);
        },
      },
      {
        result: (turnRequest) => {
          expect(turnRequest.prompt).toContain("appended constraint");
          return { status: "refused", reason: "stop after reload" };
        },
      },
    ]);
    const store = new InMemoryCampaignStore();
    const watchedRequest = request("run-intake-reload", "C2");
    Reflect.deleteProperty(watchedRequest, "intake");
    const outcome = await design(watchedRequest, {
      repository: watchedRepository(() => intake),
      turns,
      store,
    });
    expect(outcome).toMatchObject({ status: "incomplete", reason: "turn_refused" });
    if (outcome.status === "incomplete") {
      expect(outcome.checkpoint.intakeBase).toBe("base values\n");
      expect(outcome.checkpoint.intake).toBe("base values\nappended constraint\n");
      expect(outcome.checkpoint.intakeSource).toEqual({
        sourceId: "fixed:rambling.txt",
        presentAtKickoff: true,
        instanceId: "instance-1",
      });
    }
  });

  it.each([
    ["truncated", "base values\n", "replacement\n"],
    ["added", null, "added later\n"],
    ["removed", "base values\n", null],
  ] as const)("fails before a second provider turn when intake is %s", async (_label, initial, changed) => {
    let intake: string | null = initial;
    const turns = new ScriptedTurnPort([{
      result: () => {
        intake = changed;
        return ok({ marker: "CONTINUE", files: [] }, DESIGNER_ID);
      },
    }]);
    const watchedRequest = request(`run-intake-${_label}`, "C2");
    Reflect.deleteProperty(watchedRequest, "intake");
    await expect(design(watchedRequest, {
      repository: watchedRepository(() => intake),
      turns,
      store: new InMemoryCampaignStore(),
    })).rejects.toSatisfy((error: unknown) => isPublicContractError(error, "version_mismatch"));
    expect(turns.consumed).toBe(1);
  });

  it("rejects a replaced file instance even when its content preserves the prefix", async () => {
    let intake = "base\n";
    let instance = "instance-1";
    const turns = new ScriptedTurnPort([{
      result: () => {
        intake = "base\nappend-looking bytes\n";
        instance = "instance-2";
        return ok({ marker: "CONTINUE", files: [] }, DESIGNER_ID);
      },
    }]);
    const watchedRequest = request("run-intake-replaced", "C2");
    Reflect.deleteProperty(watchedRequest, "intake");
    await expect(design(watchedRequest, {
      repository: watchedRepository(() => intake, () => instance),
      turns,
      store: new InMemoryCampaignStore(),
    })).rejects.toSatisfy((error: unknown) => isPublicContractError(error, "version_mismatch"));
    expect(turns.consumed).toBe(1);
  });
});

describe("absolute campaign wall deadline", () => {
  afterEach(() => vi.useRealTimers());

  it("gives a new turn only the remaining campaign minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = 1_800_000_000_000;
    vi.setSystemTime(startedAt);
    const inner = new InMemoryCampaignStore();
    const store: CampaignStorePort = {
      load: (runId) => inner.load(runId),
      async save(checkpoint, expectedGeneration) {
        await inner.save(checkpoint, expectedGeneration);
        if (expectedGeneration === 0) {
          vi.setSystemTime(startedAt + checkpoint.envelope.limits.maxWallMs - 60_000);
        }
      },
    };
    const ports = makePorts([
      {
        result: (turnRequest) => {
          expect(turnRequest.limits.maxWallMs).toBe(60_000);
          return designerComplete();
        },
      },
    ], store);

    const outcome = await design(request("run-one-minute", "C0"), ports);
    expect(outcome.status).toBe("complete");
  });

  it.each([
    ["before", -1, "complete"],
    ["exactly at", 0, "limit_exhausted"],
    ["after", 1, "limit_exhausted"],
  ] as const)("accepts or rejects a provider result %s the absolute deadline", async (_label, offset, expected) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = 1_800_100_000_000;
    const campaignWall = 30 * 60_000;
    const deadline = startedAt + campaignWall;
    vi.setSystemTime(startedAt);
    const inner = new InMemoryCampaignStore();
    const store: CampaignStorePort = {
      load: (runId) => inner.load(runId),
      async save(checkpoint, expectedGeneration) {
        await inner.save(checkpoint, expectedGeneration);
        if (expectedGeneration === 0) vi.setSystemTime(deadline - 10);
      },
    };
    const ports = makePorts([{
      result: () => {
        vi.setSystemTime(deadline + offset);
        return designerComplete();
      },
    }], store);

    const outcome = await design(request(`run-deadline-${offset}`, "C0"), ports);
    if (expected === "complete") {
      expect(outcome.status).toBe("complete");
    } else {
      expect(outcome).toMatchObject({ status: "incomplete", reason: expected });
      if (outcome.status === "incomplete") {
        expect(outcome.checkpoint.position).toBe("start");
        expect(outcome.checkpoint.artifacts).toEqual({});
        expect(outcome.checkpoint.receipts.at(-1)?.status).toBe("limit_exhausted");
      }
    }
  });

  it("resumes an unsettled pending turn at the deadline without new provider work", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_800_200_000_000);
    const store = new InMemoryCampaignStore();
    await expect(design(request("run-expired-pending", "C0"), {
      repository: new FakeRepositoryPort({ revision: "rev-1", files: {} }),
      turns: {
        async reconcileTurn() { return null; },
        async runTurn() { throw new Error("park after pending save"); },
      },
      store,
    })).rejects.toThrow("park after pending save");
    const parked = (await store.load("run-expired-pending")) as CampaignCheckpoint;
    const exactRequest = structuredClone(parked.pendingTurn?.request);
    vi.setSystemTime(parked.startedAtEpochMs + parked.envelope.limits.maxWallMs);
    let reconciliations = 0;
    let providerRuns = 0;
    const outcome = await resume("run-expired-pending", {
      repository: new FakeRepositoryPort({ revision: "rev-1", files: {} }),
      turns: {
        async reconcileTurn(turnRequest) {
          reconciliations += 1;
          expect(turnRequest).toEqual(exactRequest);
          return null;
        },
        async runTurn() {
          providerRuns += 1;
          return designerComplete();
        },
      },
      store,
    });

    expect(outcome).toMatchObject({ status: "incomplete", reason: "limit_exhausted" });
    expect(reconciliations).toBe(1);
    expect(providerRuns).toBe(0);
    if (outcome.status === "incomplete") expect(outcome.checkpoint.pendingTurn?.request).toEqual(exactRequest);
  });

  it("recovers a pre-deadline durable settlement after the process resumes past the deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_800_300_000_000);
    const inner = new InMemoryCampaignStore();
    let saves = 0;
    const store: CampaignStorePort = {
      load: (runId) => inner.load(runId),
      async save(checkpoint, expectedGeneration) {
        saves += 1;
        if (saves === 3) throw new Error("crash after provider settlement");
        await inner.save(checkpoint, expectedGeneration);
      },
    };
    const scripted = new ScriptedTurnPort([{ result: designerComplete() }]);
    const ports: DesignPorts = {
      repository: new FakeRepositoryPort({ revision: "rev-1", files: {} }),
      turns: scripted,
      store,
    };
    await expect(design(request("run-settled-before-deadline", "C0"), ports)).rejects.toThrow("crash after provider settlement");
    const parked = (await inner.load("run-settled-before-deadline")) as CampaignCheckpoint;
    vi.setSystemTime(parked.startedAtEpochMs + parked.envelope.limits.maxWallMs + 1);

    const outcome = await resume("run-settled-before-deadline", { ...ports, store: inner });
    expect(outcome.status).toBe("complete");
    expect(scripted.consumed).toBe(1);
  });

  it("applies the same remaining-wall calculation to a tightened admission", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = 1_800_400_000_000;
    vi.setSystemTime(startedAt);
    const inner = new InMemoryCampaignStore();
    const store: CampaignStorePort = {
      load: (runId) => inner.load(runId),
      async save(checkpoint, expectedGeneration) {
        await inner.save(checkpoint, expectedGeneration);
        if (expectedGeneration === 0) vi.setSystemTime(startedAt + 60_000);
      },
    };
    const ports = makePorts([{
      result: (turnRequest) => {
        expect(turnRequest.limits.maxWallMs).toBe(60_000);
        return designerComplete();
      },
    }], store);

    const outcome = await design(request("run-tight-wall", "C0", { limits: { maxWallMs: 120_000 } }), ports);
    expect(outcome.status).toBe("complete");
  });
});

describe("campaign growth bounds", () => {
  it("accepts an exact UTF-8 artifact boundary", async () => {
    const ports = makePorts([
      { result: ok({ marker: "CONTINUE", files: [{ path: "validation-design/note.md", content: "é" }] }, DESIGNER_ID) },
      { result: { status: "refused", reason: "stop after boundary assertion" } },
    ]);
    const outcome = await design(request("run-artifact-exact", "C2", {
      limits: { maxArtifactBytes: 2 },
    }), ports);
    expect(outcome).toMatchObject({ status: "incomplete", reason: "turn_refused" });
    if (outcome.status === "incomplete") {
      expect(outcome.checkpoint.artifacts).toEqual({ "validation-design/note.md": "é" });
      expect(outcome.checkpoint.receipts[0]?.output).toEqual({ marker: "CONTINUE" });
      expect(outcome.checkpoint.receipts[0]?.artifactChanges).toEqual([{
        path: "validation-design/note.md",
        sha256: createHash("sha256").update("é").digest("hex"),
      }]);
    }
  });

  it.each([
    ["bytes", { maxArtifactBytes: 5, maxArtifactFiles: 10 }],
    ["files", { maxArtifactBytes: 100, maxArtifactFiles: 1 }],
  ] as const)("prevents individually valid writes from accumulating beyond artifact %s", async (_label, limits) => {
    const ports = makePorts([
      { result: ok({ marker: "CONTINUE", files: [{ path: "validation-design/a.md", content: "123" }] }, DESIGNER_ID) },
      { result: ok({ message: "continue", approved: false }, STAKEHOLDER_ID) },
      { result: ok({ marker: "CONTINUE", files: [{ path: "validation-design/b.md", content: "456" }] }, DESIGNER_ID) },
    ]);
    const outcome = await design(request(`run-artifact-accumulate-${_label}`, "C3", { limits }), ports);
    expect(outcome).toMatchObject({ status: "incomplete", reason: "invalid_artifact" });
    if (outcome.status === "incomplete") {
      expect(outcome.checkpoint.artifacts).toEqual({ "validation-design/a.md": "123" });
      expect(outcome.nextAction).toContain(_label === "bytes" ? "maxArtifactBytes" : "maxArtifactFiles");
    }
  });

  it("accepts an exact prompt byte boundary and refuses one byte over before dispatch", async () => {
    let promptBytes = 0;
    const probe = makePorts([{
      result: (turnRequest) => {
        promptBytes = Buffer.byteLength(turnRequest.prompt, "utf8");
        return designerComplete();
      },
    }]);
    expect((await design(request("run-prompt-probe", "C0", { intake: "prompt-é" }), probe)).status).toBe("complete");

    const exact = makePorts([{ result: designerComplete() }]);
    expect((await design(request("run-prompt-exact", "C0", {
      intake: "prompt-é",
      limits: { maxPromptBytes: promptBytes },
    }), exact)).status).toBe("complete");

    const oneOver = makePorts([{ result: designerComplete() }]);
    const outcome = await design(request("run-prompt-overx", "C0", {
      intake: "prompt-é",
      limits: { maxPromptBytes: promptBytes - 1 },
    }), oneOver);
    expect(outcome).toMatchObject({ status: "incomplete", reason: "limit_exhausted" });
    expect(oneOver.scripted.consumed).toBe(0);
  });

  it("bounds compact structured history at exact and one-over admission", async () => {
    const turn = ok({ marker: "CONTINUE", files: [] }, DESIGNER_ID);
    const probe = makePorts([
      { result: turn },
      { result: { status: "refused", reason: "stop" } },
    ]);
    const probed = await design(request("run-history-probe", "C2"), probe);
    if (probed.status !== "incomplete") throw new Error("expected probe to stop");
    const first = probed.checkpoint.receipts[0] as TurnReceipt;
    const exactBytes = structuredHistoryBytes([first]);

    const exact = makePorts([{ result: turn }, { result: { status: "refused", reason: "stop" } }]);
    const exactOutcome = await design(request("run-history-exact", "C2", { limits: { maxHistoryBytes: exactBytes } }), exact);
    expect(exactOutcome).toMatchObject({ status: "incomplete", reason: "turn_refused" });

    const oneOver = makePorts([{ result: turn }]);
    const overOutcome = await design(request("run-history-overx", "C2", { limits: { maxHistoryBytes: exactBytes - 1 } }), oneOver);
    expect(overOutcome).toMatchObject({ status: "incomplete", reason: "limit_exhausted" });
    if (overOutcome.status === "incomplete") expect(overOutcome.checkpoint.artifacts).toEqual({});
  });

  it("applies an exact multibyte intake bound and rejects one byte over before checkpoint or spend", async () => {
    const exact = makePorts([{ result: designerComplete() }]);
    expect((await design(request("run-intake-exact", "C0", {
      intake: "é",
      limits: { maxIntakeBytes: 2 },
    }), exact)).status).toBe("complete");

    const store = new InMemoryCampaignStore();
    const oneOver = makePorts([{ result: designerComplete() }], store);
    await expect(design(request("run-intake-over", "C0", {
      intake: "é",
      limits: { maxIntakeBytes: 1 },
    }), oneOver)).rejects.toSatisfy((error: unknown) => isPublicContractError(error, "invalid_input"));
    expect(oneOver.scripted.consumed).toBe(0);
    expect(await store.load("run-intake-over")).toBeNull();
  });

  it("rejects an oversized revision corpus before provider spend", async () => {
    const files = Object.fromEntries(corpusFiles().map((file) => [file.path, file.content]));
    const store = new InMemoryCampaignStore();
    const ports = makePorts([{ result: designerComplete() }], store, files);
    await expect(design(request("run-revision-oversized", "C0", {
      mode: "revision",
      limits: { maxArtifactBytes: 1 },
    }), ports)).rejects.toSatisfy((error: unknown) => isPublicContractError(error, "invalid_input"));
    expect(ports.scripted.consumed).toBe(0);
    expect(await store.load("run-revision-oversized")).toBeNull();
  });

  it("bounds authority-bearing structured prose", async () => {
    const ports = makePorts([
      { result: ok({ marker: "CONTINUE", files: [] }, DESIGNER_ID) },
      { result: ok({ message: "x".repeat(64 * 1024 + 1), approved: false }, STAKEHOLDER_ID) },
    ]);
    const outcome = await design(request("run-structured-prose", "C2"), ports);
    expect(outcome).toMatchObject({ status: "incomplete", reason: "invalid_artifact" });
  });

  it("never permits admission to enlarge a growth bound", async () => {
    const ports = makePorts([{ result: designerComplete() }]);
    await expect(design(request("run-growth-enlarge", "C0", {
      admit: (envelope) => ({
        ...envelope,
        limits: { ...envelope.limits, maxArtifactBytes: envelope.limits.maxArtifactBytes + 1 },
      }),
    }), ports)).rejects.toSatisfy((error: unknown) => isPublicContractError(error, "invalid_input"));
    expect(ports.scripted.consumed).toBe(0);
  });
});

describe("exact profile sequences", () => {
  it("C0 spends exactly one designer turn, records the audit omission, and refuses a fifth wheel", async () => {
    const ports = makePorts([
      {
        expect: { seat: "designer", sessionMode: "new" },
        result: (turnRequest) => {
          expect(turnRequest.prompt).toContain("The checked YAML model is authority");
          expect(turnRequest.prompt).toContain("validation-architect check");
          expect(turnRequest.prompt).toContain("Never use [stated]");
          expect(turnRequest.prompt).toContain("Docs win factual conflicts");
          return designerComplete();
        },
      },
      { result: cleanAudit() }, // seeded extra turn that must never be consumed
    ]);
    const outcome = await design(request("run-c0", "C0"), ports);
    expect(outcome.status).toBe("complete");
    if (outcome.status !== "complete") return;
    expect(outcome.bundle.audit).toEqual({ status: "not_required_by_profile" });
    expect(outcome.bundle.usage.turns).toBe(1);
    expect(ports.scripted.consumed).toBe(1);
    expect(outcome.bundle.files.some((file) => file.path === "validation-design/model/project.yaml")).toBe(true);
    expect(outcome.bundle.provenance.runId).toBe("run-c0");
  });

  it("C1 is designer then one fresh same-model auditor (session independence only), exactly two turns", async () => {
    const ports = makePorts([
      { expect: { seat: "designer", sessionMode: "new" }, result: designerComplete() },
      {
        expect: { seat: "auditor", sessionMode: "new" },
        result: (turnRequest) => {
          expect(turnRequest.prompt).toContain("taste and preferred prose structure are not auditable findings");
          expect(turnRequest.prompt).toContain("never positions to reopen");
          return cleanAudit();
        },
      },
    ]);
    const outcome = await design(request("run-c1", "C1"), ports);
    expect(outcome.status).toBe("complete");
    if (outcome.status !== "complete") return;
    expect(outcome.bundle.audit).toEqual({ status: "performed", verdict: "clean", findings: [] });
    expect(ports.scripted.consumed).toBe(2);
  });

  it("C2 runs draft, challenge, revision (resuming the exact designer session), audit — exactly four turns in order", async () => {
    const ports = makePorts([
      { expect: { seat: "designer", sessionMode: "new" }, result: ok({ marker: "CONTINUE", files: corpusFiles() }, DESIGNER_ID) },
      { expect: { seat: "stakeholder", sessionMode: "new" }, result: ok({ message: "Challenge the oracles.", approved: false }, STAKEHOLDER_ID) },
      {
        expect: { seat: "designer", sessionMode: "resume" },
        result: (turnRequest) => {
          expect(turnRequest.session).toEqual({ mode: "resume", sessionId: "s-designer" });
          return designerComplete();
        },
      },
      { expect: { seat: "auditor", sessionMode: "new" }, result: ok({ verdict: "reservations", findings: [{ id: "AUD-001", tier: "significant", title: "Thin negative controls" }] }, AUDITOR_ID) },
    ]);
    const outcome = await design(request("run-c2", "C2"), ports);
    expect(outcome.status).toBe("complete");
    if (outcome.status !== "complete") return;
    expect(ports.scripted.consumed).toBe(4);
    expect(outcome.bundle.audit).toEqual({
      status: "performed",
      verdict: "reservations",
      findings: [{ id: "AUD-001", tier: "significant", title: "Thin negative controls", iteration: 1 }],
    });
  });
});

describe("identity and independence", () => {
  it("refuses a stakeholder that shares the designer's provider", async () => {
    const ports = makePorts([
      { result: ok({ marker: "CONTINUE", files: corpusFiles() }, DESIGNER_ID) },
      { result: ok({ message: "hello", approved: false }, { provider: "anthropic", model: "other", session: "s2" }) },
    ]);
    await expect(design(request("run-xp", "C2"), ports)).rejects.toSatisfy((error: unknown) =>
      isPublicContractError(error, "identity_mismatch"),
    );
  });

  it("refuses an auditor session that is not fresh from the designer", async () => {
    const ports = makePorts([
      { result: designerComplete() },
      { result: cleanAudit({ ...AUDITOR_ID, session: DESIGNER_ID.session }) },
    ]);
    await expect(design(request("run-fresh", "C1"), ports)).rejects.toSatisfy((error: unknown) =>
      isPublicContractError(error, "identity_mismatch"),
    );
  });

  it("refuses a persistent seat that switches native session on resume", async () => {
    const ports = makePorts([
      { result: ok({ marker: "CONTINUE", files: corpusFiles() }, DESIGNER_ID) },
      { result: ok({ message: "m", approved: false }, STAKEHOLDER_ID) },
      { result: designerComplete({ ...DESIGNER_ID, session: "hijacked" }) },
    ]);
    await expect(design(request("run-hijack", "C2"), ports)).rejects.toSatisfy((error: unknown) =>
      isPublicContractError(error, "identity_mismatch"),
    );
  });

  it("refuses a fresh seat that reuses its prior native session", async () => {
    const repeated = { provider: "anthropic", model: "fable", session: "reader-reused" };
    const ports = makePorts([
      { result: designerComplete() },
      { result: ok({ findings: [] }, repeated) },
      { result: ok({ findings: [] }, { ...repeated, session: "reader-eng-1" }) },
      { result: ok({ findings: [] }, { ...repeated, session: "reader-agent-1" }) },
      { result: designerComplete() },
      { result: ok({ message: "Round accepted.", approved: true }, STAKEHOLDER_ID) },
      { result: ok({ findings: [] }, repeated) },
    ]);
    await expect(design(request("run-fresh-reuse", "C3"), ports)).rejects.toSatisfy((error: unknown) =>
      isPublicContractError(error, "identity_mismatch"),
    );
  });
});

describe("typed failures without recovery", () => {
  it("rejects one artifact byte over the admitted cumulative allowance before accepting it", async () => {
    const ports = makePorts([{
      result: ok({
        marker: "CONTINUE",
        files: [{ path: "validation-design/note.md", content: "é" }],
      }, DESIGNER_ID),
    }]);
    const outcome = await design(request("run-artifact-one-over", "C2", {
      limits: { maxArtifactBytes: 1 },
    }), ports);
    expect(outcome).toMatchObject({ status: "incomplete", reason: "invalid_artifact" });
    expect(ports.scripted.consumed).toBe(1);
    if (outcome.status === "incomplete") expect(outcome.checkpoint.artifacts).toEqual({});
  });

  it("a refused turn is the incomplete outcome; resume returns the same failure without another spend", async () => {
    const store = new InMemoryCampaignStore();
    const ports = makePorts([
      { result: designerComplete() },
      { result: { status: "refused", reason: "policy" } },
    ], store);
    const outcome = await design(request("run-refused", "C1"), ports);
    expect(outcome).toMatchObject({ status: "incomplete", reason: "turn_refused" });
    expect(ports.scripted.consumed).toBe(2);

    const again = await resume("run-refused", makePorts([{ result: cleanAudit() }], store));
    expect(again).toMatchObject({ status: "incomplete", reason: "turn_refused" });
    if (again.status === "incomplete") expect(again.checkpoint.usage.turns).toBe(2);
  });

  it("invalid structured output is invalid_artifact; no thin bundle is manufactured", async () => {
    const ports = makePorts([
      { result: { status: "ok", text: "not json at all", identity: DESIGNER_ID } },
    ]);
    const outcome = await design(request("run-badjson", "C0"), ports);
    expect(outcome).toMatchObject({ status: "incomplete", reason: "invalid_artifact" });
  });

  it("a corpus that fails deterministic validation is invalid_artifact", async () => {
    const files = corpusFiles().map((file) =>
      file.path === "validation-design/model/families.yaml" ? { ...file, content: "schema: wrong\n" } : file,
    );
    const ports = makePorts([{ result: ok({ marker: "CAMPAIGN-COMPLETE", files }, DESIGNER_ID) }]);
    const outcome = await design(request("run-badcorpus", "C0"), ports);
    expect(outcome).toMatchObject({ status: "incomplete", reason: "invalid_artifact" });
  });

  it("an artifact outside validation-design/ is refused", async () => {
    const files = [...corpusFiles(), { path: "src/backdoor.ts", content: "evil" }];
    const ports = makePorts([{ result: ok({ marker: "CAMPAIGN-COMPLETE", files }, DESIGNER_ID) }]);
    const outcome = await design(request("run-escape", "C0"), ports);
    expect(outcome).toMatchObject({ status: "incomplete", reason: "invalid_artifact" });
  });
});

describe("envelope admission", () => {
  it("an unadmitted envelope spends zero turns and leaves no checkpoint", async () => {
    const store = new InMemoryCampaignStore();
    const ports = makePorts([{ result: designerComplete() }], store);
    await expect(design(request("run-veto", "C0", { admit: () => null }), ports)).rejects.toSatisfy((error: unknown) =>
      isPublicContractError(error, "invalid_input"),
    );
    expect(ports.scripted.consumed).toBe(0);
    expect(await store.load("run-veto")).toBeNull();
  });

  it("a host may tighten limits; the tightened bound is enforced as limit_exhausted", async () => {
    const ports = makePorts([
      { result: ok({ marker: "CONTINUE", files: corpusFiles() }, DESIGNER_ID) },
      { result: ok({ message: "more", approved: false }, STAKEHOLDER_ID) },
    ]);
    const outcome = await design(request("run-tight", "C2", { limits: { maxTurns: 2 } }), ports);
    expect(outcome).toMatchObject({ status: "incomplete", reason: "limit_exhausted" });
    expect(ports.scripted.consumed).toBe(2);
  });

  it("an admit callback that enlarges limits is refused before any spend", async () => {
    const ports = makePorts([{ result: designerComplete() }]);
    await expect(
      design(
        request("run-enlarge", "C0", {
          admit: (envelope) => ({ ...envelope, limits: { ...envelope.limits, maxTurns: 99 } }),
        }),
        ports,
      ),
    ).rejects.toSatisfy((error: unknown) => isPublicContractError(error, "invalid_input"));
    expect(ports.scripted.consumed).toBe(0);
  });

  it("an admit callback that mutates the graph is refused", async () => {
    const ports = makePorts([{ result: designerComplete() }]);
    await expect(
      design(
        request("run-mutate", "C0", {
          admit: (envelope) => ({ ...envelope, terminals: [...envelope.terminals, "shortcut"] }),
        }),
        ports,
      ),
    ).rejects.toSatisfy((error: unknown) => isPublicContractError(error, "invalid_input"));
    expect(ports.scripted.consumed).toBe(0);
  });

  it.each([
    ["drops a required limit", (envelope: ReturnType<typeof buildEnvelope>) => {
      const answer = structuredClone(envelope) as ReturnType<typeof buildEnvelope> & { limits: Record<string, number> };
      Reflect.deleteProperty(answer.limits, "maxTokensPerTurn");
      return answer;
    }],
    ["sets a non-positive limit", (envelope: ReturnType<typeof buildEnvelope>) => ({
      ...envelope,
      limits: { ...envelope.limits, maxTokensPerTurn: 0 },
    })],
  ])("refuses admission that %s before any spend", async (_label, mutate) => {
    const ports = makePorts([{ result: designerComplete() }]);
    await expect(design(request(`run-bad-admit-${String(_label).replaceAll(" ", "-")}`, "C0", { admit: mutate }), ports))
      .rejects.toSatisfy((error: unknown) => isPublicContractError(error, "invalid_input"));
    expect(ports.scripted.consumed).toBe(0);
  });
});

describe("crash matrix", () => {
  class CrashingStore implements CampaignStorePort {
    readonly inner = new InMemoryCampaignStore();
    crashOnSave: number | null = null;
    #saves = 0;
    async load(runId: string): Promise<CampaignCheckpoint | null> {
      return this.inner.load(runId);
    }
    async save(checkpoint: CampaignCheckpoint, expectedGeneration: number): Promise<void> {
      this.#saves += 1;
      if (this.crashOnSave !== null && this.#saves === this.crashOnSave) {
        this.crashOnSave = null;
        throw new Error("simulated crash");
      }
      return this.inner.save(checkpoint, expectedGeneration);
    }
  }

  it("crash before the pending save spends zero; resume completes normally", async () => {
    const store = new CrashingStore();
    store.crashOnSave = 2; // initial save is 1; first pending save is 2
    const ports = makePorts([{ result: designerComplete() }], store);
    await expect(design(request("run-crash-a", "C0"), ports)).rejects.toThrow("simulated crash");
    expect(ports.scripted.consumed).toBe(0);

    const resumed = await resume("run-crash-a", makePorts([{ result: designerComplete() }], store.inner));
    expect(resumed.status).toBe("complete");
  });

  it("does not start a new turn after the admitted wall-clock deadline", async () => {
    const store = new CrashingStore();
    store.crashOnSave = 2;
    await expect(design(request("run-wall", "C0"), makePorts([{ result: designerComplete() }], store))).rejects.toThrow("simulated crash");
    const checkpoint = (await store.inner.load("run-wall")) as CampaignCheckpoint;
    checkpoint.startedAtEpochMs = Date.now() - checkpoint.envelope.limits.maxWallMs - 1;
    checkpoint.generation += 1;
    await store.inner.save(checkpoint, checkpoint.generation - 1);
    const resumedPorts = makePorts([{ result: designerComplete() }], store.inner);
    const outcome = await resume("run-wall", resumedPorts);
    expect(outcome).toMatchObject({ status: "incomplete", reason: "limit_exhausted" });
    expect(resumedPorts.scripted.consumed).toBe(0);
  });

  it("crash after the pending save resumes the exact pending idempotency key", async () => {
    const store = new InMemoryCampaignStore();
    const crashingTurns = {
      async reconcileTurn() { return null; },
      async runTurn(): Promise<TurnResult> {
        throw new Error("simulated crash before the provider answered");
      },
    };
    const first: DesignPorts = {
      repository: new FakeRepositoryPort({ revision: "rev-1", files: {} }),
      turns: crashingTurns,
      store,
    };
    await expect(design(request("run-crash-b", "C0"), first)).rejects.toThrow("simulated crash");
    const parked = await store.load("run-crash-b");
    expect(parked?.pendingTurn?.idempotencyKey).toBe("run-crash-b:turn:1");
    const exactRequest = structuredClone(parked?.pendingTurn?.request);

    const second = makePorts([
      {
        result: (turnRequest) => {
          expect(turnRequest.idempotencyKey).toBe("run-crash-b:turn:1");
          expect(turnRequest).toEqual(exactRequest);
          return designerComplete();
        },
      },
    ], store);
    const outcome = await resume("run-crash-b", second);
    expect(outcome.status).toBe("complete");
    expect(second.scripted.consumed).toBe(1);
  });

  it("crash after settlement but before the accepted save reconciles to the same result without a second spend", async () => {
    const store = new CrashingStore();
    store.crashOnSave = 3; // initial=1, pending=2, accepted=3
    const scripted = new ScriptedTurnPort([{ result: designerComplete() }]);
    const first: DesignPorts = { repository: new FakeRepositoryPort({ revision: "rev-1", files: {} }), turns: scripted, store };
    await expect(design(request("run-crash-c", "C0"), first)).rejects.toThrow("simulated crash");
    expect(scripted.consumed).toBe(1);

    // Resume with the SAME turn port: the pending key must reconcile to the
    // settled result and consume nothing further.
    const second: DesignPorts = { repository: new FakeRepositoryPort({ revision: "rev-1", files: {} }), turns: scripted, store: store.inner };
    const outcome = await resume("run-crash-c", second);
    expect(outcome.status).toBe("complete");
    expect(scripted.consumed).toBe(1);
    if (outcome.status === "complete") expect(outcome.bundle.usage.turns).toBe(1);
  });

  it("two concurrent resumes advance the campaign exactly once", async () => {
    const store = new InMemoryCampaignStore();
    const crashingTurns = {
      async reconcileTurn() { return null; },
      async runTurn(): Promise<TurnResult> {
        throw new Error("park the pending turn");
      },
    };
    await expect(
      design(request("run-race", "C0"), {
        repository: new FakeRepositoryPort({ revision: "rev-1", files: {} }),
        turns: crashingTurns,
        store,
      }),
    ).rejects.toThrow();

    const scripted = new ScriptedTurnPort([{ result: designerComplete() }]);
    const portsFor = (): DesignPorts => ({
      repository: new FakeRepositoryPort({ revision: "rev-1", files: {} }),
      turns: scripted,
      store,
    });
    const results = await Promise.allSettled([resume("run-race", portsFor()), resume("run-race", portsFor())]);
    const fulfilled = results.filter((item) => item.status === "fulfilled");
    const rejected = results.filter((item) => item.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(
      rejected.every((item) => isPublicContractError((item as PromiseRejectedResult).reason, "stale_generation")),
    ).toBe(true);
    expect(scripted.consumed).toBe(1);
    expect((await store.load("run-race"))?.usage.turns).toBe(1);
  });
});

describe("resume binding", () => {
  async function parkedRun(runId: string): Promise<InMemoryCampaignStore> {
    const store = new InMemoryCampaignStore();
    await expect(
      design(request(runId, "C0"), {
        repository: new FakeRepositoryPort({ revision: "rev-1", files: {} }),
        turns: { async reconcileTurn() { return null; }, async runTurn() { throw new Error("park"); } },
        store,
      }),
    ).rejects.toThrow();
    return store;
  }

  it("refuses resume under a different package version", async () => {
    const store = await parkedRun("run-ver");
    const checkpoint = (await store.load("run-ver")) as CampaignCheckpoint;
    const forged = structuredClone(checkpoint);
    forged.packageVersion = "0.0.9";
    forged.envelope.packageVersion = "0.0.9";
    forged.generation = checkpoint.generation + 1;
    await store.save(forged, checkpoint.generation);
    await expect(resume("run-ver", makePorts([{ result: designerComplete() }], store))).rejects.toSatisfy(
      (error: unknown) => isPublicContractError(error, "version_mismatch"),
    );
  });

  it("refuses resume against a moved source revision", async () => {
    const store = await parkedRun("run-rev");
    const ports: DesignPorts = {
      repository: new FakeRepositoryPort({ revision: "rev-MOVED", files: {} }),
      turns: new ScriptedTurnPort([{ result: designerComplete() }]),
      store,
    };
    await expect(resume("run-rev", ports)).rejects.toSatisfy((error: unknown) =>
      isPublicContractError(error, "version_mismatch"),
    );
  });

  it("refuses a checkpoint whose envelope shape was mutated", async () => {
    const store = await parkedRun("run-shape");
    const checkpoint = (await store.load("run-shape")) as CampaignCheckpoint;
    const forged = structuredClone(checkpoint);
    forged.envelope.transitions.push({ from: "start", to: "done", seat: { seat: "reader", instance: "reader:operator" }, turnCost: 0 });
    const hostileStore: CampaignStorePort = {
      async load() { return structuredClone(forged); },
      async save() { throw new Error("resume must reject before saving"); },
    };
    await expect(resume("run-shape", makePorts([{ result: designerComplete() }], hostileStore))).rejects.toSatisfy(
      (error: unknown) => isPublicContractError(error, "invalid_checkpoint"),
    );
  });

  it("reconstructs a pending request and rejects a forged prompt before TurnPort", async () => {
    const store = await parkedRun("run-prompt");
    const forged = (await store.load("run-prompt")) as CampaignCheckpoint;
    if (!forged.pendingTurn) throw new Error("expected parked pending turn");
    forged.pendingTurn.request.prompt = "forged prompt with valid structure";
    const hostileStore: CampaignStorePort = {
      async load() { return structuredClone(forged); },
      async save() { throw new Error("resume must reject before saving"); },
    };
    const ports = makePorts([{ result: designerComplete() }], hostileStore);
    await expect(resume("run-prompt", ports)).rejects.toSatisfy((error: unknown) =>
      isPublicContractError(error, "invalid_checkpoint"),
    );
    expect(ports.scripted.consumed).toBe(0);
  });

  it("refuses same-revision repository drift before replaying a pending turn", async () => {
    const store = new InMemoryCampaignStore();
    await expect(design(request("run-drift", "C0"), {
      repository: new FakeRepositoryPort({ revision: "rev-1", files: { "README.md": "before" } }),
      turns: { async reconcileTurn() { return null; }, async runTurn() { throw new Error("park"); } },
      store,
    })).rejects.toThrow("park");
    const ports = makePorts([{ result: designerComplete() }], store, { "README.md": "after" });
    await expect(resume("run-drift", ports)).rejects.toSatisfy((error: unknown) =>
      isPublicContractError(error, "version_mismatch"),
    );
    expect(ports.scripted.consumed).toBe(0);
  });
});

describe("revision context", () => {
  it("seeds revision mode from the admitted repository corpus and records the repository prompt", async () => {
    const files = Object.fromEntries(corpusFiles().map((file) => [file.path, file.content]));
    const ports = makePorts([{
      result: (turnRequest) => {
        expect(turnRequest.prompt).toContain("Mode: revision");
        expect(turnRequest.prompt).toContain("validation-design/model/project.yaml");
        return ok({ marker: "CAMPAIGN-COMPLETE" }, DESIGNER_ID);
      },
    }], new InMemoryCampaignStore(), files);
    const outcome = await design(request("run-revision", "C0", { mode: "revision" }), ports);
    expect(outcome.status).toBe("complete");
    if (outcome.status === "complete") expect(outcome.bundle.files.length).toBe(corpusFiles().length);
  });

  it("refuses revision mode without a complete current corpus before admission or spend", async () => {
    let admitted = false;
    const ports = makePorts([{ result: designerComplete() }], new InMemoryCampaignStore(), { "README.md": "no corpus" });
    await expect(design(request("run-revision-missing", "C0", {
      mode: "revision",
      admit: (envelope) => { admitted = true; return envelope; },
    }), ports)).rejects.toSatisfy((error: unknown) => isPublicContractError(error, "invalid_input"));
    expect(admitted).toBe(false);
    expect(ports.scripted.consumed).toBe(0);
  });
});

describe("escalation", () => {
  it("a designer-reported deeper minimum completes within budget but sets escalationRequired", async () => {
    const ports = makePorts([
      { result: designerComplete(DESIGNER_ID, { escalation: { minimumProfile: "C2", reason: "Real customer data found." } }) },
    ]);
    const outcome = await design(request("run-esc", "C0"), ports);
    expect(outcome.status).toBe("complete");
    if (outcome.status !== "complete") return;
    expect(outcome.bundle.profileAssessment).toEqual({
      selected: "C0",
      minimumSupportedByFindings: "C2",
      escalationRequired: true,
    });
  });

  it("the corpus's own declared criticality raises the minimum (C1 fixture over a C0 run)", async () => {
    const ports = makePorts([{ result: designerComplete() }]);
    const outcome = await design(request("run-esc2", "C0"), ports);
    expect(outcome.status).toBe("complete");
    if (outcome.status !== "complete") return;
    // The fixture corpus declares criticality C1.
    expect(outcome.bundle.profileAssessment.minimumSupportedByFindings).toBe("C1");
    expect(outcome.bundle.profileAssessment.escalationRequired).toBe(true);
  });
});

describe("C3/C4 bounded graph", () => {
  const readerResult = (session: string, findings: unknown[] = []): TurnResult =>
    ok({ findings }, { provider: "anthropic", model: "fable", session });
  const ratificationTurn = (content: string): TurnResult => ok({
    marker: "CAMPAIGN-COMPLETE",
    files: [{ path: "validation-design/ratification-package.md", content }],
  }, DESIGNER_ID);
  const readerProtocol = (prefix: string, firstStakeholderMode: "new" | "resume" = "new"): ScriptedTurn[] => [
    { expect: { seat: "reader", instance: "reader:operator", sessionMode: "new" }, result: readerResult(`${prefix}-r1-op`) },
    { expect: { seat: "reader", instance: "reader:new-engineer", sessionMode: "new" }, result: readerResult(`${prefix}-r1-eng`) },
    { expect: { seat: "reader", instance: "reader:coding-agent", sessionMode: "new" }, result: readerResult(`${prefix}-r1-agent`) },
    { expect: { seat: "designer", sessionMode: "resume" }, result: designerComplete() },
    { expect: { seat: "stakeholder", sessionMode: firstStakeholderMode }, result: ok({ message: "Round one confirmed.", approved: true }, STAKEHOLDER_ID) },
    { expect: { seat: "reader", instance: "reader:operator", sessionMode: "new" }, result: readerResult(`${prefix}-r2-op`) },
    { expect: { seat: "reader", instance: "reader:new-engineer", sessionMode: "new" }, result: readerResult(`${prefix}-r2-eng`) },
    { expect: { seat: "reader", instance: "reader:coding-agent", sessionMode: "new" }, result: readerResult(`${prefix}-r2-agent`) },
    { expect: { seat: "designer", sessionMode: "resume" }, result: designerComplete() },
    { expect: { seat: "stakeholder", sessionMode: "resume" }, result: ok({ message: "Round two confirmed.", approved: true }, STAKEHOLDER_ID) },
    { expect: { seat: "reader", instance: "reader:operator", sessionMode: "new" }, result: readerResult(`${prefix}-r3-op`) },
    { expect: { seat: "reader", instance: "reader:new-engineer", sessionMode: "new" }, result: readerResult(`${prefix}-r3-eng`) },
    { expect: { seat: "reader", instance: "reader:coding-agent", sessionMode: "new" }, result: readerResult(`${prefix}-r3-agent`) },
    { expect: { seat: "designer", sessionMode: "resume" }, result: ratificationTurn("# Reader-round residue\n\nNo unresolved reader findings.\n") },
    { expect: { seat: "stakeholder", sessionMode: "resume" }, result: ok({ message: "Terminal residue confirmed.", approved: true }, STAKEHOLDER_ID) },
  ];

  it("declares every bound, prices every transition, and covers its terminal", () => {
    const envelope = buildEnvelope(request("run-c3", "C3"), "rev-1");
    expect(envelope.shape).toBe("graph");
    expect(envelope.limits).toMatchObject({
      maxTurns: 104,
      maxRelayExchanges: 60,
      maxReaderTurns: 9,
      maxAuditIterations: 2,
      maxStakeholderExchangesPerAuditWindow: 12,
      maxTokensPerTurn: 32_768,
      maxArtifactFiles: 512,
      maxArtifactBytes: 1024 * 1024,
      maxHistoryBytes: 1024 * 1024,
      maxPromptBytes: 2 * 1024 * 1024,
      maxIntakeBytes: 128 * 1024,
    });
    // Every non-terminal state has a priced outgoing transition.
    for (const state of envelope.states.filter((item) => !envelope.terminals.includes(item))) {
      expect(envelope.transitions.some((item) => item.from === state)).toBe(true);
    }
    for (const transition of envelope.transitions) expect(transition.turnCost).toBe(1);
    // No third audit: nothing leaves audit:2 toward an auditor.
    expect(envelope.transitions.filter((item) => item.from === "audit:2").every((item) => item.seat.seat === "designer")).toBe(true);
  });

  it("relays repository facts and accepted artifacts through the bounded reader/audit protocol", async () => {
    const sentinel = { path: "validation-design/relay-note.md", content: "RELAY-SENTINEL" };
    const readers = readerProtocol("full", "resume");
    readers[0] = {
      expect: { seat: "reader", instance: "reader:operator", sessionMode: "new" },
      result: (turnRequest) => {
        expect(turnRequest.prompt).not.toContain("REPOSITORY-SENTINEL");
        expect(turnRequest.prompt).toContain("RELAY-SENTINEL");
        return readerResult("full-r1-op");
      },
    };
    const ports = makePorts([
      { expect: { seat: "designer", sessionMode: "new" }, result: ok({ marker: "CONTINUE", files: [...corpusFiles(), sentinel] }, DESIGNER_ID) },
      {
        expect: { seat: "stakeholder", sessionMode: "new" },
        result: (turnRequest) => {
          expect(turnRequest.prompt).toContain("REPOSITORY-SENTINEL");
          expect(turnRequest.prompt).toContain("RELAY-SENTINEL");
          expect(turnRequest.prompt.match(/RELAY-SENTINEL/g)).toHaveLength(1);
          expect(turnRequest.prompt).toContain(createHash("sha256").update("RELAY-SENTINEL").digest("hex"));
          expect(turnRequest.prompt).toContain("generic 'looks good' is a protocol failure");
          expect(turnRequest.limits).toEqual({
            maxTokens: 32_768,
            maxWallMs: 3_600_000,
            deadlineAtEpochMs: expect.any(Number),
          });
          return ok({ message: "Push harder on negative controls.", approved: false }, STAKEHOLDER_ID);
        },
      },
      { expect: { seat: "designer", sessionMode: "resume" }, result: designerComplete() },
      ...readers,
      { expect: { seat: "auditor", instance: "auditor:1", sessionMode: "new" }, result: cleanAudit() },
      { expect: { seat: "designer", sessionMode: "resume" }, result: ratificationTurn("# Audit\n\nVerdict: clean.\n") },
      { expect: { seat: "stakeholder", sessionMode: "resume" }, result: ok({ message: "Final audit record confirmed.", approved: true }, STAKEHOLDER_ID) },
    ], new InMemoryCampaignStore(), { "README.md": "REPOSITORY-SENTINEL" });
    const outcome = await design(request("run-c3-full", "C3"), ports);
    expect(outcome.status).toBe("complete");
    if (outcome.status !== "complete") return;
    expect(ports.scripted.consumed).toBe(21);
    expect(outcome.bundle.audit).toEqual({ status: "performed", verdict: "clean", findings: [] });
    expect(outcome.bundle.files.find((file) => file.path === "validation-design/relay-note.md")?.content).toBe("RELAY-SENTINEL");
  });

  it("preserves round-one findings, dispositions, verification, and round-two evidence losslessly", async () => {
    const finding = { id: "AUD-100", tier: "blocking", title: "Owner truth is unverifiable" };
    const ports = makePorts([
      { result: designerComplete() },
      ...readerProtocol("audit"),
      { expect: { seat: "auditor", instance: "auditor:1" }, result: ok({ verdict: "reservations", findings: [finding] }, AUDITOR_ID) },
      { expect: { seat: "designer" }, result: designerComplete(DESIGNER_ID, { dispositions: [{ findingId: "AUD-100", kind: "disputed", note: "The owner doc covers this." }] }) },
      { expect: { seat: "stakeholder" }, result: ok({ message: "Dispute stands.", approved: true }, STAKEHOLDER_ID) },
      {
        expect: { seat: "auditor", instance: "auditor:2", sessionMode: "new" },
        result: ok({
          verdict: "clean-with-disputes",
          findings: [finding],
          verification: [{ findingId: "AUD-100", status: "disputed" }],
        }, AUDITOR_2_ID),
      },
      { expect: { seat: "designer" }, result: ratificationTurn("# Audit\n\nAUD-100 disputed with owner evidence.\n") },
      { expect: { seat: "stakeholder" }, result: ok({ message: "Final record is complete.", approved: true }, STAKEHOLDER_ID) },
    ]);
    const outcome = await design(request("run-c3-audit", "C3"), ports);
    expect(outcome.status).toBe("complete");
    if (outcome.status !== "complete") return;
    expect(ports.scripted.consumed).toBe(22);
    expect(outcome.bundle.audit).toEqual({
      status: "performed",
      verdict: "clean-with-reservations", // never the internal clean-with-disputes
      findings: [
        {
          ...finding,
          iteration: 1,
          disposition: { kind: "disputed", note: "The owner doc covers this." },
          verification: "disputed",
        },
        { ...finding, iteration: 2 },
      ],
    });
  });

  it("rejects an iteration-two audit that omits round-one verification or introduces a non-blocking finding", async () => {
    const finding = { id: "AUD-101", tier: "significant", title: "Missing evidence" };
    const ports = makePorts([
      { result: designerComplete() },
      ...readerProtocol("scope"),
      { result: ok({ verdict: "reservations", findings: [finding] }, AUDITOR_ID) },
      { result: designerComplete(DESIGNER_ID, { dispositions: [{ findingId: "AUD-101", kind: "fixed", note: "Added evidence." }] }) },
      { result: ok({ message: "Fix accepted.", approved: true }, STAKEHOLDER_ID) },
      { result: ok({ verdict: "reservations", findings: [{ id: "AUD-NEW", tier: "minor", title: "New nit" }], verification: [] }, AUDITOR_2_ID) },
    ]);
    const outcome = await design(request("run-c3-scope", "C3"), ports);
    expect(outcome).toMatchObject({ status: "incomplete", reason: "invalid_artifact" });
  });

  it("ends a refused audit feedback window at its admitted cap and proceeds to the second audit", async () => {
    const finding = { id: "AUD-CAP", tier: "significant", title: "Evidence needs repair" };
    const disposition = designerComplete(DESIGNER_ID, {
      dispositions: [{ findingId: "AUD-CAP", kind: "fixed", note: "Evidence added." }],
    });
    const ports = makePorts([
      { result: designerComplete() },
      ...readerProtocol("cap"),
      { result: ok({ verdict: "reservations", findings: [finding] }, AUDITOR_ID) },
      { result: disposition },
      { result: ok({ message: "Not yet.", approved: false }, STAKEHOLDER_ID) },
      { result: disposition },
      { result: ok({ message: "Window exhausted.", approved: false }, STAKEHOLDER_ID) },
      {
        expect: { seat: "auditor", instance: "auditor:2" },
        result: ok({
          verdict: "clean",
          findings: [],
          verification: [{ findingId: "AUD-CAP", status: "fixed" }],
        }, AUDITOR_2_ID),
      },
      { result: ratificationTurn("# Audit\n\nAUD-CAP fixed in iteration two.\n") },
      { result: ok({ message: "Recorded.", approved: true }, STAKEHOLDER_ID) },
    ]);
    const outcome = await design(request("run-feedback-cap", "C3", {
      limits: { maxStakeholderExchangesPerAuditWindow: 2 },
    }), ports);
    expect(outcome.status).toBe("complete");
    if (outcome.status !== "complete") return;
    expect(outcome.bundle.audit).toMatchObject({
      status: "performed",
      verdict: "clean",
      findings: [{ id: "AUD-CAP", verification: "fixed" }],
    });
    expect(ports.scripted.consumed).toBe(24);
  });

  it("exhausts a tightened relay bound as a typed limit instead of completing", async () => {
    const continueTurn = (session: ExecutionIdentity, message = false): ScriptedTurn => ({
      result: message ? ok({ message: "again", approved: false }, session) : ok({ marker: "CONTINUE" }, session),
    });
    const ports = makePorts([
      continueTurn(DESIGNER_ID),
      continueTurn(STAKEHOLDER_ID, true),
      continueTurn(DESIGNER_ID),
      continueTurn(STAKEHOLDER_ID, true),
    ]);
    const outcome = await design(request("run-relay-cap", "C3", { limits: { maxRelayExchanges: 3 } }), ports);
    expect(outcome).toMatchObject({ status: "incomplete", reason: "limit_exhausted" });
  });
});
