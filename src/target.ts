import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { CampaignMode, FixtureInfo } from "./types.js";

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

export interface DeliveryResult {
  branch: string;
  commit: string;
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

  const branch = `validation-design/${opts.runId}`;
  const branchExists = gitOk(target, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  const tmp = mkdtempSync(join(tmpdir(), "vda-deliver-"));
  const wt = join(tmp, "wt");
  try {
    if (branchExists) {
      git(target, ["worktree", "add", wt, branch]);
    } else {
      git(target, ["worktree", "add", "-b", branch, wt]);
    }
    // Replace wholesale so deletions in the corpus propagate.
    rmSync(join(wt, "validation-design"), { recursive: true, force: true });
    cpSync(corpus, join(wt, "validation-design"), { recursive: true });
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
    return { branch, commit };
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
