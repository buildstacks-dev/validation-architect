import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import {
  captureTargetBase,
  loadTarget,
  materializeTargetSnapshot,
  readSourceProvenance,
  verifyTargetSnapshot,
} from "./target.js";
import type { SourceProvenance } from "./target.js";
import type { FixtureInfo, RunState, TargetBase } from "./types.js";

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
 *
 * When the source is a target repo that already carries a ratified corpus
 * (issue #1 revision mode), pass `seedCorpusFrom` — the existing
 * validation-design/ is copied in as the harness-revision baseline instead of
 * starting empty.
 *
 * Target campaigns additionally pass `targetBase`. Their committed product
 * tree is cloned at that exact revision under `target-source/`, independent of
 * the user's checkout and with its origin removed. Docs, rambling, and any
 * revision baseline are copied from that frozen source — never from mutable
 * target working-tree state.
 */
export function assembleWorkspace(
  repoRoot: string,
  fixture: FixtureInfo,
  runDir: string,
  opts?: {
    seedCorpusFrom?: string;
    targetBase?: TargetBase;
    /** Recovery-only: preserve a legacy workspace corpus instead of target HEAD's corpus. */
    useExplicitSeedCorpus?: boolean;
    /** Internal recovery destination; normal runs always use workspace/. */
    workspaceName?: string;
  },
): string {
  const workspaceName = opts?.workspaceName ?? "workspace";
  if (!/^workspace(?:-[A-Za-z0-9._-]+)?$/.test(workspaceName)) {
    throw new Error(`Invalid workspace name: ${workspaceName}`);
  }
  const workspace = join(runDir, workspaceName);
  mkdirSync(join(workspace, ".claude", "skills"), { recursive: true });
  const frozenTarget = opts?.targetBase
    ? materializeTargetSnapshot(fixture.dir, workspace, opts.targetBase)
    : undefined;
  let priorSource: SourceProvenance | undefined;

  if (opts?.seedCorpusFrom) {
    const seed = frozenTarget && !opts.useExplicitSeedCorpus
      ? join(frozenTarget, "validation-design")
      : opts.seedCorpusFrom;
    if (!existsSync(seed)) {
      throw new Error(`Revision mode requested, but the captured target has no validation-design/ corpus: ${seed}`);
    }
    // Explicit legacy recovery performs a mandatory full reconciliation; do
    // not let stale/unreachable provenance in the preserved corpus strand it.
    if (frozenTarget && !opts.useExplicitSeedCorpus) priorSource = readSourceProvenance(seed);
    cpSync(seed, join(workspace, "validation-design"), { recursive: true });
  } else {
    mkdirSync(join(workspace, "validation-design"), { recursive: true });
  }

  for (const skill of VENDORED_SKILLS) {
    cpSync(join(repoRoot, "skill", skill), join(workspace, ".claude", "skills", skill), {
      recursive: true,
    });
  }
  const inputRoot = frozenTarget ?? fixture.dir;
  cpSync(join(inputRoot, "docs"), join(workspace, "docs"), { recursive: true });
  const ramble = join(inputRoot, "rambling.txt");
  if (existsSync(ramble)) {
    cpSync(ramble, join(workspace, "rambling.txt"));
  }

  if (opts?.targetBase && frozenTarget) {
    const history = execFileSync(
      "git",
      ["log", "--max-count=200", "--date=iso-strict", "--pretty=format:%H%x09%cI%x09%an%x09%s"],
      { cwd: frozenTarget, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    writeFileSync(
      join(workspace, "TARGET-SNAPSHOT.md"),
      `# Frozen target snapshot

- Source root: \`./${opts.targetBase.snapshot}/\`
- Commit: \`${opts.targetBase.commit}\`
- Source tree digest: \`${opts.targetBase.sourceTree}\`
- Docs tree digest: \`${opts.targetBase.docsTree ?? "(absent)"}\`
- Captured: ${opts.targetBase.capturedAt}
- Dirty at capture: ${opts.targetBase.dirty ? "yes" : "no"}
- Write-back: disabled (the independent clone has no git remote)

The designer and auditor may read source and configuration under the source
root. Treat it as immutable evidence: write campaign artifacts only under
\`./validation-design/\`. The nested clone retains git history; the most recent
200 commits are summarized below for read-only auditors.

## Recent target history

\`\`\`text
${history}
\`\`\`
`,
    );
    if (opts.seedCorpusFrom) {
      let priorBlock = `- Prior design source base: unavailable (legacy corpus without source-provenance.json)\n`;
      let changes = `(delta unavailable until this revision is delivered with source provenance)`;
      let unifiedDiff = `# Unified source diff unavailable: the prior corpus has no source provenance.\n`;
      if (priorSource) {
        try {
          execFileSync("git", ["cat-file", "-e", `${priorSource.baseCommit}^{commit}`], {
            cwd: frozenTarget,
            stdio: ["ignore", "ignore", "pipe"],
          });
          const priorTree = execFileSync("git", ["rev-parse", `${priorSource.baseCommit}^{tree}`], {
            cwd: frozenTarget,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }).trim();
          if (priorTree !== priorSource.sourceTree) {
            throw new Error(`recorded tree ${priorSource.sourceTree} does not match repository tree ${priorTree}`);
          }
          changes = execFileSync(
            "git",
            [
              "diff",
              "--name-status",
              "--find-renames",
              priorSource.baseCommit,
              opts.targetBase.commit,
              "--",
              ".",
              ":(exclude)validation-design",
              ":(exclude)validation-design/**",
            ],
            // A long-lived revision delta can far exceed execFileSync's 1 MiB
            // default (Cormidia rev1: 16 MB unified diff → ENOBUFS).
            { cwd: frozenTarget, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 },
          ).trim() || "(no source/config changes)";
          unifiedDiff = execFileSync(
            "git",
            [
              "diff",
              "--no-ext-diff",
              "--no-color",
              "--unified=3",
              priorSource.baseCommit,
              opts.targetBase.commit,
              "--",
              ".",
              ":(exclude)validation-design",
              ":(exclude)validation-design/**",
            ],
            { cwd: frozenTarget, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 },
          ) || "# No source/config changes.\n";
          priorBlock = `- Prior design source base: \`${priorSource.baseCommit}\`\n- Prior source tree digest: \`${priorSource.sourceTree}\`\n- Prior source captured: ${priorSource.capturedAt}\n`;
        } catch (err) {
          throw new Error(
            `Cannot compare delivered design provenance to current target ${opts.targetBase.commit.slice(0, 12)}: ${(err as Error).message}`,
          );
        }
      }
      writeFileSync(
        join(workspace, "TARGET-DIFF.md"),
        `# Target source delta for harness revision

${priorBlock}- Current campaign source base: \`${opts.targetBase.commit}\`
- Current source tree digest: \`${opts.targetBase.sourceTree}\`
- Current source captured: ${opts.targetBase.capturedAt}

This is a read-only name/status summary over product files. Delivered
\`validation-design/\` changes are excluded so they cannot masquerade as a
product architecture change. The corresponding readable unified diff is in
\`./TARGET-DIFF.patch\`; inspect the changed current files under
\`./target-source/\` as the authoritative result.

## Changed source/config paths

\`\`\`text
${changes}
\`\`\`
`,
      );
      writeFileSync(join(workspace, "TARGET-DIFF.patch"), unifiedDiff);
    }
    verifyTargetSnapshot(workspace, opts.targetBase);
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

export interface LegacyTargetRecovery {
  workspace: string;
  legacyWorkspace: string;
  targetBase: TargetBase;
  deliveryBranch: string;
  recoveryDirective: string;
}

/**
 * Explicitly re-anchor an unauthenticated legacy target run on current clean
 * HEAD. The old workspace remains untouched until a complete new immutable
 * workspace exists, so a crash cannot strand the persisted state. The legacy
 * corpus and ramble are preserved, but all judgment evidence is reset by the
 * caller before the run resumes.
 */
export function reanchorLegacyTargetWorkspace(
  repoRoot: string,
  runDir: string,
  state: RunState,
): LegacyTargetRecovery {
  if (!state.target || state.targetBase) {
    throw new Error("Legacy target recovery requires a target run without targetBase state.");
  }
  const legacyWorkspace = resolve(state.workspace);
  const legacyCorpus = join(legacyWorkspace, "validation-design");
  if (!existsSync(legacyCorpus)) {
    throw new Error(`Legacy workspace corpus is missing: ${legacyCorpus}`);
  }
  const targetBase = captureTargetBase(state.target);
  const suffix = `${targetBase.commit.slice(0, 12)}-${Date.now()}`;
  const workspaceName = `workspace-recovered-${suffix}`;
  const destination = join(runDir, workspaceName);
  try {
    const workspace = assembleWorkspace(repoRoot, loadTarget(state.target), runDir, {
      seedCorpusFrom: legacyCorpus,
      targetBase,
      useExplicitSeedCorpus: true,
      workspaceName,
    });
    // These files are evidence about the legacy run, not the recovered one.
    // The untouched old workspace preserves them; fresh audit/provenance will
    // be generated before the recovered corpus can be delivered.
    rmSync(join(workspace, "validation-design", "audit"), { recursive: true, force: true });
    rmSync(join(workspace, "validation-design", "source-provenance.json"), { force: true });
    for (const staleSurface of [
      "ratification-package.md",
      "case-catalog.md",
      "harness-backlog.md",
      "owner-briefing.md",
      "owner-backlog.md",
      "planned-trace.md",
      "compiler-report.json",
    ]) {
      rmSync(join(workspace, "validation-design", staleSurface), { force: true });
    }
    const legacyRamble = join(legacyWorkspace, "rambling.txt");
    if (existsSync(legacyRamble)) cpSync(legacyRamble, join(workspace, "rambling.txt"));
    const priorPending = state.pending
      ? JSON.stringify(state.pending)
      : "(no persisted pending turn)";
    const safeRunId = state.runId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "legacy";
    return {
      workspace,
      legacyWorkspace,
      targetBase,
      deliveryBranch: `validation-design/${safeRunId}-recovered-${targetBase.commit.slice(0, 12)}`,
      recoveryDirective: `SOURCE-BASE RECOVERY — mandatory reconciliation before any completion claim.

This legacy campaign had no authenticated source revision. The operator explicitly
re-anchored it to clean target commit ${targetBase.commit} (tree ${targetBase.sourceTree}).
Read TARGET-SNAPSHOT.md, inspect target-source/ and TARGET-DIFF.md when present,
then reconcile every existing validation-design artifact against that source.
Call out and correct assumptions that the frozen source does not support. Reader
and audit evidence was intentionally reset and must be regenerated.

The exact previously pending turn is preserved here; incorporate or relay it only
after the source reconciliation so no interrupted work is silently dropped:
${priorPending}`,
    };
  } catch (err) {
    rmSync(destination, { recursive: true, force: true });
    throw err;
  }
}

/** Apply the fail-closed state reset after a recovery workspace is complete. */
export function applyLegacyTargetRecovery(
  state: RunState,
  recovery: LegacyTargetRecovery,
  now = new Date(),
): RunState {
  state.workspace = recovery.workspace;
  state.targetBase = recovery.targetBase;
  state.deliveryBranch = recovery.deliveryBranch;
  state.delivery = undefined;
  state.campaignMode = "revision";
  state.status = "running";
  state.statusReason = undefined;
  state.exchanges = 0;
  // Fresh sessions must receive their normal kickoffs. The recovery directive
  // (including the old pending turn) is appended to that kickoff by the CLI.
  state.pending = undefined;
  state.checkpointedDesignerMarker = undefined;
  state.compilation = undefined;
  state.sourceRecoveryDirective = recovery.recoveryDirective;
  state.designerSessionId = undefined;
  state.codexThreadId = undefined;
  state.readersRan = false;
  state.readerReviewFingerprint = undefined;
  state.audit = undefined;
  state.completionRejections = undefined;
  state.gateRejections = {};
  state.emptyDesignerTurns = undefined;
  state.rambleMtimeMs = undefined;
  state.startedAt = now.toISOString();
  state.updatedAt = state.startedAt;
  return state;
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
