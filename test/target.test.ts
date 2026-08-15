import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { designerKickoff } from "../src/prompts.js";
import {
  captureTargetBase,
  deliverArtifacts,
  existingCorpusDir,
  loadTarget,
  recoverTargetBaseFromWorkspace,
  resolveCampaignMode,
  verifyTargetSnapshot,
} from "../src/target.js";
import type { RunState } from "../src/types.js";
import {
  applyLegacyTargetRecovery,
  assembleWorkspace,
  reanchorLegacyTargetWorkspace,
} from "../src/workspace.js";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A target product repo: git-initialized, one commit, docs/ + rambling.txt. */
function makeTargetRepo(tmp: string, opts?: { corpus?: boolean }): string {
  const target = join(tmp, "product");
  mkdirSync(join(target, "docs"), { recursive: true });
  mkdirSync(join(target, "src"), { recursive: true });
  writeFileSync(join(target, "docs", "architecture.md"), "# Arch\n");
  writeFileSync(join(target, "src", "index.ts"), "export const revision = 1;\n");
  writeFileSync(join(target, "service.config.json"), '{"mode":"safe"}\n');
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

  it("loads a repo WITHOUT rambling.txt — the file is optional, never a hard requirement (issue #14)", () => {
    const target = makeTargetRepo(tmp);
    rmSync(join(target, "rambling.txt"));
    const info = loadTarget(target);
    expect(info.name).toBe("product");
    expect(info.hasRambling).toBe(false);
  });
});

describe("captured target revision", () => {
  it("records HEAD/tree digests and refuses dirty or untracked campaign inputs", () => {
    const target = makeTargetRepo(tmp);
    const base = captureTargetBase(target);
    expect(base.commit).toBe(git(target, ["rev-parse", "HEAD"]).trim());
    expect(base.sourceTree).toBe(git(target, ["rev-parse", "HEAD^{tree}"]).trim());
    expect(base.docsTree).toBe(git(target, ["rev-parse", "HEAD:docs"]).trim());
    expect(base.dirty).toBe(false);

    writeFileSync(join(target, "src", "uncommitted.ts"), "export {};\n");
    expect(() => captureTargetBase(target)).toThrow(/uncommitted or untracked/);
  });

  it("fails before a live campaign can spend quota on a non-git target", () => {
    const plain = join(tmp, "plain-target");
    mkdirSync(join(plain, "docs"), { recursive: true });
    writeFileSync(join(plain, "docs", "readme.md"), "# docs\n");
    expect(() => captureTargetBase(plain)).toThrow(/not a git repository/);
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

  it("revision by default when the current checked model exists", () => {
    const target = makeTargetRepo(tmp);
    mkdirSync(join(target, "validation-design", "model"), { recursive: true });
    writeFileSync(join(target, "validation-design", "model", "project.yaml"), "schema: validation-architect/model/project/v1\n");
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
    const targetBase = captureTargetBase(target);
    const runDir = join(tmp, "run");
    mkdirSync(runDir, { recursive: true });
    const ws = assembleWorkspace(repoRoot, loadTarget(target), runDir, {
      seedCorpusFrom: join(target, "validation-design"),
      targetBase,
    });
    expect(readFileSync(join(ws, "validation-design", "invariants.md"), "utf8")).toContain("INV-01");
    expect(existsSync(join(ws, "validation-design", "validation-policy.yaml"))).toBe(true);
    // docs and rambling still mount from the target
    expect(existsSync(join(ws, "docs", "architecture.md"))).toBe(true);
    expect(existsSync(join(ws, "rambling.txt"))).toBe(true);
    // Source/config/history are available inside an independent frozen clone.
    expect(readFileSync(join(ws, "target-source", "src", "index.ts"), "utf8")).toContain("revision = 1");
    expect(readFileSync(join(ws, "target-source", "service.config.json"), "utf8")).toContain("safe");
    expect(git(join(ws, "target-source"), ["rev-parse", "HEAD"]).trim()).toBe(targetBase.commit);
    expect(git(join(ws, "target-source"), ["remote"]).trim()).toBe("");
    expect(readFileSync(join(ws, "TARGET-SNAPSHOT.md"), "utf8")).toContain(targetBase.commit);
    expect(verifyTargetSnapshot(ws, targetBase)).toBe(join(ws, "target-source"));
  });

  it("never fabricates a rambling.txt in the workspace when the target has none (issue #14)", () => {
    const target = makeTargetRepo(tmp);
    rmSync(join(target, "rambling.txt"));
    git(target, ["add", "-A"]);
    git(target, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "no rambling"]);
    const targetBase = captureTargetBase(target);
    const runDir = join(tmp, "run");
    mkdirSync(runDir, { recursive: true });
    const ws = assembleWorkspace(repoRoot, loadTarget(target), runDir, { targetBase });
    expect(existsSync(join(ws, "docs", "architecture.md"))).toBe(true);
    expect(existsSync(join(ws, "rambling.txt"))).toBe(false);
    expect(existsSync(join(ws, "target-source"))).toBe(true);
  });

  it("starts empty without a seed (greenfield unchanged)", () => {
    const target = makeTargetRepo(tmp);
    const targetBase = captureTargetBase(target);
    const runDir = join(tmp, "run");
    mkdirSync(runDir, { recursive: true });
    const ws = assembleWorkspace(repoRoot, loadTarget(target), runDir, { targetBase });
    expect(existsSync(join(ws, "validation-design"))).toBe(true);
    expect(existsSync(join(ws, "validation-design", "validation-policy.yaml"))).toBe(false);
  });

  it("uses the captured commit even when the target advances before assembly", () => {
    const target = makeTargetRepo(tmp);
    const targetBase = captureTargetBase(target);
    writeFileSync(join(target, "docs", "architecture.md"), "# Arch v2\n");
    writeFileSync(join(target, "src", "index.ts"), "export const revision = 2;\n");
    git(target, ["add", "-A"]);
    git(target, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "advance target"]);

    const runDir = join(tmp, "run");
    mkdirSync(runDir, { recursive: true });
    const ws = assembleWorkspace(repoRoot, loadTarget(target), runDir, { targetBase });
    expect(readFileSync(join(ws, "docs", "architecture.md"), "utf8")).toBe("# Arch\n");
    expect(readFileSync(join(ws, "target-source", "src", "index.ts"), "utf8")).toContain("revision = 1");
  });

  it("detects any mutation of the source-evidence snapshot", () => {
    const target = makeTargetRepo(tmp);
    const targetBase = captureTargetBase(target);
    const runDir = join(tmp, "run");
    mkdirSync(runDir, { recursive: true });
    const ws = assembleWorkspace(repoRoot, loadTarget(target), runDir, { targetBase });
    writeFileSync(join(ws, "target-source", "src", "index.ts"), "export const revision = 999;\n");
    expect(() => verifyTargetSnapshot(ws, targetBase)).toThrow(/snapshot drifted/);
    expect(readFileSync(join(target, "src", "index.ts"), "utf8")).toContain("revision = 1");
  });

  it("recovers missing additive state only from self-consistent frozen evidence", () => {
    const target = makeTargetRepo(tmp);
    const targetBase = captureTargetBase(target);
    const runDir = join(tmp, "recover-evidence");
    mkdirSync(runDir, { recursive: true });
    const ws = assembleWorkspace(repoRoot, loadTarget(target), runDir, { targetBase });

    expect(recoverTargetBaseFromWorkspace(ws)).toEqual(targetBase);
    writeFileSync(
      join(ws, "TARGET-SNAPSHOT.md"),
      readFileSync(join(ws, "TARGET-SNAPSHOT.md"), "utf8").replace(
        "Dirty at capture: no",
        "Dirty at capture: yes",
      ),
    );
    expect(() => recoverTargetBaseFromWorkspace(ws)).toThrow(/cannot prove a clean immutable base/);
  });

  it("explicitly re-anchors legacy state without losing corpus, ramble, or pending work", () => {
    const target = makeTargetRepo(tmp);
    writeFileSync(join(target, "src", "index.ts"), "export const revision = 2;\n");
    rmSync(join(target, "rambling.txt"));
    git(target, ["add", "-A"]);
    git(target, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "current recovery base"]);
    const current = git(target, ["rev-parse", "HEAD"]).trim();

    const legacyWorkspace = makeWorkspace(tmp);
    writeFileSync(join(legacyWorkspace, "rambling.txt"), "legacy operator context\n");
    writeFileSync(join(legacyWorkspace, "TARGET-SNAPSHOT.md"), "# corrupt partial legacy evidence\n");
    writeFileSync(join(legacyWorkspace, "validation-design", "source-provenance.json"), "{ malformed\n");
    for (const staleSurface of ["ratification-package.md", "owner-briefing.md", "owner-backlog.md"]) {
      writeFileSync(join(legacyWorkspace, "validation-design", staleSurface), `# stale ${staleSurface}\n\n## Audit\nold\n`);
    }
    mkdirSync(join(legacyWorkspace, "validation-design", "audit"), { recursive: true });
    writeFileSync(join(legacyWorkspace, "validation-design", "audit", "audit-report-1.md"), "old audit\n");
    const runDir = join(tmp, "legacy-run");
    mkdirSync(runDir, { recursive: true });
    const state = {
      runId: "legacy-1",
      fixture: "product",
      workspace: legacyWorkspace,
      status: "completed",
      statusReason: "old completion",
      exchanges: 42,
      seq: 8,
      designerSessionId: "old-designer",
      codexThreadId: "old-owner",
      pending: { to: "stakeholder", text: "do not lose this interrupted owner turn" },
      readersRan: true,
      readerReviewFingerprint: "old-reader",
      audit: { phase: "done" },
      gateRejections: { catalog: 2 },
      target,
      campaignMode: "greenfield",
      delivery: {
        branch: "validation-design/legacy-1",
        commit: "old",
        deliveredAt: "2025-01-01T00:00:00Z",
      },
      startedAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
      config: {
        fixture: "product",
        runId: "legacy-1",
        designerModel: "designer",
        stakeholderModel: "stakeholder",
        readerModel: "reader",
        claudeAuth: "subscription",
        codexAuth: "chatgpt",
        maxExchanges: 50,
        maxWallMinutes: 60,
        designerMaxTurns: 10,
      },
    } as RunState;

    const recovery = reanchorLegacyTargetWorkspace(repoRoot, runDir, state);
    expect(recovery.workspace).not.toBe(legacyWorkspace);
    expect(existsSync(join(legacyWorkspace, "validation-design", "invariants.md"))).toBe(true);
    expect(readFileSync(join(recovery.workspace, "validation-design", "invariants.md"), "utf8")).toContain("v2");
    expect(existsSync(join(legacyWorkspace, "validation-design", "ratification-package.md"))).toBe(true);
    for (const staleSurface of ["ratification-package.md", "owner-briefing.md", "owner-backlog.md"]) {
      expect(existsSync(join(recovery.workspace, "validation-design", staleSurface))).toBe(false);
    }
    expect(existsSync(join(recovery.workspace, "validation-design", "audit"))).toBe(false);
    expect(existsSync(join(recovery.workspace, "validation-design", "source-provenance.json"))).toBe(false);
    expect(readFileSync(join(recovery.workspace, "rambling.txt"), "utf8")).toBe("legacy operator context\n");
    expect(loadTarget(join(recovery.workspace, "target-source")).hasRambling).toBe(false);
    expect(git(join(recovery.workspace, "target-source"), ["rev-parse", "HEAD"]).trim()).toBe(current);
    expect(git(join(recovery.workspace, "target-source"), ["remote"]).trim()).toBe("");
    expect(recovery.recoveryDirective).toContain("mandatory reconciliation");
    expect(recovery.recoveryDirective).toContain("do not lose this interrupted owner turn");

    applyLegacyTargetRecovery(state, recovery, new Date("2026-08-09T00:00:00Z"));
    expect(state).toMatchObject({
      workspace: recovery.workspace,
      targetBase: recovery.targetBase,
      deliveryBranch: `validation-design/legacy-1-recovered-${current.slice(0, 12)}`,
      campaignMode: "revision",
      status: "running",
      exchanges: 0,
      readersRan: false,
      startedAt: "2026-08-09T00:00:00.000Z",
    });
    expect(state.pending).toBeUndefined();
    expect(state.sourceRecoveryDirective).toContain("do not lose this interrupted owner turn");
    expect(state.designerSessionId).toBeUndefined();
    expect(state.codexThreadId).toBeUndefined();
    expect(state.readerReviewFingerprint).toBeUndefined();
    expect(state.audit).toBeUndefined();
    expect(state.delivery).toBeUndefined();
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
    expect(k).toContain("model/families.yaml");
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
    const base = captureTargetBase(target);
    const headBefore = git(target, ["rev-parse", "HEAD"]).trim();

    const res = deliverArtifacts({
      workspace: ws,
      target,
      runId: "run-42",
      baseCommit: base.commit,
      sourceTree: base.sourceTree,
      docsTree: base.docsTree,
      capturedAt: base.capturedAt,
    });

    expect(res.branch).toBe("validation-design/run-42");
    expect(res.corpusTree).toBe(
      git(target, ["rev-parse", `${res.branch}:validation-design`]).trim(),
    );
    // branch carries the corpus
    const files = git(target, ["ls-tree", "-r", "--name-only", res.branch]).trim().split("\n");
    expect(files).toContain("validation-design/invariants.md");
    expect(files).toContain("validation-design/contracts/b01.md");
    expect(files).toContain("validation-design/enablement/INSTALL.md");
    expect(files).toContain("validation-design/enablement/skills/implement-harness-ticket/SKILL.md");
    const provenance = JSON.parse(
      git(target, ["show", `${res.branch}:validation-design/source-provenance.json`]),
    ) as Record<string, unknown>;
    expect(provenance).toMatchObject({
      schema: "validation-architect/source-provenance/v1",
      runId: "run-42",
      baseCommit: base.commit,
      sourceTree: base.sourceTree,
      capturedAt: base.capturedAt,
    });
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
    const base = captureTargetBase(target);
    const delivery = {
      workspace: ws,
      target,
      runId: "run-42",
      baseCommit: base.commit,
      sourceTree: base.sourceTree,
      docsTree: base.docsTree,
      capturedAt: base.capturedAt,
    };
    const first = deliverArtifacts(delivery);
    // unchanged corpus: no new commit
    const again = deliverArtifacts(delivery);
    expect(again.commit).toBe(first.commit);
    // changed corpus (edit + deletion): same branch, new commit, deletion propagates
    writeFileSync(join(ws, "validation-design", "invariants.md"), "# Invariants v3\n");
    rmSync(join(ws, "validation-design", "contracts", "b01.md"));
    const third = deliverArtifacts(delivery);
    expect(third.branch).toBe(first.branch);
    expect(third.commit).not.toBe(first.commit);
    const files = git(target, ["ls-tree", "-r", "--name-only", third.branch]).trim().split("\n");
    expect(files).toContain("validation-design/invariants.md");
    expect(files).not.toContain("validation-design/contracts/b01.md");
    expect(git(target, ["show", `${third.branch}:validation-design/invariants.md`])).toContain("v3");
  });

  it("uses an exact safe recovery branch override and rejects unsafe branch names", () => {
    const target = makeTargetRepo(tmp);
    const ws = makeWorkspace(tmp);
    const base = captureTargetBase(target);
    const common = {
      workspace: ws,
      target,
      runId: "legacy-1",
      baseCommit: base.commit,
      sourceTree: base.sourceTree,
      docsTree: base.docsTree,
      capturedAt: base.capturedAt,
    };
    expect(() => deliverArtifacts({ ...common, branch: "refs/heads/escape" })).toThrow(
      /Invalid delivery branch/,
    );
    expect(git(target, ["branch", "--list", "refs/heads/escape"]).trim()).toBe("");

    const branch = `validation-design/legacy-1-recovered-${base.commit.slice(0, 12)}`;
    const delivered = deliverArtifacts({ ...common, branch });
    expect(delivered.branch).toBe(branch);
    expect(git(target, ["rev-parse", branch]).trim()).toBe(delivered.commit);
  });

  it("delivery onto a target that already carries a ratified corpus replaces it on the branch only", () => {
    const target = makeTargetRepo(tmp, { corpus: true });
    const ws = makeWorkspace(tmp);
    const base = captureTargetBase(target);
    const res = deliverArtifacts({
      workspace: ws,
      target,
      runId: "rev-1",
      baseCommit: base.commit,
      sourceTree: base.sourceTree,
      docsTree: base.docsTree,
      capturedAt: base.capturedAt,
    });
    // the branch has the new corpus (old policy file is gone there)
    const files = git(target, ["ls-tree", "-r", "--name-only", res.branch]).trim().split("\n");
    expect(files).not.toContain("validation-design/validation-policy.yaml");
    expect(files).toContain("validation-design/invariants.md");
    // main still has the old ratified corpus untouched
    const mainFiles = git(target, ["ls-tree", "-r", "--name-only", "main"]).trim().split("\n");
    expect(mainFiles).toContain("validation-design/validation-policy.yaml");
  });

  it("bases delivery on the captured commit even when target HEAD advances", () => {
    const target = makeTargetRepo(tmp);
    const ws = makeWorkspace(tmp);
    const base = captureTargetBase(target);
    writeFileSync(join(target, "src", "index.ts"), "export const revision = 2;\n");
    git(target, ["add", "-A"]);
    git(target, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "source moved"]);
    const movedHead = git(target, ["rev-parse", "HEAD"]).trim();

    const res = deliverArtifacts({
      workspace: ws,
      target,
      runId: "pinned",
      baseCommit: base.commit,
      sourceTree: base.sourceTree,
      docsTree: base.docsTree,
      capturedAt: base.capturedAt,
    });
    expect(git(target, ["rev-parse", `${res.branch}^`]).trim()).toBe(base.commit);
    expect(git(target, ["show", `${res.branch}:src/index.ts`])).toContain("revision = 1");
    expect(git(target, ["rev-parse", "main"]).trim()).toBe(movedHead);
  });

  it("carries prior source provenance into a revision workspace delta", () => {
    const target = makeTargetRepo(tmp);
    const ws = makeWorkspace(tmp);
    writeFileSync(join(ws, "validation-design", "validation-policy.yaml"), "gates: {}\n");
    const priorBase = captureTargetBase(target);
    const delivered = deliverArtifacts({
      workspace: ws,
      target,
      runId: "prior",
      baseCommit: priorBase.commit,
      sourceTree: priorBase.sourceTree,
      docsTree: priorBase.docsTree,
      capturedAt: priorBase.capturedAt,
    });
    git(target, [
      "-c", "user.name=t", "-c", "user.email=t@t",
      "merge", "-q", "--no-ff", "-m", "merge delivered design", delivered.branch,
    ]);
    writeFileSync(join(target, "src", "index.ts"), "export const revision = 2;\n");
    git(target, ["add", "-A"]);
    git(target, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "source only"]);

    const currentBase = captureTargetBase(target);
    const runDir = join(tmp, "revision-run");
    mkdirSync(runDir, { recursive: true });
    const seed = existingCorpusDir(target);
    expect(seed).toBeDefined();
    const revisionWorkspace = assembleWorkspace(repoRoot, loadTarget(target), runDir, {
      seedCorpusFrom: seed!,
      targetBase: currentBase,
    });
    const delta = readFileSync(join(revisionWorkspace, "TARGET-DIFF.md"), "utf8");
    const patch = readFileSync(join(revisionWorkspace, "TARGET-DIFF.patch"), "utf8");
    expect(delta).toContain(priorBase.commit);
    expect(delta).toContain(currentBase.commit);
    expect(delta).toMatch(/M\s+src\/index\.ts/);
    expect(delta).not.toMatch(/^[AMD]\s+validation-design\//m);
    expect(patch).toContain("-export const revision = 1;");
    expect(patch).toContain("+export const revision = 2;");
    expect(patch).not.toContain("validation-design/");
  });

  it("refuses legacy delivery without a captured base instead of using current HEAD", () => {
    const target = makeTargetRepo(tmp);
    const ws = makeWorkspace(tmp);
    expect(() => deliverArtifacts({ workspace: ws, target, runId: "legacy" })).toThrow(/predates pinned/);
  });
});
