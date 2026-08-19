import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ScriptedTurnPort } from "validation-architect";
import { writeValidModel } from "../../test/model-corpus-fixture.js";
import { runFidelity } from "../src/fidelity.js";

const root = mkdtempSync(join(tmpdir(), "va-design-fidelity-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function targetRepository(name: string): string {
  const target = join(root, name);
  execFileSync("git", ["init", "-q", target]);
  git(target, ["config", "user.email", "test@example.com"]);
  git(target, ["config", "user.name", "Test"]);
  mkdirSync(join(target, "docs"), { recursive: true });
  mkdirSync(join(target, "tests"), { recursive: true });
  writeFileSync(join(target, "docs", "PRODUCT.md"), "# Contract\n\nStable fixture.\n");
  writeFileSync(join(target, "tests", "fixture.test.ts"), "// Family: CF-X01-S\n// Ticket: HB-001\nit('holds', () => {});\n");
  git(target, ["add", "."]);
  git(target, ["commit", "-qm", "source"]);
  writeValidModel(target, git(target, ["rev-parse", "HEAD"]));
  git(target, ["add", "validation-design"]);
  git(target, ["commit", "-qm", "design"]);
  return target;
}

describe("findings-only fidelity through LocalTurnPort contract", () => {
  it("preflights closure, audits a remote-free snapshot, and writes evidence", async () => {
    const target = targetRepository("target");
    const stateDirectory = join(root, "state");
    let workspace = "";
    const result = await runFidelity({ target, stateDirectory, operationId: "fid-1", scope: { wave: 1 } }, (captured) => {
      workspace = captured;
      expect(captured).not.toBe(target);
      expect(git(captured, ["remote"])).toBe("");
      return new ScriptedTurnPort([{
        result: {
          status: "ok",
          text: JSON.stringify({ verdict: "reservations", findings: [{ id: "FID-1", tier: "significant", title: "Seed is not falsified" }] }),
          identity: { provider: "anthropic", model: "fake", session: "fidelity-1" },
        },
      }]);
    });
    expect(workspace).not.toBe("");
    expect(result.output).toMatchObject({ verdict: "reservations" });
    expect(existsSync(result.path)).toBe(true);
    expect(git(target, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
  });

  it("refuses a dirty target before constructing a turn", async () => {
    const target = targetRepository("dirty-target");
    writeFileSync(join(target, "dirty.txt"), "dirty\n");
    let constructed = false;
    await expect(runFidelity({ target, stateDirectory: join(root, "dirty-state"), operationId: "fid-dirty" }, () => {
      constructed = true;
      return new ScriptedTurnPort([]);
    })).rejects.toThrow(/clean/);
    expect(constructed).toBe(false);
  });
});
