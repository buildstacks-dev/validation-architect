import { cpSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { FixtureInfo } from "./types.js";

const VENDORED_SKILLS = ["validation-harness-design", "validation-harness-audit"];

/**
 * Assemble a fresh run workspace:
 *
 *   workspace/
 *     .claude/skills/validation-harness-design/   vendored skill copy (designer)
 *     .claude/skills/validation-harness-audit/    vendored skill copy (auditor)
 *     docs/                                       fixture's ratified documents
 *     rambling.txt                                the human channel (if present)
 *     validation-design/                          artifact root (empty; designer fills)
 *
 * The designer works read-write here; the stakeholder mounts the same
 * directory read-only via the Codex sandbox; the auditor runs fresh read-only
 * sessions over it.
 */
export function assembleWorkspace(repoRoot: string, fixture: FixtureInfo, runDir: string): string {
  const workspace = join(runDir, "workspace");
  mkdirSync(join(workspace, ".claude", "skills"), { recursive: true });
  mkdirSync(join(workspace, "validation-design"), { recursive: true });

  for (const skill of VENDORED_SKILLS) {
    cpSync(join(repoRoot, "skill", skill), join(workspace, ".claude", "skills", skill), {
      recursive: true,
    });
  }
  cpSync(join(fixture.dir, "docs"), join(workspace, "docs"), { recursive: true });
  const ramble = join(fixture.dir, "rambling.txt");
  if (existsSync(ramble)) {
    cpSync(ramble, join(workspace, "rambling.txt"));
  }

  // The skill produces "Git-trackable files"; give it a repo so git-minded
  // steps don't stumble. Failure here is non-fatal (git may be absent).
  try {
    execFileSync("git", ["init", "-q"], { cwd: workspace, stdio: "ignore" });
  } catch {
    // best-effort only
  }
  return workspace;
}

/**
 * Backfill the audit skill into a workspace assembled before the audit stage
 * existed, so `vda audit` works on older completed runs. Idempotent.
 */
export function ensureAuditSkill(repoRoot: string, workspace: string): void {
  const target = join(workspace, ".claude", "skills", "validation-harness-audit");
  if (existsSync(target)) return;
  cpSync(join(repoRoot, "skill", "validation-harness-audit"), target, { recursive: true });
}

export function ramblePath(workspace: string): string {
  return join(workspace, "rambling.txt");
}

export function artifactRoot(workspace: string): string {
  return join(workspace, "validation-design");
}
