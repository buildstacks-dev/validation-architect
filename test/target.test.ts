import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { designerKickoff } from "../src/prompts.js";
import {
  deliverArtifacts,
  existingCorpusDir,
  loadTarget,
  resolveCampaignMode,
} from "../src/target.js";
import { assembleWorkspace } from "../src/workspace.js";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A target product repo: git-initialized, one commit, docs/ + rambling.txt. */
function makeTargetRepo(tmp: string, opts?: { corpus?: boolean }): string {
  const target = join(tmp, "product");
  mkdirSync(join(target, "docs"), { recursive: true });
  writeFileSync(join(target, "docs", "architecture.md"), "# Arch\n");
  writeFileSync(join(target, "rambling.txt"), "half-formed thoughts\n");
  if (opts?.corpus) {
    mkdirSync(join(target, "validation-design"), { recursive: true });
    writeFileSync(join(target, "validation-design", "validation-policy.yaml"), "gates: {}\n");
    writeFileSync(join(target, "validation-design", "invariants.md"), "# Invariants\n\nINV-01\n");
  }
  git(tmp, ["init", "-q", "-b", "main", "product"]);
  git(target, ["add", "-A"]);
  git(target, [
    "-c", "user.name=t", "-c", "user.email=t@t",
    "commit", "-q", "-m", "init",
  ]);
  return target;
}

/** A minimal completed-campaign workspace: just the corpus dir. */
function makeWorkspace(tmp: string): string {
  const ws = join(tmp, "ws");
  mkdirSync(join(ws, "validation-design", "contracts"), { recursive: true });
  writeFileSync(join(ws, "validation-design", "invariants.md"), "# Invariants v2\n");
  writeFileSync(join(ws, "validation-design", "contracts", "b01.md"), "contract\n");
  return ws;
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vda-target-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("loadTarget", () => {
  it("fails closed on a nonexistent path", () => {
    expect(() => loadTarget(join(tmp, "nope"))).toThrow(/not found/);
  });

  it("fails closed on a repo without docs/", () => {
    const bare = join(tmp, "bare");
    mkdirSync(bare, { recursive: true });
    expect(() => loadTarget(bare)).toThrow(/no docs\//);
  });

  it("loads a repo with docs/ and detects rambling.txt", () => {
    const target = makeTargetRepo(tmp);
    const info = loadTarget(target);
    expect(info.name).toBe("product");
    expect(info.displayName).toBe("product");
    expect(info.dir).toBe(target);
    expect(info.hasRambling).toBe(true);
  });
});

describe("campaign mode resolution", () => {
  it("greenfield when the target carries no corpus", () => {
    const target = makeTargetRepo(tmp);
    expect(existingCorpusDir(target)).toBeUndefined();
    expect(resolveCampaignMode(target, false)).toBe("greenfield");
  });

  it("revision by default when validation-policy.yaml exists", () => {
    const target = makeTargetRepo(tmp, { corpus: true });
    expect(existingCorpusDir(target)).toBe(join(target, "validation-design"));
    expect(resolveCampaignMode(target, false)).toBe("revision");
  });

  it("--fresh opts out of revision even when a corpus exists", () => {
    const target = makeTargetRepo(tmp, { corpus: true });
    expect(resolveCampaignMode(target, true)).toBe("greenfield");
  });
});

describe("workspace seeding (revision baseline)", () => {
  it("copies the target's existing corpus in as the baseline", () => {
    const target = makeTargetRepo(tmp, { corpus: true });
    const runDir = join(tmp, "run");
    mkdirSync(runDir, { recursive: true });
    const ws = assembleWorkspace(repoRoot, loadTarget(target), runDir, {
      seedCorpusFrom: join(target, "validation-design"),
    });
    expect(readFileSync(join(ws, "validation-design", "invariants.md"), "utf8")).toContain("INV-01");
    expect(existsSync(join(ws, "validation-design", "validation-policy.yaml"))).toBe(true);
    // docs and rambling still mount from the target
    expect(existsSync(join(ws, "docs", "architecture.md"))).toBe(true);
    expect(existsSync(join(ws, "rambling.txt"))).toBe(true);
  });

  it("starts empty without a seed (greenfield unchanged)", () => {
    const target = makeTargetRepo(tmp);
    const runDir = join(tmp, "run");
    mkdirSync(runDir, { recursive: true });
    const ws = assembleWorkspace(repoRoot, loadTarget(target), runDir);
    expect(existsSync(join(ws, "validation-design"))).toBe(true);
    expect(existsSync(join(ws, "validation-design", "validation-policy.yaml"))).toBe(false);
  });
});

describe("designerKickoff revision variant", () => {
  const info = { name: "p", dir: "/x", displayName: "p", hasRambling: true };

  it("greenfield runs the full workflow", () => {
    const k = designerKickoff(info, "greenfield");
    expect(k).toContain("Phase 0 through Phase 8");
    expect(k).toContain("Scope mode: product.");
    expect(k).not.toContain("harness-revision");
  });

  it("revision enters harness-revision mode, never a from-scratch Phase 0", () => {
    const k = designerKickoff(info, "revision");
    expect(k).toContain("Scope mode: harness-revision.");
    expect(k).toContain("baseline");
    expect(k).toContain("reopen ONLY the concepts the diff affects");
    expect(k).toContain("retired invariants keep their IDs");
    expect(k).not.toContain("Run the full workflow: Phase 0 through Phase 8");
    // the shared machinery survives the mode switch
    expect(k).toContain("case-catalog.yaml");
    expect(k).toContain("<<CAMPAIGN-COMPLETE>>");
  });

  it("defaults to greenfield (existing callers unchanged)", () => {
    expect(designerKickoff(info)).toContain("Phase 0 through Phase 8");
  });
});

describe("deliverArtifacts", () => {
  it("fails closed when the target is not a git repo", () => {
    const ws = makeWorkspace(tmp);
    const notRepo = join(tmp, "plain");
    mkdirSync(notRepo, { recursive: true });
    expect(() => deliverArtifacts({ workspace: ws, target: notRepo, runId: "r1" })).toThrow(
      /not a git repository/,
    );
  });

  it("fails closed when the target repo has no commits", () => {
    const ws = makeWorkspace(tmp);
    const empty = join(tmp, "empty");
    mkdirSync(empty, { recursive: true });
    git(tmp, ["init", "-q", "-b", "main", "empty"]);
    expect(() => deliverArtifacts({ workspace: ws, target: empty, runId: "r1" })).toThrow(
      /no commits/,
    );
  });

  it("fails closed when the workspace has nothing to deliver", () => {
    const target = makeTargetRepo(tmp);
    const bareWs = join(tmp, "bare-ws");
    mkdirSync(join(bareWs, "validation-design"), { recursive: true });
    expect(() => deliverArtifacts({ workspace: bareWs, target, runId: "r1" })).toThrow(
      /Nothing to deliver/,
    );
  });

  it("lands the corpus on a branch without touching the user's checkout", () => {
    const target = makeTargetRepo(tmp);
    const ws = makeWorkspace(tmp);
    const headBefore = git(target, ["rev-parse", "HEAD"]).trim();

    const res = deliverArtifacts({ workspace: ws, target, runId: "run-42" });

    expect(res.branch).toBe("validation-design/run-42");
    // branch carries the corpus
    const files = git(target, ["ls-tree", "-r", "--name-only", res.branch]).trim().split("\n");
    expect(files).toContain("validation-design/invariants.md");
    expect(files).toContain("validation-design/contracts/b01.md");
    // the user's checkout is untouched: same branch, same HEAD, clean tree,
    // no validation-design/ materialized in the working tree
    expect(git(target, ["branch", "--show-current"]).trim()).toBe("main");
    expect(git(target, ["rev-parse", "HEAD"]).trim()).toBe(headBefore);
    expect(git(target, ["status", "--porcelain"]).trim()).toBe("");
    expect(existsSync(join(target, "validation-design"))).toBe(false);
    // no stray worktrees left behind
    expect(git(target, ["worktree", "list"]).trim().split("\n")).toHaveLength(1);
  });

  it("re-delivery is idempotent and updates the same branch", () => {
    const target = makeTargetRepo(tmp);
    const ws = makeWorkspace(tmp);
    const first = deliverArtifacts({ workspace: ws, target, runId: "run-42" });
    // unchanged corpus: no new commit
    const again = deliverArtifacts({ workspace: ws, target, runId: "run-42" });
    expect(again.commit).toBe(first.commit);
    // changed corpus (edit + deletion): same branch, new commit, deletion propagates
    writeFileSync(join(ws, "validation-design", "invariants.md"), "# Invariants v3\n");
    rmSync(join(ws, "validation-design", "contracts", "b01.md"));
    const third = deliverArtifacts({ workspace: ws, target, runId: "run-42" });
    expect(third.branch).toBe(first.branch);
    expect(third.commit).not.toBe(first.commit);
    const files = git(target, ["ls-tree", "-r", "--name-only", third.branch]).trim().split("\n");
    expect(files).toContain("validation-design/invariants.md");
    expect(files).not.toContain("validation-design/contracts/b01.md");
    expect(git(target, ["show", `${third.branch}:validation-design/invariants.md`])).toContain("v3");
  });

  it("delivery onto a target that already carries a ratified corpus replaces it on the branch only", () => {
    const target = makeTargetRepo(tmp, { corpus: true });
    const ws = makeWorkspace(tmp);
    const res = deliverArtifacts({ workspace: ws, target, runId: "rev-1" });
    // the branch has the new corpus (old policy file is gone there)
    const files = git(target, ["ls-tree", "-r", "--name-only", res.branch]).trim().split("\n");
    expect(files).not.toContain("validation-design/validation-policy.yaml");
    expect(files).toContain("validation-design/invariants.md");
    // main still has the old ratified corpus untouched
    const mainFiles = git(target, ["ls-tree", "-r", "--name-only", "main"]).trim().split("\n");
    expect(mainFiles).toContain("validation-design/validation-policy.yaml");
  });
});
