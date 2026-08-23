import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureRunContext, listRunContexts, loadRunContext } from "../../src/design/run-context.js";
import { LocalRepository } from "../../src/design/local-repository.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function targetRepository(): string {
  const target = mkdtempSync(join(tmpdir(), "va-run-target-"));
  roots.push(target);
  git(target, ["init", "-q"]);
  git(target, ["config", "user.email", "test@example.com"]);
  git(target, ["config", "user.name", "Test"]);
  writeFileSync(join(target, "README.md"), "one\n");
  git(target, ["add", "README.md"]);
  git(target, ["commit", "-qm", "one"]);
  return target;
}

describe("immutable public-engine run context", () => {
  it("captures one remote-free revision and reloads it after the user checkout advances", async () => {
    const target = targetRepository();
    const stateDirectory = mkdtempSync(join(tmpdir(), "va-run-state-"));
    roots.push(stateDirectory);
    const captured = captureRunContext({ runId: "run-1", target, stateDirectory, profile: "C2" });
    expect(captured.sourceRevision).toBe(git(target, ["rev-parse", "HEAD"]));
    expect(git(captured.snapshot, ["remote"])).toBe("");
    expect(readFileSync(join(captured.snapshot, "README.md"), "utf8")).toBe("one\n");

    writeFileSync(join(target, "README.md"), "two\n");
    git(target, ["add", "README.md"]);
    git(target, ["commit", "-qm", "two"]);

    const reloaded = loadRunContext(stateDirectory, "run-1");
    expect(reloaded).toEqual(captured);
    expect(listRunContexts(stateDirectory)).toEqual([captured]);
    expect(await new LocalRepository({ root: reloaded.snapshot }).revision()).toBe(captured.sourceRevision);
    expect(readFileSync(join(reloaded.snapshot, "README.md"), "utf8")).toBe("one\n");
  });

  it("refuses a dirty target before creating run metadata", () => {
    const target = targetRepository();
    const stateDirectory = mkdtempSync(join(tmpdir(), "va-run-state-"));
    roots.push(stateDirectory);
    writeFileSync(join(target, "dirty.txt"), "dirty\n");
    expect(() => captureRunContext({ runId: "run-dirty", target, stateDirectory, profile: "C0" })).toThrow(/clean/);
    expect(() => loadRunContext(stateDirectory, "run-dirty")).toThrow(/no run metadata/);
  });
});
