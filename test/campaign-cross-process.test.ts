import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resume } from "../src/api/campaign-engine.js";
import { FakeRepositoryPort, ScriptedTurnPort } from "../src/api/conformance.js";
import type { TurnResult } from "../src/api/ports.js";
import { FileCampaignStore } from "./file-campaign-store.js";
import { writeValidModel } from "./model-corpus-fixture.js";

/**
 * Independent-process crash matrix (#16): a SEPARATE node process begins a C0
 * campaign against a file-backed CAS store and dies between the pending save
 * and the provider result. This process then resumes from the serialized
 * checkpoint alone and must replay the exact pending idempotency key, spend
 * exactly one logical turn, and finish. No provider or network is involved —
 * the child's TurnPort is a scripted crash.
 */

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const tmp = mkdtempSync(join(tmpdir(), "va-crossproc-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const CHILD_SCRIPT = `
import { design } from "${repoRoot}/src/api/campaign-engine.js";
import { FakeRepositoryPort } from "${repoRoot}/src/api/conformance.js";
import { FileCampaignStore } from "${repoRoot}/test/file-campaign-store.js";

const store = new FileCampaignStore(process.argv[2]);
try {
  await design(
    { runId: "cross-run", profile: "C0", intake: "cross-process fixture" },
    {
      repository: new FakeRepositoryPort({ revision: "rev-x", files: {} }),
      turns: { async runTurn() { throw new Error("child process died mid-turn"); } },
      store,
    },
  );
} catch (error) {
  console.log("CHILD_PARKED: " + error.message);
  process.exit(0);
}
throw new Error("child unexpectedly completed");
`;

function corpusFiles(): Array<{ path: string; content: string }> {
  const dir = join(tmp, "corpus");
  writeValidModel(dir);
  const walk = (root: string, current = root): string[] =>
    readdirSync(current).flatMap((entry) => {
      const path = join(current, entry);
      return statSync(path).isDirectory() ? walk(root, path) : [relative(root, path)];
    });
  return walk(dir).map((path) => ({ path: path.replaceAll("\\", "/"), content: readFileSync(join(dir, path), "utf8") }));
}

describe("independent-process resume", () => {
  it("resumes another process's parked pending turn from the serialized checkpoint alone", { timeout: 120_000 }, () => {
    const storeDir = join(tmp, "store");
    mkdirSync(storeDir, { recursive: true });
    const childPath = join(tmp, "child.mts");
    writeFileSync(childPath, CHILD_SCRIPT);
    const tsx = join(repoRoot, "node_modules", ".bin", "tsx");
    const output = execFileSync(tsx, [childPath, storeDir], { encoding: "utf8" });
    expect(output).toContain("CHILD_PARKED");

    return (async () => {
      const store = new FileCampaignStore(storeDir);
      const parked = await store.load("cross-run");
      expect(parked?.pendingTurn?.idempotencyKey).toBe("cross-run:turn:1");
      expect(parked?.generation).toBe(2);

      const scripted = new ScriptedTurnPort([
        {
          result: (request): TurnResult => {
            expect(request.idempotencyKey).toBe("cross-run:turn:1");
            return {
              status: "ok",
              text: JSON.stringify({ marker: "CAMPAIGN-COMPLETE", files: corpusFiles() }),
              identity: { provider: "anthropic", model: "fable", session: "s-designer" },
              usage: { inputTokens: 1, outputTokens: 1 },
            };
          },
        },
      ]);
      const outcome = await resume("cross-run", {
        repository: new FakeRepositoryPort({ revision: "rev-x", files: {} }),
        turns: scripted,
        store,
      });
      expect(outcome.status).toBe("complete");
      expect(scripted.consumed).toBe(1);
      if (outcome.status === "complete") {
        expect(outcome.bundle.usage.turns).toBe(1);
        expect(outcome.bundle.provenance.sourceRevision).toBe("rev-x");
      }
    })();
  });
});
