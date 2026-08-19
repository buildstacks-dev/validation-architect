import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { design, ScriptedTurnPort } from "validation-architect";
import { main, type CliIo } from "../src/cli.js";
import { LocalCampaignStore } from "../src/local-store.js";
import { LocalRepository } from "../src/local-repository.js";
import { captureRunContext } from "../src/run-context.js";

const root = mkdtempSync(join(tmpdir(), "va-cli-operations-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function collect(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (line) => out.push(line), stderr: (line) => err.push(line) }, out, err };
}

describe("public-checkpoint CLI inspection", () => {
  it("lists and reports a run without loading a provider or legacy state", async () => {
    const target = join(root, "target");
    const stateDirectory = join(root, "state");
    execFileSync("git", ["init", "-q", target]);
    git(target, ["config", "user.email", "test@example.com"]);
    git(target, ["config", "user.name", "Test"]);
    writeFileSync(join(target, "README.md"), "fixture\n");
    git(target, ["add", "README.md"]);
    git(target, ["commit", "-qm", "fixture"]);

    const context = captureRunContext({ runId: "inspect-run", target, stateDirectory, profile: "C0" });
    const store = new LocalCampaignStore({ directory: stateDirectory });
    const outcome = await design(
      { runId: context.runId, profile: "C0", admit: (envelope) => envelope },
      {
        repository: new LocalRepository({ root: context.snapshot }),
        turns: new ScriptedTurnPort([{ result: { status: "error", reason: "offline stop" } }]),
        store,
      },
    );
    expect(outcome).toMatchObject({ status: "incomplete", reason: "turn_error" });

    const listed = collect();
    expect(await main(["list", target, "--state-dir", stateDirectory], listed.io)).toBe(0);
    expect(listed.out.join("\n")).toContain(`inspect-run\tfailed\tC0\t${context.sourceRevision}`);

    const reported = collect();
    expect(await main(["report", "inspect-run", target, "--state-dir", stateDirectory], reported.io)).toBe(0);
    expect(reported.out.join("\n")).toContain("# Validation Architect run inspect-run");
    expect(reported.out.join("\n")).toContain(`Source revision: ${context.sourceRevision}`);
    expect(reported.out.join("\n")).toContain("Status: failed");
    expect(reported.out.join("\n")).toContain("## Transcript projection");
    expect(reported.out.join("\n")).toContain("Turn 1: designer:designer");

    const unknown = collect();
    expect(await main(["repos", target, "--state-dir", stateDirectory], unknown.io)).toBe(0);
    expect(unknown.out.join("\n")).toContain(`${target}\tUNKNOWN\t-`);
  });
});
