import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalRepository } from "../../src/design/local-repository.js";

let tmp: string;
let repo: string;

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "va-design-repo-"));
  repo = join(tmp, "target");
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs", "PRODUCT.md"), "# Product\n");
  writeFileSync(join(repo, "README.md"), "readme\n");
  git(tmp, ["init", "-q", "-b", "main", "target"]);
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("LocalRepository", () => {
  it("binds revision() to the exact product-source commit", async () => {
    const port = new LocalRepository({ root: repo });
    expect(await port.revision()).toBe(git(repo, ["rev-parse", "HEAD"]));
  });

  it("refuses uncommitted product drift but permits a validation-design overlay", async () => {
    writeFileSync(join(repo, "README.md"), "drifted\n");
    await expect(new LocalRepository({ root: repo }).revision()).rejects.toThrow(/uncommitted/);
    writeFileSync(join(repo, "README.md"), "readme\n");
    mkdirSync(join(repo, "validation-design"));
    writeFileSync(join(repo, "validation-design", "README.md"), "overlay\n");
    await expect(new LocalRepository({ root: repo }).revision()).resolves.toBe(git(repo, ["rev-parse", "HEAD"]));
  });

  it("walks through committed design-only changes without self-staling the source revision", async () => {
    const sourceRevision = git(repo, ["rev-parse", "HEAD"]);
    mkdirSync(join(repo, "validation-design"));
    writeFileSync(join(repo, "validation-design", "README.md"), "committed corpus\n");
    git(repo, ["add", "validation-design"]);
    git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "design"]);
    expect(git(repo, ["rev-parse", "HEAD"])).not.toBe(sourceRevision);
    await expect(new LocalRepository({ root: repo }).revision()).resolves.toBe(sourceRevision);
  });

  it("errors when the target is not a git repository", async () => {
    const plain = join(tmp, "plain");
    mkdirSync(plain);
    await expect(new LocalRepository({ root: plain }).revision()).rejects.toThrow(/git/);
  });

  it("reads files and returns null for absent paths", async () => {
    const port = new LocalRepository({ root: repo });
    expect(await port.readFile("docs/PRODUCT.md")).toBe("# Product\n");
    expect(await port.readFile("docs/absent.md")).toBeNull();
  });

  it("rejects traversal, absolute paths, and backslashes", async () => {
    const port = new LocalRepository({ root: repo });
    for (const attempt of ["../outside.txt", "/etc/passwd", "docs/../../escape", "docs\\PRODUCT.md"]) {
      await expect(port.readFile(attempt), attempt).rejects.toThrow(/rejected/);
    }
  });

  it("rejects a symlink that escapes the root and never lists symlinks", async () => {
    writeFileSync(join(tmp, "secret.txt"), "outside\n");
    symlinkSync(join(tmp, "secret.txt"), join(repo, "docs", "leak.txt"));
    const port = new LocalRepository({ root: repo });
    await expect(port.readFile("docs/leak.txt")).rejects.toThrow(/rejected/);
    expect(await port.listFiles(["docs/**"])).toEqual(["docs/PRODUCT.md"]);
  });

  it("lists files by glob, skipping .git and node_modules", async () => {
    mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "dep", "x.test.ts"), "");
    mkdirSync(join(repo, "tests"), { recursive: true });
    writeFileSync(join(repo, "tests", "a.test.ts"), "");
    const port = new LocalRepository({ root: repo });
    expect(await port.listFiles(["tests/**"])).toEqual(["tests/a.test.ts"]);
    expect(await port.listFiles(["**/*.test.ts"])).toEqual(["tests/a.test.ts"]);
  });

  it("answers changedPaths through git diff and refuses unsafe refs", async () => {
    const base = git(repo, ["rev-parse", "HEAD"]);
    writeFileSync(join(repo, "docs", "PRODUCT.md"), "# Product v2\n");
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "change"]);
    const head = git(repo, ["rev-parse", "HEAD"]);
    const port = new LocalRepository({ root: repo });
    expect(await port.changedPaths(base, head)).toEqual(["docs/PRODUCT.md"]);
    expect(await port.changedPaths(head, head)).toEqual([]);
    await expect(port.changedPaths("--upload-pack=/bin/false", head)).rejects.toThrow(/unsafe/);
  });
});
