import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { materializeEnablementBundle } from "./enablement.js";
import type { CampaignMode, FixtureInfo, TargetBase, TargetRevision } from "./types.js";

/**
 * Target-repo anchoring (issue #1). The product repo is first-class; VDA is a
 * tool invoked against it. This module owns the three target-specific
 * concerns: loading a product repo as a campaign source, choosing greenfield
 * vs harness-revision kickoff scope, and delivering the finished corpus back
 * to the repo as a git branch. Campaign residue (transcript, state.json,
 * report.md) stays under VDA's runs/; the durable spec lands in the product
 * repo.
 */

/**
 * Load a product repo as a campaign source. Same shape as a fixture — docs/
 * required, rambling.txt optional — so the workspace assembly and kickoff
 * paths are shared.
 */
export function loadTarget(targetPath: string): FixtureInfo {
  const dir = resolve(targetPath);
  if (!existsSync(dir)) {
    throw new Error(`Target repo not found: ${dir}`);
  }
  const docsDir = join(dir, "docs");
  if (!existsSync(docsDir) || readdirSync(docsDir).length === 0) {
    throw new Error(
      `Target "${dir}" has no docs/ — the designer needs the repo's ratified product documents.`,
    );
  }
  return {
    name: basename(dir),
    dir,
    displayName: basename(dir),
    hasRambling: existsSync(join(dir, "rambling.txt")),
  };
}

/** The corpus marker: a target that carries this already has a ratified design. */
export function existingCorpusDir(targetDir: string): string | undefined {
  const corpus = join(targetDir, "validation-design");
  return existsSync(join(corpus, "validation-policy.yaml")) ? corpus : undefined;
}

/**
 * Revision is the DEFAULT when the target already carries a corpus —
 * re-deriving from scratch creates a second, diverging truth. `--fresh` opts
 * out explicitly (the CLI warns).
 */
export function resolveCampaignMode(targetDir: string, fresh: boolean): CampaignMode {
  if (fresh) return "greenfield";
  return existingCorpusDir(targetDir) ? "revision" : "greenfield";
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function gitOk(cwd: string, args: string[]): boolean {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

export const TARGET_SNAPSHOT_DIR = "target-source";
export const SOURCE_PROVENANCE_SCHEMA = "validation-architect/source-provenance/v1";

export interface SourceProvenance {
  schema: typeof SOURCE_PROVENANCE_SCHEMA;
  runId: string;
  baseCommit: string;
  sourceTree: string;
  docsTree?: string | undefined;
  capturedAt: string;
}

/** Read and fail-closed validate provenance embedded in a delivered corpus. */
export function readSourceProvenance(corpusDir: string): SourceProvenance | undefined {
  const path = join(corpusDir, "source-provenance.json");
  if (!existsSync(path)) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Invalid delivered source provenance at ${path}: ${(err as Error).message}`);
  }
  const p = value as Partial<SourceProvenance>;
  const objectIds = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
  if (
    !value || typeof value !== "object" ||
    p.schema !== SOURCE_PROVENANCE_SCHEMA ||
    typeof p.runId !== "string" || !p.runId ||
    typeof p.baseCommit !== "string" || !objectIds.test(p.baseCommit) ||
    typeof p.sourceTree !== "string" || !objectIds.test(p.sourceTree) ||
    (p.docsTree !== undefined && (typeof p.docsTree !== "string" || !objectIds.test(p.docsTree))) ||
    typeof p.capturedAt !== "string" || !Number.isFinite(Date.parse(p.capturedAt))
  ) {
    throw new Error(`Invalid delivered source provenance schema or fields at ${path}.`);
  }
  return p as SourceProvenance;
}

/**
 * Resolve and validate the immutable target revision used by a campaign.
 * Target campaigns deliberately refuse a dirty checkout: copying dirty docs
 * while later delivering from committed HEAD creates an artifact branch whose
 * inputs do not exist in its history.
 */
export function captureTargetRevision(targetPath: string): TargetRevision {
  const target = resolve(targetPath);
  if (!gitOk(target, ["rev-parse", "--is-inside-work-tree"])) {
    throw new Error(`Target is not a git repository: ${target}`);
  }
  if (!gitOk(target, ["rev-parse", "--verify", "HEAD"])) {
    throw new Error(`Target repo has no commits yet: ${target} — commit the product inputs before starting a campaign.`);
  }
  const dirty = git(target, ["status", "--porcelain=v1", "--untracked-files=all"]).trim();
  if (dirty) {
    const preview = dirty.split("\n").slice(0, 8).join("\n  ");
    throw new Error(
      `Target repo has uncommitted or untracked files; source-consuming work must pin one immutable revision. Commit or stash them first:\n  ${preview}`,
    );
  }
  const commit = git(target, ["rev-parse", "HEAD"]).trim();
  const sourceTree = git(target, ["rev-parse", `${commit}^{tree}`]).trim();
  return {
    commit,
    sourceTree,
    capturedAt: new Date().toISOString(),
    dirty: false,
  };
}

/** Capture the source and committed docs identity used by a target campaign. */
export function captureTargetBase(targetPath: string): TargetBase {
  const target = resolve(targetPath);
  const revision = captureTargetRevision(target);
  let docsTree: string | undefined;
  try {
    docsTree = git(target, ["rev-parse", `${revision.commit}:docs`]).trim();
  } catch {
    throw new Error(`Target ${target} has no committed docs/ tree at ${revision.commit.slice(0, 12)}.`);
  }
  return {
    ...revision,
    docsTree,
    snapshot: TARGET_SNAPSHOT_DIR,
  };
}

/**
 * Verify that a checkout still has the exact clean identity captured before a
 * source-consuming operation. Callers use the captured values for evidence;
 * this check never replaces them with a later HEAD read.
 */
export function verifyTargetRevision(targetPath: string, revision: TargetRevision): void {
  const target = resolve(targetPath);
  if (!gitOk(target, ["rev-parse", "--is-inside-work-tree"])) {
    throw new Error(`Target is no longer a readable git repository: ${target}`);
  }
  const head = git(target, ["rev-parse", "HEAD"]).trim();
  const tree = git(target, ["rev-parse", "HEAD^{tree}"]).trim();
  const dirty = git(target, ["status", "--porcelain=v1", "--untracked-files=all"]).trim();
  if (head !== revision.commit || tree !== revision.sourceTree || dirty) {
    const details = [
      head !== revision.commit
        ? `HEAD moved from ${revision.commit.slice(0, 12)} to ${head.slice(0, 12)}`
        : undefined,
      tree !== revision.sourceTree ? "the committed source tree changed" : undefined,
      dirty ? `the checkout became dirty (${dirty.split("\n")[0]})` : undefined,
    ].filter((detail): detail is string => detail !== undefined);
    throw new Error(
      `Target changed after its immutable revision was captured: ${details.join("; ")}. The result is invalid and must not be recorded.`,
    );
  }
}

function snapshotPath(workspace: string, base: TargetBase): string {
  if (isAbsolute(base.snapshot)) {
    throw new Error(`Target snapshot path must be workspace-relative, got: ${base.snapshot}`);
  }
  const root = resolve(workspace);
  const snapshot = resolve(root, base.snapshot);
  const rel = relative(root, snapshot);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Target snapshot path escapes the workspace: ${base.snapshot}`);
  }
  return snapshot;
}

/**
 * Clone the captured revision into the workspace as an independent local
 * repository. --no-local avoids object hardlinks to the user's repo, and the
 * origin remote is removed so no operation in the campaign can push back into
 * the checkout. The nested clone keeps source/config plus readable git history.
 */
export function materializeTargetSnapshot(targetPath: string, workspace: string, base: TargetBase): string {
  const target = resolve(targetPath);
  const snapshot = snapshotPath(workspace, base);
  if (existsSync(snapshot)) throw new Error(`Target snapshot already exists: ${snapshot}`);
  execFileSync("git", ["clone", "--no-local", "--no-checkout", "--quiet", "--", target, snapshot], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" },
  });
  try {
    git(snapshot, ["checkout", "--detach", "--quiet", base.commit]);
    if (gitOk(snapshot, ["remote", "get-url", "origin"])) git(snapshot, ["remote", "remove", "origin"]);
    verifyTargetSnapshot(workspace, base);
    return snapshot;
  } catch (err) {
    rmSync(snapshot, { recursive: true, force: true });
    throw err;
  }
}

/** Assert that the nested source snapshot still exactly matches its captured revision. */
export function verifyTargetSnapshot(workspace: string, base: TargetBase): string {
  if (base.dirty !== false || !Number.isFinite(Date.parse(base.capturedAt))) {
    throw new Error("Captured target snapshot state is not a valid clean immutable base.");
  }
  const snapshot = snapshotPath(workspace, base);
  if (!gitOk(snapshot, ["rev-parse", "--is-inside-work-tree"])) {
    throw new Error(`Captured target snapshot is missing or invalid: ${snapshot}`);
  }
  const head = git(snapshot, ["rev-parse", "HEAD"]).trim();
  const tree = git(snapshot, ["rev-parse", "HEAD^{tree}"]).trim();
  const dirty = git(snapshot, ["status", "--porcelain=v1", "--untracked-files=all"]).trim();
  if (head !== base.commit || tree !== base.sourceTree || dirty) {
    throw new Error(
      `Captured target snapshot drifted from ${base.commit.slice(0, 12)}${dirty ? ` (working tree is dirty: ${dirty.split("\n")[0]})` : ""}. Restore or restart the campaign; source evidence must be immutable.`,
    );
  }
  if (base.docsTree) {
    const docsTree = gitOk(snapshot, ["cat-file", "-e", "HEAD:docs"])
      ? git(snapshot, ["rev-parse", "HEAD:docs"]).trim()
      : undefined;
    if (docsTree !== base.docsTree) {
      throw new Error(
        `Captured target snapshot docs digest drifted (state ${base.docsTree}, snapshot ${docsTree ?? "absent"}).`,
      );
    }
  }
  if (git(snapshot, ["remote"]).trim()) {
    throw new Error(`Captured target snapshot unexpectedly has a git remote; refusing a workspace that could write back.`);
  }
  return snapshot;
}

/**
 * Recover additive targetBase state only when the workspace already contains
 * self-consistent frozen-source evidence. This never guesses from the user's
 * current checkout or from mutable docs alone.
 */
export function recoverTargetBaseFromWorkspace(workspace: string): TargetBase | undefined {
  const metadataPath = join(workspace, "TARGET-SNAPSHOT.md");
  const frozen = join(workspace, TARGET_SNAPSHOT_DIR);
  if (!existsSync(metadataPath) && !existsSync(frozen)) return undefined;
  if (!existsSync(metadataPath) || !existsSync(frozen)) {
    throw new Error(
      `Legacy target evidence is incomplete in ${workspace}: TARGET-SNAPSHOT.md and ${TARGET_SNAPSHOT_DIR}/ must both be present.`,
    );
  }
  const metadata = readFileSync(metadataPath, "utf8");
  const field = (label: string): string | undefined => {
    const prefix = `- ${label}: `;
    const line = metadata.split(/\r?\n/).find((candidate) => candidate.startsWith(prefix));
    const value = line?.slice(prefix.length).trim();
    return value?.replace(/^`/, "").replace(/`$/, "");
  };
  const sourceRoot = field("Source root")?.replace(/^\.\//, "").replace(/\/$/, "");
  const commit = field("Commit");
  const sourceTree = field("Source tree digest");
  const docsValue = field("Docs tree digest");
  const capturedAt = field("Captured");
  const dirty = field("Dirty at capture");
  const objectId = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
  if (
    sourceRoot !== TARGET_SNAPSHOT_DIR ||
    !commit || !objectId.test(commit) ||
    !sourceTree || !objectId.test(sourceTree) ||
    !capturedAt || !Number.isFinite(Date.parse(capturedAt)) ||
    dirty !== "no"
  ) {
    throw new Error(`Legacy target snapshot metadata is malformed or cannot prove a clean immutable base: ${metadataPath}`);
  }
  const actualDocs = gitOk(frozen, ["cat-file", "-e", `${commit}:docs`])
    ? git(frozen, ["rev-parse", `${commit}:docs`]).trim()
    : undefined;
  if (docsValue && docsValue !== "(absent)" && docsValue !== actualDocs) {
    throw new Error(
      `Legacy target snapshot docs digest mismatch (metadata ${docsValue}, snapshot ${actualDocs ?? "absent"}).`,
    );
  }
  const base: TargetBase = {
    commit,
    sourceTree,
    ...(actualDocs ? { docsTree: actualDocs } : {}),
    snapshot: TARGET_SNAPSHOT_DIR,
    capturedAt,
    dirty: false,
  };
  verifyTargetSnapshot(workspace, base);
  return base;
}

export interface DeliveryResult {
  branch: string;
  commit: string;
  baseCommit: string;
  sourceTree?: string;
  /** Git tree object for the exact delivered validation-design/ contents. */
  corpusTree: string;
}

/**
 * Land the workspace's validation-design/ corpus in the target repo as a
 * branch (`validation-design/<runId>`), committed via a TEMPORARY worktree so
 * the user's checkout — current branch, index, working tree — is never
 * touched. Idempotent: re-delivering updates the same branch (no-op commit is
 * skipped). PR creation is left to the human (`gh pr create` from the
 * branch); this stays offline.
 */
export function deliverArtifacts(opts: {
  workspace: string;
  target: string;
  runId: string;
  /** Captured target HEAD. Required for safe branch creation and redelivery. */
  baseCommit?: string;
  /** Captured root tree digest, when available on new state files. */
  sourceTree?: string;
  docsTree?: string | undefined;
  /** Time at which the campaign pinned baseCommit. */
  capturedAt?: string;
  /** Explicit recovery branch; normal campaigns derive validation-design/<runId>. */
  branch?: string;
}): DeliveryResult {
  const corpus = join(opts.workspace, "validation-design");
  if (!existsSync(corpus) || readdirSync(corpus).length === 0) {
    throw new Error(`Nothing to deliver: ${corpus} is missing or empty.`);
  }
  const target = resolve(opts.target);
  if (!gitOk(target, ["rev-parse", "--is-inside-work-tree"])) {
    throw new Error(`Target is not a git repository: ${target}`);
  }
  if (!gitOk(target, ["rev-parse", "--verify", "HEAD"])) {
    throw new Error(
      `Target repo has no commits yet: ${target} — make an initial commit so the delivery branch has a base.`,
    );
  }

  const branch = opts.branch ?? `validation-design/${opts.runId}`;
  if (!/^validation-design\/[A-Za-z0-9._-]+$/.test(branch)) {
    throw new Error(`Invalid delivery branch ${branch}; expected validation-design/<safe-name>.`);
  }
  const branchExists = gitOk(target, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (!opts.baseCommit) {
    throw new Error(
      `Run ${opts.runId} predates pinned target revisions; refusing to base delivery on the target's arbitrary current HEAD. Start a new campaign against the intended revision.`,
    );
  }
  const baseCommit = opts.baseCommit;
  if (!opts.sourceTree || !opts.capturedAt) {
    throw new Error(
      `Run ${opts.runId} lacks captured source digest/time; refusing a delivery that could not preserve machine-readable source provenance.`,
    );
  }
  if (!gitOk(target, ["cat-file", "-e", `${baseCommit}^{commit}`])) {
    throw new Error(`Captured target revision ${baseCommit} is no longer available in ${target}.`);
  }
  const actualTree = git(target, ["rev-parse", `${baseCommit}^{tree}`]).trim();
  if (opts.sourceTree && actualTree !== opts.sourceTree) {
    throw new Error(
      `Captured source digest mismatch for ${baseCommit.slice(0, 12)} (state ${opts.sourceTree}, repository ${actualTree}).`,
    );
  }
  if (branchExists) {
    if (!gitOk(target, ["merge-base", "--is-ancestor", baseCommit, branch])) {
      throw new Error(`Existing delivery branch ${branch} is not based on captured revision ${baseCommit.slice(0, 12)}.`);
    }
    const outsideCorpus = git(target, [
      "diff",
      "--name-only",
      `${baseCommit}..${branch}`,
      "--",
      ".",
      ":(exclude)validation-design",
      ":(exclude)validation-design/**",
    ])
      .trim()
      .split("\n")
      .filter(Boolean);
    if (outsideCorpus.length > 0) {
      throw new Error(
        `Existing delivery branch ${branch} contains changes outside validation-design/ (${outsideCorpus.slice(0, 5).join(", ")}); refusing incompatible drift.`,
      );
    }
  }
  const tmp = mkdtempSync(join(tmpdir(), "vda-deliver-"));
  const wt = join(tmp, "wt");
  try {
    if (branchExists) {
      git(target, ["worktree", "add", wt, branch]);
    } else {
      git(target, ["worktree", "add", "-b", branch, wt, baseCommit]);
    }
    // Replace wholesale so deletions in the corpus propagate.
    rmSync(join(wt, "validation-design"), { recursive: true, force: true });
    cpSync(corpus, join(wt, "validation-design"), { recursive: true });
    const provenance: SourceProvenance = {
      schema: SOURCE_PROVENANCE_SCHEMA,
      runId: opts.runId,
      baseCommit,
      sourceTree: opts.sourceTree,
      ...(opts.docsTree ? { docsTree: opts.docsTree } : {}),
      capturedAt: opts.capturedAt,
    };
    writeFileSync(
      join(wt, "validation-design", "source-provenance.json"),
      `${JSON.stringify(provenance, null, 2)}\n`,
    );
    materializeEnablementBundle(join(wt, "validation-design"));
    git(wt, ["add", "-A", "validation-design"]);
    const dirty = git(wt, ["status", "--porcelain"]).trim().length > 0;
    if (dirty) {
      git(wt, [
        "-c",
        "user.name=validation-architect",
        "-c",
        "user.email=vda@localhost",
        "commit",
        "-q",
        "-m",
        `validation-design: campaign ${opts.runId} artifacts`,
      ]);
    }
    const commit = git(wt, ["rev-parse", "HEAD"]).trim();
    const corpusTree = git(wt, ["rev-parse", "HEAD:validation-design"]).trim();
    return {
      branch,
      commit,
      baseCommit,
      ...(opts.sourceTree ? { sourceTree: opts.sourceTree } : {}),
      corpusTree,
    };
  } finally {
    try {
      git(target, ["worktree", "remove", "--force", wt]);
    } catch {
      // worktree may not have been created; prune below covers stale entries
      gitOk(target, ["worktree", "prune"]);
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}
