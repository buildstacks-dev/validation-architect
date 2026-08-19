import { describe, expect, it } from "vitest";
import {
  InMemoryCampaignStore,
  ScriptedTurnPort,
  FakeRepositoryPort,
  okTurn,
} from "../src/api/conformance.js";
import {
  DESIGN_RUN_SCHEMA,
  PROVENANCE_SCHEMA,
  type CampaignCheckpoint,
  type CampaignEnvelope,
} from "../src/api/campaign-contracts.js";
import { isPublicContractError, PublicContractError } from "../src/api/errors.js";
import { validateTurnRequest, validateTurnResult, type TurnRequest } from "../src/api/ports.js";
import {
  PUBLISHED_SCHEMA_IDS,
  canonicalJson,
  schemaAssetFile,
  validateDesignRunCheckpoint,
  validateDesignRunEnvelope,
  validateProvenanceRecord,
  validateResult,
} from "../src/api/schemas.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

function envelope(): CampaignEnvelope {
  return {
    schema: DESIGN_RUN_SCHEMA,
    kind: "envelope",
    profile: "C1",
    packageVersion: "0.1.1",
    sourceRevision: "rev-1",
    inputIdentity: "input-1",
    shape: "sequence",
    seats: [
      { seat: { seat: "designer", instance: "designer" }, session: "persistent", independence: [] },
      {
        seat: { seat: "auditor", instance: "auditor:1" },
        session: "fresh",
        independence: [{ from: { seat: "designer", instance: "designer" }, dimensions: ["session"] }],
      },
    ],
    states: ["step:1", "step:2", "done"],
    transitions: [
      { from: "step:1", to: "step:2", seat: { seat: "designer", instance: "designer" }, turnCost: 1 },
      { from: "step:2", to: "done", seat: { seat: "auditor", instance: "auditor:1" }, turnCost: 1 },
    ],
    terminals: ["done"],
    outputSchemas: {},
    limits: { maxTurns: 2, maxWallMs: 60_000, maxTokensPerTurn: 4096 },
  };
}

function checkpoint(generation = 1): CampaignCheckpoint {
  return {
    schema: DESIGN_RUN_SCHEMA,
    kind: "checkpoint",
    runId: "run-1",
    generation,
    packageVersion: "0.1.1",
    sourceRevision: "rev-1",
    envelope: envelope(),
    position: "step:1",
    receipts: [],
    sessions: {},
    artifacts: {},
    intake: "fixture intake",
    mode: "greenfield",
    repository: { revision: "rev-1", identity: "a".repeat(64), inventory: [], files: [] },
    startedAtEpochMs: 1,
    usage: { turns: 0, inputTokens: 0, outputTokens: 0 },
  };
}

function turnRequest(): TurnRequest {
  return {
    seat: { seat: "designer", instance: "designer" },
    independence: [],
    session: { mode: "new" },
    idempotencyKey: "run-1:turn-1",
    prompt: "Design the corpus.",
    limits: { maxTokens: 4096, maxWallMs: 60_000, deadlineAtEpochMs: 60_001 },
    metadata: { runId: "run-1", phase: "design", turnIndex: 1 },
  };
}

describe("published schema identities", () => {
  it("exposes exactly the six ratified IDs", () => {
    expect(PUBLISHED_SCHEMA_IDS).toEqual({
      corpus: "validation-architect/corpus/v1",
      caseCatalog: "validation-architect/case-catalog/v1",
      result: "validation-architect/result/v1",
      plan: "validation-architect/plan/v1",
      designRun: "validation-architect/design-run/v1",
      provenance: "validation-architect/provenance/v1",
    });
  });

  it("ships a loadable machine-readable asset per schema whose $id matches", () => {
    for (const id of Object.values(PUBLISHED_SCHEMA_IDS)) {
      const asset = JSON.parse(readFileSync(join(root, "schemas", schemaAssetFile(id)), "utf8"));
      expect(asset.$id).toBe(id);
    }
  });

  it("refuses an asset lookup for an unpublished schema", () => {
    expect(() => schemaAssetFile("validation-architect/golden-set/v1")).toThrow(PublicContractError);
  });
});

describe("turn contracts", () => {
  it("round-trips every TurnResult status without success-by-omission", () => {
    const identity = { provider: "p1", model: "m1", session: "s1" };
    for (const result of [
      okTurn("text", identity),
      { status: "refused" as const, reason: "declined" },
      { status: "limit_exhausted" as const, reason: "budget", identity },
      { status: "error" as const, reason: "boom" },
    ]) {
      const problems: string[] = [];
      validateTurnResult(result, problems);
      expect(problems).toEqual([]);
    }
    const missingStatus: string[] = [];
    validateTurnResult({ text: "looks fine" }, missingStatus);
    expect(missingStatus.length).toBeGreaterThan(0);
    const unknownStatus: string[] = [];
    validateTurnResult({ status: "succeeded", text: "nope" }, unknownStatus);
    expect(unknownStatus.length).toBeGreaterThan(0);
  });

  it("rejects a turn request without idempotency key, seat, or session mode", () => {
    const problems: string[] = [];
    validateTurnRequest({ ...turnRequest(), idempotencyKey: "" }, problems);
    expect(problems.length).toBeGreaterThan(0);
    const badSession: string[] = [];
    validateTurnRequest({ ...turnRequest(), session: { mode: "resume" } }, badSession);
    expect(badSession.length).toBeGreaterThan(0);
  });

  it("scripted turns settle idempotently: a replayed key returns the same result and consumes no extra turn", async () => {
    const port = new ScriptedTurnPort([{ result: okTurn("one", { provider: "p", model: "m", session: "s" }) }]);
    expect(await port.reconcileTurn(turnRequest())).toBeNull();
    const first = await port.runTurn(turnRequest());
    const settlement = await port.reconcileTurn(turnRequest());
    expect(settlement?.result).toEqual(first);
    expect(settlement?.settledAtEpochMs).toEqual(expect.any(Number));
    const replay = await port.runTurn(turnRequest());
    expect(replay).toEqual(first);
    expect(port.consumed).toBe(1);
  });

  it("refuses an unplanned extra turn instead of inventing one", async () => {
    const port = new ScriptedTurnPort([]);
    await expect(port.runTurn(turnRequest())).rejects.toSatisfy((error: unknown) =>
      isPublicContractError(error, "invalid_input"),
    );
  });
});

describe("design-run envelope validation", () => {
  it("accepts the finite C1 sequence", () => {
    expect(validateDesignRunEnvelope(envelope())).toBeTruthy();
  });

  it("rejects transitions to undeclared states and terminals outside states", () => {
    const undeclared = envelope();
    undeclared.transitions.push({ from: "step:2", to: "ghost", seat: { seat: "reader", instance: "reader:operator" }, turnCost: 1 });
    expect(() => validateDesignRunEnvelope(undeclared)).toThrow(PublicContractError);

    const badTerminal = envelope();
    badTerminal.terminals = ["elsewhere"];
    expect(() => validateDesignRunEnvelope(badTerminal)).toThrow(PublicContractError);
  });
});

describe("design-run checkpoint validation", () => {
  it("accepts a complete checkpoint", () => {
    expect(validateDesignRunCheckpoint(checkpoint())).toBeTruthy();
  });

  it.each([
    ["packageVersion", (value: CampaignCheckpoint) => Reflect.deleteProperty(value, "packageVersion")],
    ["sourceRevision", (value: CampaignCheckpoint) => Reflect.deleteProperty(value, "sourceRevision")],
    ["envelope", (value: CampaignCheckpoint) => Reflect.deleteProperty(value, "envelope")],
    ["position", (value: CampaignCheckpoint) => Reflect.deleteProperty(value, "position")],
    ["generation", (value: CampaignCheckpoint) => Reflect.deleteProperty(value, "generation")],
    ["repository", (value: CampaignCheckpoint) => Reflect.deleteProperty(value, "repository")],
    ["startedAtEpochMs", (value: CampaignCheckpoint) => Reflect.deleteProperty(value, "startedAtEpochMs")],
    ["usage", (value: CampaignCheckpoint) => Reflect.deleteProperty(value, "usage")],
  ])("rejects a checkpoint missing %s", (_field, mutate) => {
    const value = checkpoint();
    mutate(value);
    expect(() => validateDesignRunCheckpoint(value)).toThrow(PublicContractError);
  });

  it("rejects duplicate receipts and unsafe artifact paths", () => {
    const duplicated = checkpoint();
    const receipt = {
      idempotencyKey: "k1",
      seat: { seat: "designer" as const, instance: "designer" },
      state: "step:1",
      nextState: "step:2",
      status: "error" as const,
    };
    duplicated.receipts = [receipt, { ...receipt }];
    expect(() => validateDesignRunCheckpoint(duplicated)).toThrow(PublicContractError);

    const traversal = checkpoint();
    traversal.artifacts = { "../outside.yaml": "nope" };
    expect(() => validateDesignRunCheckpoint(traversal)).toThrow(PublicContractError);
  });

  it("rejects a tampered pending request before it can be replayed", () => {
    const value = checkpoint();
    const request = {
      ...turnRequest(),
      metadata: { runId: "run-1", phase: "step:2", turnIndex: 1 },
    };
    value.pendingTurn = { idempotencyKey: request.idempotencyKey, request, createdAtEpochMs: 1 };
    expect(validateDesignRunCheckpoint(value)).toBeTruthy();

    if (!value.pendingTurn) throw new Error("expected pending turn");
    value.pendingTurn.idempotencyKey = "different-key";
    expect(() => validateDesignRunCheckpoint(value)).toThrow(PublicContractError);

    const wrongRemainingWall = checkpoint();
    wrongRemainingWall.pendingTurn = {
      idempotencyKey: request.idempotencyKey,
      request: { ...request, limits: { ...request.limits, maxWallMs: 59_999 } },
      createdAtEpochMs: 1,
    };
    expect(() => validateDesignRunCheckpoint(wrongRemainingWall)).toThrow(PublicContractError);

    const createdAtDeadline = checkpoint();
    createdAtDeadline.pendingTurn = { idempotencyKey: request.idempotencyKey, request, createdAtEpochMs: 60_001 };
    expect(() => validateDesignRunCheckpoint(createdAtDeadline)).toThrow(PublicContractError);
  });

  it("rejects checkpoint identity or position that disagrees with its envelope/history", () => {
    const wrongRevision = checkpoint();
    wrongRevision.sourceRevision = "other-revision";
    expect(() => validateDesignRunCheckpoint(wrongRevision)).toThrow(PublicContractError);

    const impossiblePosition = checkpoint();
    impossiblePosition.position = "step:2";
    expect(() => validateDesignRunCheckpoint(impossiblePosition)).toThrow(PublicContractError);
  });
});

describe("in-memory campaign store CAS", () => {
  it("advances happily on the expected generation", async () => {
    const store = new InMemoryCampaignStore();
    await store.save(checkpoint(1), 0);
    await store.save(checkpoint(2), 1);
    const loaded = await store.load("run-1");
    expect(loaded?.generation).toBe(2);
  });

  it("two writers on one generation: exactly one accepted, the stale writer gets the typed conflict", async () => {
    const store = new InMemoryCampaignStore();
    await store.save(checkpoint(1), 0);
    const writerA = checkpoint(2);
    writerA.artifacts = { "validation-design/model/a.yaml": "writer-a" };
    const writerB = checkpoint(2);
    writerB.artifacts = { "validation-design/model/a.yaml": "writer-b" };
    await store.save(writerA, 1);
    await expect(store.save(writerB, 1)).rejects.toSatisfy((error: unknown) =>
      isPublicContractError(error, "stale_generation"),
    );
    const settled = await store.load("run-1");
    expect(settled?.artifacts["validation-design/model/a.yaml"]).toBe("writer-a");
  });

  it("rejects a checkpoint that skips a generation", async () => {
    const store = new InMemoryCampaignStore();
    await expect(store.save(checkpoint(5), 0)).rejects.toSatisfy((error: unknown) =>
      isPublicContractError(error, "invalid_checkpoint"),
    );
  });

  it("returns an isolated clone on load so callers cannot mutate accepted state", async () => {
    const store = new InMemoryCampaignStore();
    await store.save(checkpoint(1), 0);
    const loaded = await store.load("run-1");
    (loaded as CampaignCheckpoint).position = "tampered";
    expect((await store.load("run-1"))?.position).toBe("step:1");
  });
});

describe("provenance validation", () => {
  it("accepts and canonicalizes a complete record deterministically", () => {
    const record = {
      schema: PROVENANCE_SCHEMA,
      packageVersion: "0.1.1",
      schemas: { ...PUBLISHED_SCHEMA_IDS },
      profile: "C2" as const,
      sourceRevision: "rev-1",
      runId: "run-1",
    };
    expect(validateProvenanceRecord(record)).toBeTruthy();
    expect(canonicalJson(record)).toBe(canonicalJson(JSON.parse(JSON.stringify(record))));
  });

  it("rejects the retired duplicate method identity", () => {
    const record = {
      schema: PROVENANCE_SCHEMA,
      packageVersion: "0.1.1",
      methodVersion: "0.7.0",
      schemas: { ...PUBLISHED_SCHEMA_IDS },
      profile: "C2",
      sourceRevision: "rev-1",
      runId: "run-1",
    };
    expect(() => validateProvenanceRecord(record)).toThrow(PublicContractError);
  });

  it("rejects a record missing its run identity", () => {
    const record = {
      schema: PROVENANCE_SCHEMA,
      packageVersion: "0.1.1",
      schemas: {},
      profile: "C2",
      sourceRevision: "rev-1",
    };
    expect(() => validateProvenanceRecord(record)).toThrow(PublicContractError);
  });
});

describe("result validation at the public boundary", () => {
  it("rejects a cast that skips required fields", () => {
    expect(() => validateResult({ schema: "validation-architect/result/v1", verdict: "pass" })).toThrow(
      PublicContractError,
    );
  });

  it("rejects the retired result spelling with a typed unsupported-schema failure", () => {
    // Concatenated so the repository-wide retired-ID detector keeps hunting
    // real writable usages while this negative control stays possible.
    const retired = ["validation-result", "v1"].join("/");
    expect(() => validateResult({ schema: retired })).toThrow(PublicContractError);
  });

  it("distinguishes an unsupported major from an unrelated lookalike schema", () => {
    expect(() => validateResult({ schema: "validation-architect/result/v2" })).toThrowError(
      expect.objectContaining({ code: "unsupported_schema_major" }),
    );
    expect(() => validateResult({ schema: "validation-architect/result-extra/v2" })).toThrowError(
      expect.objectContaining({ code: "invalid_input" }),
    );
  });
});

describe("fake repository port", () => {
  it("is read-only, glob-capable, and traversal-safe", async () => {
    const repo = new FakeRepositoryPort({
      revision: "rev-9",
      files: { "docs/a.md": "A", "tests/x.test.ts": "it()" },
      changed: { "base..head": ["docs/a.md"] },
    });
    expect(await repo.revision()).toBe("rev-9");
    expect(await repo.readFile("docs/a.md")).toBe("A");
    expect(await repo.readFile("docs/missing.md")).toBeNull();
    expect(await repo.listFiles(["tests/**"])).toEqual(["tests/x.test.ts"]);
    expect(await repo.changedPaths("base", "head")).toEqual(["docs/a.md"]);
    await expect(repo.readFile("../etc/passwd")).rejects.toSatisfy((error: unknown) =>
      isPublicContractError(error, "invalid_input"),
    );
  });
});
