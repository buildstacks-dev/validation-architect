import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildEnvelope,
  design,
  resume,
  type DesignPorts,
  type DesignRequest,
} from "../src/api/campaign-engine.js";
import type { CampaignCheckpoint, CampaignStorePort } from "../src/api/campaign-contracts.js";
import { FakeRepositoryPort, InMemoryCampaignStore, ScriptedTurnPort, type ScriptedTurn } from "../src/api/conformance.js";
import { isPublicContractError } from "../src/api/errors.js";
import type { ExecutionIdentity, TurnResult } from "../src/api/ports.js";
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

function makePorts(script: ScriptedTurn[], store: CampaignStorePort = new InMemoryCampaignStore()): DesignPorts & { scripted: ScriptedTurnPort } {
  const scripted = new ScriptedTurnPort(script);
  return {
    repository: new FakeRepositoryPort({ revision: "rev-1", files: {} }),
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
});

describe("exact profile sequences", () => {
  it("C0 spends exactly one designer turn, records the audit omission, and refuses a fifth wheel", async () => {
    const ports = makePorts([
      { expect: { seat: "designer", sessionMode: "new" }, result: designerComplete() },
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
      { expect: { seat: "auditor", sessionMode: "new" }, result: cleanAudit() },
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
});

describe("typed failures without recovery", () => {
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

  it("crash after the pending save resumes the exact pending idempotency key", async () => {
    const store = new InMemoryCampaignStore();
    const crashingTurns = {
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

    const second = makePorts([
      {
        result: (turnRequest) => {
          expect(turnRequest.idempotencyKey).toBe("run-crash-b:turn:1");
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
        turns: { async runTurn() { throw new Error("park"); } },
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
    forged.generation = checkpoint.generation + 1;
    await store.save(forged, checkpoint.generation);
    await expect(resume("run-shape", makePorts([{ result: designerComplete() }], store))).rejects.toSatisfy(
      (error: unknown) => isPublicContractError(error, "invalid_checkpoint"),
    );
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
  it("declares every bound, prices every transition, and covers its terminal", () => {
    const envelope = buildEnvelope(request("run-c3", "C3"), "rev-1");
    expect(envelope.shape).toBe("graph");
    expect(envelope.limits).toMatchObject({
      maxTurns: 84,
      maxRelayExchanges: 60,
      maxReaderTurns: 3,
      maxAuditIterations: 2,
      maxStakeholderExchangesPerAuditWindow: 12,
    });
    // Every non-terminal state has a priced outgoing transition.
    for (const state of envelope.states.filter((item) => !envelope.terminals.includes(item))) {
      expect(envelope.transitions.some((item) => item.from === state)).toBe(true);
    }
    for (const transition of envelope.transitions) expect(transition.turnCost).toBe(1);
    // No third audit: nothing leaves audit:2 toward an auditor.
    expect(envelope.transitions.filter((item) => item.from === "audit:2").every((item) => item.seat.seat === "designer")).toBe(true);
  });

  it("runs the full relay: kickoff, exchange, readers with fresh distinct sessions, audit, final review", async () => {
    const reader = (n: number): TurnResult => ok({ gaps: [] }, { provider: "anthropic", model: "fable", session: `s-reader-${n}` });
    const ports = makePorts([
      { expect: { seat: "designer", sessionMode: "new" }, result: ok({ marker: "CONTINUE" }, DESIGNER_ID) },
      { expect: { seat: "stakeholder", sessionMode: "new" }, result: ok({ message: "Push harder on negative controls.", approved: false }, STAKEHOLDER_ID) },
      { expect: { seat: "designer", sessionMode: "resume" }, result: designerComplete() },
      { expect: { seat: "reader", instance: "reader:operator", sessionMode: "new" }, result: reader(1) },
      { expect: { seat: "reader", instance: "reader:new-engineer", sessionMode: "new" }, result: reader(2) },
      { expect: { seat: "reader", instance: "reader:coding-agent", sessionMode: "new" }, result: reader(3) },
      { expect: { seat: "designer", sessionMode: "resume" }, result: designerComplete() },
      { expect: { seat: "auditor", instance: "auditor:1", sessionMode: "new" }, result: cleanAudit() },
      { expect: { seat: "designer", sessionMode: "resume" }, result: designerComplete() },
    ]);
    const outcome = await design(request("run-c3-full", "C3"), ports);
    expect(outcome.status).toBe("complete");
    if (outcome.status !== "complete") return;
    expect(ports.scripted.consumed).toBe(9);
    expect(outcome.bundle.audit).toEqual({ status: "performed", verdict: "clean", findings: [] });
  });

  it("routes findings through dispositions, stakeholder confirmation, and a verifying second audit — and maps the internal dispute verdict losslessly", async () => {
    const finding = { id: "AUD-100", tier: "blocking", title: "Owner truth is unverifiable" };
    const ports = makePorts([
      { result: designerComplete() },
      { result: ok({ gaps: [] }, { provider: "anthropic", model: "fable", session: "s-r1" }) },
      { result: ok({ gaps: [] }, { provider: "anthropic", model: "fable", session: "s-r2" }) },
      { result: ok({ gaps: [] }, { provider: "anthropic", model: "fable", session: "s-r3" }) },
      { result: designerComplete() },
      { expect: { seat: "auditor", instance: "auditor:1" }, result: ok({ verdict: "reservations", findings: [finding] }, AUDITOR_ID) },
      { expect: { seat: "designer" }, result: designerComplete(DESIGNER_ID, { dispositions: [{ findingId: "AUD-100", kind: "disputed", note: "The owner doc covers this." }] }) },
      { expect: { seat: "stakeholder" }, result: ok({ message: "Dispute stands.", approved: true }, STAKEHOLDER_ID) },
      { expect: { seat: "auditor", instance: "auditor:2", sessionMode: "new" }, result: ok({ verdict: "clean-with-disputes", findings: [finding] }, AUDITOR_2_ID) },
      { expect: { seat: "designer" }, result: designerComplete() },
    ]);
    const outcome = await design(request("run-c3-audit", "C3"), ports);
    expect(outcome.status).toBe("complete");
    if (outcome.status !== "complete") return;
    expect(ports.scripted.consumed).toBe(10);
    expect(outcome.bundle.audit).toEqual({
      status: "performed",
      verdict: "clean-with-reservations", // never the internal clean-with-disputes
      findings: [{ ...finding, iteration: 2 }],
    });
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
