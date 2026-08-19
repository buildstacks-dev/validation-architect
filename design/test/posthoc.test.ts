import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  canonicalCheckpoint,
  design,
  FakeRepositoryPort,
  InMemoryCampaignStore,
  ScriptedTurnPort,
  type CampaignCheckpoint,
  type TurnResult,
} from "validation-architect";
import { writeValidModel } from "../../test/model-corpus-fixture.js";
import { runPostHocAudit, runPostHocReaders } from "../src/posthoc.js";

const root = mkdtempSync(join(tmpdir(), "va-posthoc-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function corpusFiles(): Array<{ path: string; content: string }> {
  const corpus = join(root, "corpus");
  writeValidModel(corpus);
  const walk = (current: string): string[] => readdirSync(current).flatMap((entry) => {
    const path = join(current, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
  return walk(corpus).map((path) => ({
    path: relative(corpus, path).replaceAll("\\", "/"),
    content: readFileSync(path, "utf8"),
  }));
}

async function completedCheckpoint(): Promise<CampaignCheckpoint> {
  const store = new InMemoryCampaignStore();
  const result: TurnResult = {
    status: "ok",
    text: JSON.stringify({ marker: "CAMPAIGN-COMPLETE", files: corpusFiles() }),
    identity: { provider: "anthropic", model: "fake", session: "designer" },
  };
  await design(
    { runId: "posthoc-run", profile: "C0", admit: (envelope) => envelope },
    {
      repository: new FakeRepositoryPort({ revision: "rev-1", files: {} }),
      turns: new ScriptedTurnPort([{ result }]),
      store,
    },
  );
  return await store.load("posthoc-run") as CampaignCheckpoint;
}

describe("post-hoc judgment over a public checkpoint", () => {
  it("runs a fresh audit without mutating campaign transition history", async () => {
    const checkpoint = await completedCheckpoint();
    const before = canonicalCheckpoint(checkpoint);
    const turns = new ScriptedTurnPort([{
      result: {
        status: "ok",
        text: JSON.stringify({ verdict: "reservations", findings: [{ id: "AUD-P1", tier: "minor", title: "Clarify owner evidence" }] }),
        identity: { provider: "anthropic", model: "fake", session: "posthoc-audit-1" },
      },
    }]);
    const result = await runPostHocAudit(checkpoint, turns, root);
    expect(result.output).toMatchObject({ verdict: "reservations" });
    expect(canonicalCheckpoint(checkpoint)).toBe(before);
    expect(turns.consumed).toBe(1);
  });

  it("runs the three fresh reader personas with no campaign mutation", async () => {
    const checkpoint = await completedCheckpoint();
    const before = canonicalCheckpoint(checkpoint);
    const turns = new ScriptedTurnPort(["operator", "new-engineer", "coding-agent"].map((persona) => ({
      result: {
        status: "ok" as const,
        text: JSON.stringify({ findings: [{ id: `R-${persona}`, tier: "minor", title: `${persona} note` }] }),
        identity: { provider: "anthropic", model: "fake", session: `reader-${persona}` },
      },
    })));
    const result = await runPostHocReaders(checkpoint, turns, root);
    expect(result.outputs).toHaveLength(3);
    expect(canonicalCheckpoint(checkpoint)).toBe(before);
    expect(turns.consumed).toBe(3);
  });
});
