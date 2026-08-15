import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FakeRepositoryPort,
  ScriptedTurnPort,
  buildEnvelope,
  design,
  isPublicContractError,
  okTurn,
  resume,
  type CampaignCheckpoint,
} from "validation-architect";
import { writeValidModel } from "../../test/model-corpus-fixture.js";
import { LocalCampaignStore } from "../src/local-store.js";

let tmp: string;
let store: LocalCampaignStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "va-design-store-"));
  store = new LocalCampaignStore({ directory: join(tmp, "state") });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function checkpoint(runId: string, generation: number): CampaignCheckpoint {
  return {
    schema: "validation-architect/design-run/v1",
    kind: "checkpoint",
    runId,
    generation,
    packageVersion: "0.1.1",
    sourceRevision: "rev-1",
    envelope: buildEnvelope({ runId, profile: "C0", intake: "intake" }, "rev-1"),
    position: "start",
    receipts: [],
    sessions: {},
    artifacts: {},
    intake: "intake",
    usage: { turns: 0, inputTokens: 0, outputTokens: 0 },
  };
}

describe("LocalCampaignStore compare-and-swap", () => {
  it("round-trips a validated checkpoint through the filesystem", async () => {
    await store.save(checkpoint("run-a", 1), 0);
    const loaded = await store.load("run-a");
    expect(loaded?.generation).toBe(1);
    expect(loaded?.envelope.profile).toBe("C0");
    expect(await store.load("absent")).toBeNull();
  });

  it("raises the typed stale_generation conflict instead of overwriting", async () => {
    await store.save(checkpoint("run-a", 1), 0);
    await store.save(checkpoint("run-a", 2), 1);
    try {
      await store.save(checkpoint("run-a", 2), 1);
      expect.unreachable("stale save must not be accepted");
    } catch (error) {
      expect(isPublicContractError(error, "stale_generation")).toBe(true);
    }
    expect((await store.load("run-a"))?.generation).toBe(2);
  });

  it("requires the next generation to extend the expected one exactly", async () => {
    await store.save(checkpoint("run-a", 1), 0);
    await expect(store.save(checkpoint("run-a", 3), 1)).rejects.toSatisfy((error) =>
      isPublicContractError(error, "invalid_checkpoint"),
    );
  });

  it("refuses unsafe run ids and rejects a corrupt checkpoint file on load", async () => {
    await expect(store.load("../escape")).rejects.toSatisfy((error) =>
      isPublicContractError(error, "invalid_checkpoint"),
    );
    writeFileSync(join(store.directory, "broken.json"), "{not json");
    await expect(store.load("broken")).rejects.toSatisfy((error) => isPublicContractError(error, "invalid_input"));
  });
});

describe("crash reconciliation through the campaign engine", () => {
  function corpusFiles(): Array<{ path: string; content: string }> {
    const dir = join(tmp, "corpus");
    writeValidModel(dir);
    const walk = (root: string, current = root): string[] =>
      readdirSync(current).flatMap((entry) => {
        const path = join(current, entry);
        return statSync(path).isDirectory() ? walk(root, path) : [relative(root, path)];
      });
    return walk(dir).map((path) => ({
      path: path.replaceAll("\\", "/"),
      content: readFileSync(join(dir, path), "utf8"),
    }));
  }

  it("a parked pending turn is replayed by idempotency key without a second spend", async () => {
    const repository = new FakeRepositoryPort({ revision: "rev-x", files: {} });
    // Process one: dies mid-turn AFTER the pending save.
    await expect(
      design(
        { runId: "run-crash", profile: "C0", intake: "fixture" },
        {
          repository,
          turns: {
            async runTurn() {
              throw new Error("process died mid-turn");
            },
          },
          store,
        },
      ),
    ).rejects.toThrow(/died mid-turn/);

    const parked = await store.load("run-crash");
    expect(parked?.pendingTurn?.idempotencyKey).toBe("run-crash:turn:1");

    // Process two: resumes from the serialized checkpoint alone and must
    // replay the exact pending key, spending exactly one logical turn.
    const identity = { provider: "anthropic", model: "m", session: "sess-1" };
    const scripted = new ScriptedTurnPort([
      {
        expect: { seat: "designer", sessionMode: "new" },
        result: okTurn(JSON.stringify({ marker: "CAMPAIGN-COMPLETE", files: corpusFiles() }), identity),
      },
    ]);
    const outcome = await resume("run-crash", { repository, turns: scripted, store });
    expect(outcome.status).toBe("complete");
    expect(scripted.consumed).toBe(1);
    expect(scripted.requests[0]?.idempotencyKey).toBe("run-crash:turn:1");

    // A third process re-resuming the settled run spends nothing further.
    const again = await resume("run-crash", { repository, turns: scripted, store });
    expect(again.status).toBe("complete");
    expect(scripted.consumed).toBe(1);
  });
});
