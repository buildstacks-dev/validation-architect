import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliLocalRepository } from "../src/cli-local-repository.js";

let tmp: string;
let repo: string;

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "va-cli-repo-"));
  repo = join(tmp, "target");
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs", "PRODUCT.md"), "# Product\n");
  git(tmp, ["init", "-q", "-b", "main", "target"]);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "source"]);
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("CliLocalRepository product revision", () => {
  it("keeps the exact source commit across uncommitted and committed corpus overlays", async () => {
    const sourceRevision = git(repo, ["rev-parse", "HEAD"]);
    mkdirSync(join(repo, "validation-design"));
    writeFileSync(join(repo, "validation-design", "README.md"), "corpus\n");
    await expect(new CliLocalRepository(repo).revision()).resolves.toBe(sourceRevision);

    git(repo, ["add", "validation-design"]);
    git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "design"]);
    expect(git(repo, ["rev-parse", "HEAD"])).not.toBe(sourceRevision);
    await expect(new CliLocalRepository(repo).revision()).resolves.toBe(sourceRevision);
  });

  it("refuses uncommitted product drift and advances after a product commit", async () => {
    const before = git(repo, ["rev-parse", "HEAD"]);
    writeFileSync(join(repo, "docs", "PRODUCT.md"), "# Product v2\n");
    await expect(new CliLocalRepository(repo).revision()).rejects.toThrow(/exact source revision/);

    git(repo, ["add", "docs/PRODUCT.md"]);
    git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "product"]);
    const after = git(repo, ["rev-parse", "HEAD"]);
    expect(after).not.toBe(before);
    await expect(new CliLocalRepository(repo).revision()).resolves.toBe(after);
  });
});
