/** Offline, idempotent delivery of one completed public checkpoint. */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { validateDesignRunCheckpoint, type CampaignCheckpoint } from "validation-architect";
import type { RunContext } from "./run-context.js";

export interface DeliveryResult {
  branch: string;
  commit: string;
  baseCommit: string;
}

function git(cwd: string, args: string[], allowFailure = false): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

function safeArtifactTarget(worktree: string, artifact: string): string {
  if (!artifact.startsWith("validation-design/") || artifact.includes("\\")) {
    throw new Error(`delivery refuses unsafe artifact path ${artifact}`);
  }
  const target = resolve(worktree, artifact);
  const rel = relative(worktree, target);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`delivery artifact escapes worktree: ${artifact}`);
  let parent = worktree;
  for (const segment of relative(worktree, dirname(target)).split(sep).filter(Boolean)) {
    parent = join(parent, segment);
    if (!existsSync(parent)) break;
    const entry = lstatSync(parent);
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`delivery parent is not a real directory: ${parent}`);
  }
  return target;
}

function assertBranchNotCheckedOut(target: string, branch: string): void {
  const checkedOut = git(target, ["worktree", "list", "--porcelain"])
    .split("\n")
    .some((line) => line === `branch refs/heads/${branch}`);
  if (checkedOut) throw new Error(`delivery branch ${branch} is checked out in a worktree`);
}

export function deliverRun(context: RunContext, rawCheckpoint: CampaignCheckpoint): DeliveryResult {
  if (context.fixture) throw new Error("fixture runs are not deliverable");
  const checkpoint = validateDesignRunCheckpoint(structuredClone(rawCheckpoint));
  if (checkpoint.runId !== context.runId || checkpoint.sourceRevision !== context.sourceRevision) {
    throw new Error("delivery context and checkpoint identities do not match");
  }
  if (checkpoint.pendingTurn || !checkpoint.envelope.terminals.includes(checkpoint.position)) {
    throw new Error(`run ${context.runId} is not complete and cannot be delivered`);
  }
  const target = realpathSync.native(context.target);
  if (git(target, ["status", "--porcelain", "--untracked-files=all"]) !== "") {
    throw new Error("target checkout must be clean for delivery");
  }
  git(target, ["cat-file", "-e", `${context.sourceRevision}^{commit}`]);
  const branch = `validation-design/${context.runId}`;
  assertBranchNotCheckedOut(target, branch);
  const existingCommit = git(target, ["rev-parse", "--verify", `refs/heads/${branch}`], true);
  const worktree = mkdtempSync(join(tmpdir(), `validation-architect-delivery-${context.runId}-`));
  let attached = false;
  try {
    git(target, ["worktree", "add", "--quiet", "--detach", worktree, context.sourceRevision]);
    attached = true;
    rmSync(join(worktree, "validation-design"), { recursive: true, force: true });
    for (const [artifact, content] of Object.entries(checkpoint.artifacts).sort(([left], [right]) => left.localeCompare(right))) {
      const destination = safeArtifactTarget(worktree, artifact);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content);
    }
    git(worktree, ["add", "-A", "--", "validation-design"]);
    const desiredTree = git(worktree, ["write-tree"]);
    if (existingCommit) {
      const existingTree = git(target, ["rev-parse", `${existingCommit}^{tree}`]);
      if (existingTree === desiredTree) {
        return { branch, commit: existingCommit, baseCommit: context.sourceRevision };
      }
    }
    const commit = git(worktree, ["commit-tree", desiredTree, "-p", context.sourceRevision, "-m", `Deliver validation design ${context.runId}`]);
    git(target, [
      "update-ref",
      `refs/heads/${branch}`,
      commit,
      existingCommit || "0000000000000000000000000000000000000000",
    ]);
    return { branch, commit, baseCommit: context.sourceRevision };
  } finally {
    if (attached) git(target, ["worktree", "remove", "--force", worktree], true);
    rmSync(worktree, { recursive: true, force: true });
  }
}
