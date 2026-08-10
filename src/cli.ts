import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeAuditorRunner } from "./auditor.js";
import { nextPostHocAuditIteration, validateAuditReport } from "./audit.js";
import { ClaudeDesigner } from "./designer.js";
import { runBoundFidelityAudit } from "./fidelity.js";
import { listFixtures, loadFixture } from "./fixtures.js";
import {
  buildRunConfig,
  claudeAuthFlag,
  nonNegativeIntegerFlag,
  positiveIntegerFlag,
} from "./options.js";
import { auditedCoreFingerprint, runCampaign } from "./orchestrator.js";
import { auditorPrompt, designerKickoff, stakeholderKickoff } from "./prompts.js";
import { RambleWatcher } from "./ramble.js";
import { ClaudeReaderRunner } from "./readers.js";
import { loadRegistry, recordCampaign, recordDelivery, recordFidelity, renderRepos, repoStatuses } from "./registry.js";
import { generateReport } from "./report.js";
import { CodexStakeholder } from "./stakeholder.js";
import {
  captureTargetBase,
  deliverArtifacts,
  existingCorpusDir,
  loadTarget,
  recoverTargetBaseFromWorkspace,
  resolveCampaignMode,
  verifyTargetSnapshot,
} from "./target.js";
import { Transcript, readTranscript } from "./transcript.js";
import type { RunState, TargetBase } from "./types.js";
import {
  applyLegacyTargetRecovery,
  assembleWorkspace,
  ensureAuditSkill,
  ramblePath,
  reanchorLegacyTargetWorkspace,
} from "./workspace.js";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const runsRoot = join(repoRoot, "runs");
// The per-repo ledger (#8): written only by the completion paths below.
const registryPath = join(runsRoot, "registry.json");

function parseFlags(argv: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, "true");
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function statePath(runDir: string): string {
  return join(runDir, "state.json");
}

function saveState(runDir: string): (s: RunState) => void {
  return (s) => {
    const destination = statePath(runDir);
    const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(temporary, `${JSON.stringify(s, null, 2)}\n`);
      renameSync(temporary, destination);
    } finally {
      rmSync(temporary, { force: true });
    }
  };
}

function loadState(runDir: string): RunState {
  return JSON.parse(readFileSync(statePath(runDir), "utf8")) as RunState;
}

type LegacyRecovery = "none" | "evidence" | "reanchored";

/**
 * Restore additive targetBase state only from authenticated frozen evidence,
 * or perform the operator's explicit current-HEAD recovery. Re-anchoring
 * returns without spending provider quota; a subsequent resume starts fresh
 * sessions with a mandatory reconciliation appended to the fresh kickoff.
 */
function prepareLegacyTargetState(
  runDir: string,
  state: RunState,
  recoveryFlag?: string,
): LegacyRecovery {
  if (!state.target) {
    if (recoveryFlag !== undefined) {
      throw new Error(`Run ${state.runId} is not target-anchored; --recover-target-base is not applicable.`);
    }
    return "none";
  }
  if (state.targetBase) {
    if (recoveryFlag !== undefined) {
      throw new Error(`Run ${state.runId} already has an immutable target base; --recover-target-base is not applicable.`);
    }
    return "none";
  }
  if (recoveryFlag !== undefined && recoveryFlag !== "current") {
    throw new Error(`--recover-target-base accepts only "current" (got ${recoveryFlag}).`);
  }
  let recovered: TargetBase | undefined;
  try {
    recovered = recoverTargetBaseFromWorkspace(state.workspace);
  } catch (err) {
    if (recoveryFlag !== "current") throw err;
    console.warn(
      `[vda] frozen legacy evidence is incomplete/corrupt and will not be trusted: ${(err as Error).message}`,
    );
  }
  if (recovered) {
    state.targetBase = recovered;
    state.updatedAt = new Date().toISOString();
    saveState(runDir)(state);
    console.log(
      `[vda] recovered immutable target base ${recovered.commit.slice(0, 12)} from frozen workspace evidence`,
    );
    return "evidence";
  }
  if (recoveryFlag === undefined) {
    throw new Error(
      `Legacy target run ${state.runId} has no authenticated frozen source revision. Refusing to guess from current HEAD. Recover explicitly with: vda resume ${state.runId} --recover-target-base current`,
    );
  }
  const recovery = reanchorLegacyTargetWorkspace(repoRoot, runDir, state);
  applyLegacyTargetRecovery(state, recovery);
  saveState(runDir)(state);
  console.log(`[vda] legacy workspace preserved untouched at ${recovery.legacyWorkspace}`);
  console.log(
    `[vda] re-anchored ${state.runId} on clean target ${recovery.targetBase.commit.slice(0, 12)}; reader/audit evidence and provider sessions were reset`,
  );
  return "reanchored";
}

/** Persist an audit artifact to the run dir AND the workspace's corpus. */
function saveAuditFile(runDir: string, workspace: string): (name: string, content: string) => void {
  return (name, content) => {
    const body = content.endsWith("\n") ? content : `${content}\n`;
    writeFileSync(join(runDir, name), body);
    const auditDir = join(workspace, "validation-design", "audit");
    mkdirSync(auditDir, { recursive: true });
    writeFileSync(join(auditDir, name), body);
  };
}

function auditSectionPresent(workspace: string): () => boolean {
  return () => {
    const pkg = join(workspace, "validation-design", "ratification-package.md");
    if (!existsSync(pkg)) return false;
    return /^#{1,6}\s+.*audit/im.test(readFileSync(pkg, "utf8"));
  };
}

/** The enablement-bundle version installed: the delivered manifest's schema id. */
function manifestSchemaOf(workspace: string): string | undefined {
  const p = join(workspace, "validation-design", "case-catalog.yaml");
  if (!existsSync(p)) return undefined;
  const m = readFileSync(p, "utf8").match(/^schema:\s*(\S+)/m);
  return m ? m[1] : undefined;
}

/**
 * Deliver a completed target-anchored run's corpus to the product repo as a
 * branch. Failure is reported, never fatal to the run record — `vda deliver`
 * retries idempotently.
 */
function tryDeliver(runDir: string, state: RunState): void {
  if (!state.target) return;
  try {
    const delivery = deliverArtifacts({
      workspace: state.workspace,
      target: state.target,
      runId: state.runId,
      ...(state.targetBase?.commit ? { baseCommit: state.targetBase.commit } : {}),
      ...(state.targetBase?.sourceTree ? { sourceTree: state.targetBase.sourceTree } : {}),
      ...(state.targetBase?.docsTree ? { docsTree: state.targetBase.docsTree } : {}),
      ...(state.targetBase?.capturedAt ? { capturedAt: state.targetBase.capturedAt } : {}),
      ...(state.deliveryBranch ? { branch: state.deliveryBranch } : {}),
    });
    const deliveredAt = new Date().toISOString();
    state.delivery = { ...delivery, deliveredAt };
    state.updatedAt = new Date().toISOString();
    saveState(runDir)(state);
    recordDelivery(
      registryPath,
      state.target,
      {
        runId: state.runId,
        branch: delivery.branch,
        commit: delivery.commit,
        deliveredAt,
        baseCommit: delivery.baseCommit,
        ...(delivery.sourceTree ? { sourceTree: delivery.sourceTree } : {}),
        corpusTree: delivery.corpusTree,
      },
      manifestSchemaOf(state.workspace),
    );
    console.log(
      `[vda] delivered to ${state.target} — branch ${delivery.branch} @ ${delivery.commit.slice(0, 12)}`,
    );
    console.log(
      `[vda] review & ratify: open a PR from ${delivery.branch}, or inspect git -C ${state.target} diff ${delivery.baseCommit.slice(0, 12)}..${delivery.branch} -- validation-design/ (leave the delivery branch un-checked-out so an idempotent re-delivery can update it)`,
    );
  } catch (err) {
    console.error(`[vda] delivery to target failed: ${(err as Error).message}`);
    console.error(`[vda] artifacts are intact in the workspace; retry with: vda deliver ${state.runId}`);
    process.exitCode = 1;
  }
}

async function execCampaign(runDir: string, state: RunState): Promise<void> {
  const fixture = state.target
    ? (() => {
        if (!state.targetBase) {
          throw new Error(
            `Target run ${state.runId} lacks an authenticated source snapshot. Run vda resume ${state.runId} --recover-target-base current before resuming live work.`,
          );
        }
        const snapshot = verifyTargetSnapshot(state.workspace, state.targetBase);
        return {
          ...loadTarget(snapshot),
          name: state.fixture,
          displayName: state.fixture,
          hasRambling: existsSync(ramblePath(state.workspace)),
        };
      })()
    : loadFixture(repoRoot, state.fixture);
  // Runs started before the audit stage existed lack the vendored audit skill
  // in their workspace; backfill so resume enters the audit loop cleanly.
  ensureAuditSkill(repoRoot, state.workspace);
  const designer = new ClaudeDesigner({
    workspace: state.workspace,
    model: state.config.designerModel,
    authMode: state.config.claudeAuth,
    maxTurnsPerSend: state.config.designerMaxTurns,
    resumeSessionId: state.designerSessionId,
  });
  const stakeholder = new CodexStakeholder({
    workspace: state.workspace,
    model: state.config.stakeholderModel,
    authMode: state.config.codexAuth,
    resumeThreadId: state.codexThreadId,
  });
  const readers = new ClaudeReaderRunner({
    model: state.config.readerModel,
    authMode: state.config.claudeAuth,
  });
  const auditor = new ClaudeAuditorRunner({
    model: state.config.auditorModel ?? state.config.designerModel,
    authMode: state.config.claudeAuth,
  });
  const transcript = new Transcript(runDir, state.seq);
  const ramble = new RambleWatcher(ramblePath(state.workspace), state.rambleMtimeMs);

  const final = await runCampaign(
    {
      designer,
      stakeholder,
      readers,
      auditor,
      transcript,
      ramble,
      saveState: saveState(runDir),
      saveAuditFile: saveAuditFile(runDir, state.workspace),
      auditSectionPresent: auditSectionPresent(state.workspace),
      log: (line) => console.log(`[vda] ${line}`),
    },
    state,
    {
      designer: [
        designerKickoff(fixture, state.campaignMode ?? "greenfield"),
        state.sourceRecoveryDirective,
      ].filter((message): message is string => message !== undefined).join("\n\n---\n\n"),
      stakeholder: stakeholderKickoff(repoRoot, fixture),
    },
  );

  generateReport(runDir);
  console.log(`[vda] campaign ${final.status}${final.statusReason ? ` (${final.statusReason})` : ""}`);
  console.log(`[vda] report: ${join(runDir, "report.md")}`);
  console.log(`[vda] artifacts: ${join(state.workspace, "validation-design")}`);
  if (final.target) {
    recordCampaign(registryPath, final.target, {
      runId: final.runId,
      mode: final.campaignMode ?? "greenfield",
      status: final.status,
      ...(final.audit?.verdict ? { verdict: final.audit.verdict } : {}),
      at: new Date().toISOString(),
    });
  }
  if (final.status === "completed") {
    tryDeliver(runDir, final);
  } else {
    process.exitCode = 1;
  }
}

async function cmdRun(args: string[]): Promise<void> {
  const { positional, flags } = parseFlags(args);
  const fixtureName = positional[0];
  const targetFlag = flags.get("target");
  if ((!fixtureName && !targetFlag) || (fixtureName && targetFlag)) {
    console.error(`usage: vda run <fixture> [flags]         (test/demo path against a bundled fixture)\n       vda run --target <product-repo> [--fresh] [flags]   (anchored: artifacts deliver to the repo as a branch)\nflags: [--smoke] [--max-exchanges N] [--wall-minutes N]\n  [--designer-model M] [--stakeholder-model M] [--reader-model M] [--auditor-model M]\n  [--claude-auth subscription|api-key] [--codex-auth chatgpt|api-key] [--run-id ID]\nfixtures: ${listFixtures(repoRoot).join(", ")}`);
    process.exitCode = 2;
    return;
  }

  let fixture; // FixtureInfo shape for both sources
  let target: string | undefined;
  let targetBase: TargetBase | undefined;
  let campaignMode: "greenfield" | "revision" = "greenfield";
  let seedCorpusFrom: string | undefined;
  if (targetFlag) {
    fixture = loadTarget(targetFlag);
    target = fixture.dir;
    targetBase = captureTargetBase(target);
    const fresh = flags.get("fresh") === "true";
    campaignMode = resolveCampaignMode(target, fresh);
    const corpus = existingCorpusDir(target);
    if (campaignMode === "revision" && corpus) {
      seedCorpusFrom = corpus;
      console.log(`[vda] existing corpus detected at ${corpus} — entering harness-revision mode (use --fresh to opt out)`);
    } else if (fresh && corpus) {
      console.warn(`[vda] WARNING: --fresh on a target that already carries ${corpus} — this campaign will create a second, diverging design. The existing corpus stays untouched until you merge the delivery branch.`);
    }
  } else {
    fixture = loadFixture(repoRoot, fixtureName as string);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runId = flags.get("run-id") ?? `${fixture.name}-${stamp}`;
  const config = buildRunConfig(fixture.name, runId, flags);
  const runDir = join(runsRoot, runId);
  if (existsSync(runDir)) {
    console.error(`run dir already exists: ${runDir} (use vda resume ${runId})`);
    process.exitCode = 2;
    return;
  }
  mkdirSync(runDir, { recursive: true });
  const workspace = assembleWorkspace(repoRoot, fixture, runDir, {
    ...(seedCorpusFrom ? { seedCorpusFrom } : {}),
    ...(targetBase ? { targetBase } : {}),
  });
  const state: RunState = {
    runId,
    fixture: fixture.name,
    workspace,
    status: "running",
    exchanges: 0,
    seq: 0,
    target,
    targetBase,
    campaignMode,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config,
  };
  saveState(runDir)(state);
  console.log(`[vda] run ${runId} — ${target ? `target ${target} (${campaignMode})` : `fixture ${fixture.displayName}`}, workspace ${workspace}`);
  await execCampaign(runDir, state);
}

/**
 * (Re-)deliver a completed target-anchored run's corpus to the product repo.
 * Idempotent: updates the same validation-design/<runId> branch.
 */
function cmdDeliver(args: string[]): void {
  const { positional, flags } = parseFlags(args);
  const runId = positional[0];
  if (!runId) {
    console.error("usage: vda deliver <runId> [--recover-target-base current]");
    process.exitCode = 2;
    return;
  }
  const runDir = join(runsRoot, runId);
  const state = loadState(runDir);
  if (!state.target) {
    console.error(`run ${runId} is a fixture run (no --target); nothing to deliver. Artifacts: ${join(state.workspace, "validation-design")}`);
    process.exitCode = 2;
    return;
  }
  try {
    const recovery = prepareLegacyTargetState(runDir, state, flags.get("recover-target-base"));
    if (recovery === "reanchored") {
      console.log(`[vda] recovery workspace is ready; inspect it, then continue with: vda resume ${runId}`);
      return;
    }
  } catch (err) {
    console.error(`[vda] delivery recovery refused: ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }
  if (state.status !== "completed") {
    console.error(`run ${runId} is ${state.status}; delivery expects a completed campaign (use vda resume)`);
    process.exitCode = 2;
    return;
  }
  tryDeliver(runDir, state);
}

async function cmdResume(args: string[]): Promise<void> {
  const { positional, flags } = parseFlags(args);
  const runId = positional[0];
  if (!runId) {
    console.error("usage: vda resume <runId> [--recover-target-base current] [--max-exchanges N] [--wall-minutes N]");
    process.exitCode = 2;
    return;
  }
  const runDir = join(runsRoot, runId);
  const state = loadState(runDir);
  try {
    const recovery = prepareLegacyTargetState(runDir, state, flags.get("recover-target-base"));
    if (recovery === "reanchored") {
      console.log(`[vda] recovery workspace is ready; inspect it, then run: vda resume ${runId}`);
      return;
    }
  } catch (err) {
    console.error(`[vda] resume recovery refused: ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }
  if (state.status === "completed") {
    console.log(`[vda] run ${runId} already completed`);
    return;
  }
  // A run aborted at a cap is resumed by raising that cap.
  const maxExchanges = flags.get("max-exchanges");
  if (maxExchanges !== undefined) {
    state.config.maxExchanges = positiveIntegerFlag(maxExchanges, "max-exchanges");
  }
  const wallMinutes = flags.get("wall-minutes");
  if (wallMinutes !== undefined) {
    state.config.maxWallMinutes = positiveIntegerFlag(wallMinutes, "wall-minutes");
  }
  state.status = "running";
  state.statusReason = undefined;
  console.log(`[vda] resuming ${runId} at exchange ${state.exchanges}, pending → ${state.pending?.to ?? "start"}`);
  await execCampaign(runDir, state);
}

/**
 * Post-hoc reader test for a run whose designer skipped it (older runs) or
 * for re-examining a finished design with fresh eyes. Appends the three
 * reader reports to the transcript, writes reader-reports.md, regenerates
 * report.md.
 */
async function cmdReaders(args: string[]): Promise<void> {
  const { positional } = parseFlags(args);
  const runId = positional[0];
  if (!runId) {
    console.error("usage: vda readers <runId>");
    process.exitCode = 2;
    return;
  }
  const runDir = join(runsRoot, runId);
  const state = loadState(runDir);
  const readers = new ClaudeReaderRunner({
    model: state.config.readerModel,
    authMode: state.config.claudeAuth,
  });
  const transcript = new Transcript(runDir, state.seq);
  const personas = ["operator", "new-engineer", "coding-agent"] as const;
  console.log(`[vda] running post-hoc reader test for ${runId} (3 fresh contexts)`);
  const reports = await Promise.all(
    personas.map(async (p) => ({ persona: p, text: await readers.run(p, state.workspace) })),
  );
  for (const r of reports) {
    transcript.append({ role: `reader:${r.persona}`, text: r.text });
  }
  state.readersRan = true;
  state.seq = transcript.nextSeq();
  state.updatedAt = new Date().toISOString();
  saveState(runDir)(state);
  const md = reports.map((r) => `# Reader: ${r.persona}\n\n${r.text.trim()}`).join("\n\n---\n\n");
  writeFileSync(join(runDir, "reader-reports.md"), `${md}\n`);
  generateReport(runDir);
  console.log(`[vda] reader reports: ${join(runDir, "reader-reports.md")}`);
}

/**
 * Post-hoc audit: one fresh audit iteration against any completed run (like
 * `vda readers`), without the feedback loop. Writes audit-report-N.md to the
 * run dir and workspace/validation-design/audit/, appends the report to the
 * transcript, and regenerates report.md. It never touches state.audit — the
 * in-campaign audit machine's bookkeeping stays authoritative for runs that
 * went through the loop.
 */
async function cmdAudit(args: string[]): Promise<void> {
  const { positional, flags } = parseFlags(args);
  const runId = positional[0];
  if (!runId) {
    console.error("usage: vda audit <runId> [--auditor-model M]");
    process.exitCode = 2;
    return;
  }
  const runDir = join(runsRoot, runId);
  const state = loadState(runDir);
  if (state.status !== "completed") {
    console.error(`run ${runId} is ${state.status}; post-hoc audit expects a completed run (use vda resume)`);
    process.exitCode = 2;
    return;
  }
  if (state.target) {
    try {
      prepareLegacyTargetState(runDir, state);
      if (!state.targetBase) throw new Error("targetBase recovery did not produce an immutable snapshot");
      verifyTargetSnapshot(state.workspace, state.targetBase);
    } catch (err) {
      console.error(`[vda] post-hoc audit refused before live spend: ${(err as Error).message}`);
      process.exitCode = 2;
      return;
    }
  }
  ensureAuditSkill(repoRoot, state.workspace);
  const model =
    flags.get("auditor-model") ?? state.config.auditorModel ?? state.config.designerModel;
  const auditor = new ClaudeAuditorRunner({ model, authMode: state.config.claudeAuth });
  // Iteration 2 (AUD-2xx, verification rubric) is reserved for the
  // in-campaign loop; a post-hoc audit is always first-pass-style, so its
  // iteration number skips from 1 to 3.
  const iteration = nextPostHocAuditIteration(readTranscript(runDir));
  console.log(`[vda] running post-hoc audit of ${runId} (iteration ${iteration}, model ${model}, fresh context)`);
  const coreAtStart = auditedCoreFingerprint(state.workspace);
  const text = await auditor.run(auditorPrompt(iteration), state.workspace);
  try {
    if (state.targetBase) verifyTargetSnapshot(state.workspace, state.targetBase);
    if (auditedCoreFingerprint(state.workspace) !== coreAtStart) {
      throw new Error("the audited design core changed during the live pass");
    }
  } catch (err) {
    console.error(`[vda] post-hoc audit INVALIDATED: ${(err as Error).message}`);
    console.error("[vda] no transcript entry or audit report was written");
    process.exitCode = 2;
    return;
  }
  const validation = validateAuditReport(text, iteration, [], {
    requireBlindSource:
      iteration !== 2 && existsSync(join(state.workspace, "TARGET-SNAPSHOT.md")),
  });
  const transcript = new Transcript(runDir, state.seq);
  transcript.append({
    role: "auditor",
    text,
    note: `audit-iteration-${iteration} (post-hoc${validation.problems.length > 0 ? ", protocol violation" : ""})`,
  });
  saveAuditFile(runDir, state.workspace)(`audit-report-${iteration}.md`, text);
  state.seq = transcript.nextSeq();
  state.updatedAt = new Date().toISOString();
  saveState(runDir)(state);
  generateReport(runDir);
  console.log(`[vda] audit report: ${join(runDir, `audit-report-${iteration}.md`)}`);
  console.log(`[vda] report.md regenerated`);
  if (validation.problems.length > 0) {
    console.error("[vda] AUDIT PROTOCOL VIOLATION — the report is incomplete or malformed:");
    for (const problem of validation.problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
  }
}

/**
 * Fidelity audit (issue #7): a standalone judgment pass over a PRODUCT REPO,
 * scoped per wave or ticket set. Live — spends Claude quota (one fresh
 * session). Refuses when the trace CLI is red: fix closure before asking for
 * judgment. Findings only — a report containing a patch is flagged as a
 * protocol violation. Not part of any campaign state machine.
 */
async function cmdFidelity(args: string[]): Promise<void> {
  const { positional, flags } = parseFlags(args);
  const targetRoot = positional[0];
  if (!targetRoot) {
    console.error(`usage: vda fidelity <target-repo> [--wave W | --tickets HB-001,HB-002]\n  [--manifest path] [--tests path] [--out report.md]\n  [--auditor-model M] [--claude-auth subscription|api-key]`);
    process.exitCode = 2;
    return;
  }
  const target = resolve(targetRoot);
  const auditor = new ClaudeAuditorRunner({
    model: flags.get("auditor-model") ?? "claude-fable-5",
    authMode: claudeAuthFlag(flags.get("claude-auth")),
  });
  const wave = flags.get("wave");
  const ticketsFlag = flags.get("tickets");
  const manifestPath = flags.get("manifest");
  const testsRoot = flags.get("tests");
  console.log(`[vda] fidelity audit of ${target} (${wave !== undefined ? `wave ${wave}` : ticketsFlag ? `tickets ${ticketsFlag}` : "all waves"}; fresh context, live Claude session)`);
  let bound;
  try {
    bound = await runBoundFidelityAudit(auditor, target, {
      ...(wave !== undefined ? { wave } : {}),
      ...(ticketsFlag ? { tickets: ticketsFlag.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
      ...(manifestPath !== undefined ? { manifestPath } : {}),
      ...(testsRoot !== undefined ? { testsRoot } : {}),
    });
  } catch (err) {
    console.error(`[vda] REFUSED/INVALIDATED: ${(err as Error).message}`);
    console.error("[vda] no fidelity report or registry evidence was written");
    process.exitCode = 2;
    return;
  }
  const { result, targetRevision } = bound;

  if (result.status === "refused-closure") {
    console.error("[vda] REFUSED: closure is red — fix these before asking for judgment:");
    for (const r of result.reds) console.error(`  - ${r}`);
    process.exitCode = 2;
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outPath = flags.get("out") ?? join(runsRoot, "fidelity", `${basename(target)}-${stamp}.md`);
  mkdirSync(join(outPath, ".."), { recursive: true });
  writeFileSync(outPath, result.report);
  recordFidelity(
    registryPath,
    target,
    {
      at: new Date().toISOString(),
      scope: result.scope?.label ?? "unknown",
      status: result.status,
      findings: result.findings.length,
      blocking: result.findings.filter((f) => f.tier === "blocking").length,
    },
    targetRevision,
  );
  console.log(`[vda] fidelity report: ${outPath}`);
  console.log(`[vda] findings: ${result.findings.length}${result.findings.length > 0 ? ` (${result.findings.map((f) => `${f.id}:${f.tier}`).join(", ")})` : ""}`);
  if (result.violations.length > 0) {
    console.error("[vda] PROTOCOL VIOLATION — the report contains remediation content (findings only is the contract):");
    for (const v of result.violations) console.error(`  - ${v}`);
    process.exitCode = 1;
  }
}

function cmdReport(args: string[]): void {
  const { positional } = parseFlags(args);
  const runId = positional[0];
  if (!runId) {
    console.error("usage: vda report <runId>");
    process.exitCode = 2;
    return;
  }
  const md = generateReport(join(runsRoot, runId));
  console.log(md);
}

/**
 * The fleet staleness query (#8): which repos run a stale design, which have
 * never had a fidelity audit, which have findings open. Extra paths are
 * checked against the registry and reported UNKNOWN when absent — no green
 * by absence.
 */
function cmdRepos(args: string[]): void {
  const { positional, flags } = parseFlags(args);
  const reg = loadRegistry(registryPath);
  const staleDaysFlag = flags.get("stale-days");
  const lines = repoStatuses(reg, positional.map((p) => resolve(p)), {
    ...(staleDaysFlag !== undefined
      ? { staleDays: nonNegativeIntegerFlag(staleDaysFlag, "stale-days") }
      : {}),
  });
  console.log(renderRepos(lines));
}

function cmdList(): void {
  if (!existsSync(runsRoot)) {
    console.log("(no runs)");
    return;
  }
  for (const id of readdirSync(runsRoot).sort()) {
    const sp = statePath(join(runsRoot, id));
    if (!existsSync(sp)) continue;
    const s = JSON.parse(readFileSync(sp, "utf8")) as RunState;
    console.log(`${id}\t${s.status}${s.statusReason ? ` (${s.statusReason})` : ""}\texchanges=${s.exchanges}`);
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "run":
      await cmdRun(rest);
      break;
    case "resume":
      await cmdResume(rest);
      break;
    case "readers":
      await cmdReaders(rest);
      break;
    case "audit":
      await cmdAudit(rest);
      break;
    case "fidelity":
      await cmdFidelity(rest);
      break;
    case "report":
      cmdReport(rest);
      break;
    case "deliver":
      cmdDeliver(rest);
      break;
    case "repos":
      cmdRepos(rest);
      break;
    case "list":
      cmdList();
      break;
    default:
      console.error("usage: vda <run|resume|readers|audit|fidelity|report|deliver|repos|list> ...");
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(`[vda] fatal: ${(err as Error).stack ?? String(err)}`);
  process.exitCode = 1;
});
