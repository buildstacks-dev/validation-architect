import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { design, ScriptedTurnPort, type CampaignCheckpoint, type TurnResult } from "validation-architect";
import { writeValidModel } from "../../test/model-corpus-fixture.js";
import { deliverRun } from "../src/delivery.js";
import { LocalCampaignStore } from "../src/local-store.js";
import { captureRunContext } from "../src/run-context.js";
import { RunRepository } from "../src/run-repository.js";

const root = mkdtempSync(join(tmpdir(), "va-delivery-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function targetRepository(): string {
  const target = join(root, "target");
  execFileSync("git", ["init", "-q", target]);
  git(target, ["config", "user.email", "test@example.com"]);
  git(target, ["config", "user.name", "Test"]);
  writeFileSync(join(target, "README.md"), "one\n");
  git(target, ["add", "README.md"]);
  git(target, ["commit", "-qm", "one"]);
  return target;
}

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

describe("public-checkpoint branch delivery", () => {
  it("lands from the captured base, preserves the checkout, and re-delivers idempotently", async () => {
    const target = targetRepository();
    const stateDirectory = join(root, "state");
    const context = captureRunContext({ runId: "delivery-run", target, stateDirectory, profile: "C0" });
    const store = new LocalCampaignStore({ directory: stateDirectory });
    const result: TurnResult = {
      status: "ok",
      text: JSON.stringify({ marker: "CAMPAIGN-COMPLETE", files: corpusFiles() }),
      identity: { provider: "anthropic", model: "fake", session: "designer-1" },
    };
    expect((await design(
      { runId: context.runId, profile: "C0", admit: (envelope) => envelope },
      {
        repository: new RunRepository({ root: context.snapshot, intakeSource: context.intakeSource }),
        turns: new ScriptedTurnPort([{ result }]),
        store,
      },
    )).status).toBe("complete");
    const checkpoint = await store.load(context.runId) as CampaignCheckpoint;

    writeFileSync(join(target, "README.md"), "two\n");
    git(target, ["add", "README.md"]);
    git(target, ["commit", "-qm", "two"]);
    const checkoutBranch = git(target, ["branch", "--show-current"]);
    const checkoutHead = git(target, ["rev-parse", "HEAD"]);

    const first = deliverRun(context, checkpoint);
    const second = deliverRun(context, checkpoint);
    expect(second).toEqual(first);
    expect(first.branch).toBe("validation-design/delivery-run");
    expect(git(target, ["rev-parse", `${first.commit}^`])).toBe(context.sourceRevision);
    expect(git(target, ["show", `${first.commit}:README.md`])).toBe("one");
    expect(git(target, ["show", `${first.commit}:validation-design/model/project.yaml`])).toContain("validation-architect/model/project/v1");
    expect(git(target, ["branch", "--show-current"])).toBe(checkoutBranch);
    expect(git(target, ["rev-parse", "HEAD"])).toBe(checkoutHead);
    expect(git(target, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
  });
});
