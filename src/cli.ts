import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeAuditorRunner } from "./auditor.js";
import { ClaudeDesigner } from "./designer.js";
import { listFixtures, loadFixture } from "./fixtures.js";
import { runCampaign } from "./orchestrator.js";
import { auditorPrompt, designerKickoff, stakeholderKickoff } from "./prompts.js";
import { RambleWatcher } from "./ramble.js";
import { ClaudeReaderRunner } from "./readers.js";
import { generateReport } from "./report.js";
import { CodexStakeholder } from "./stakeholder.js";
import { Transcript, readTranscript } from "./transcript.js";
import type { ClaudeAuthMode, CodexAuthMode, RunConfig, RunState } from "./types.js";
import { assembleWorkspace, ensureAuditSkill, ramblePath } from "./workspace.js";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const runsRoot = join(repoRoot, "runs");

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
  return (s) => writeFileSync(statePath(runDir), `${JSON.stringify(s, null, 2)}\n`);
}

function loadState(runDir: string): RunState {
  return JSON.parse(readFileSync(statePath(runDir), "utf8")) as RunState;
}

function buildConfig(fixture: string, runId: string, flags: Map<string, string>): RunConfig {
  const smoke = flags.get("smoke") === "true";
  const designerModel = flags.get("designer-model") ?? "claude-fable-5";
  return {
    fixture,
    runId,
    designerModel,
    stakeholderModel: flags.get("stakeholder-model") ?? "gpt-5.6-sol",
    readerModel: flags.get("reader-model") ?? "claude-sonnet-5",
    // The auditor defaults to the designer's model: the audit needs the same
    // capability class as what produced the corpus; independence comes from
    // fresh context, not a different model.
    auditorModel: flags.get("auditor-model") ?? designerModel,
    claudeAuth: (flags.get("claude-auth") ?? "subscription") as ClaudeAuthMode,
    codexAuth: (flags.get("codex-auth") ?? "chatgpt") as CodexAuthMode,
    maxExchanges: Number(flags.get("max-exchanges") ?? (smoke ? 4 : 60)),
    maxWallMinutes: Number(flags.get("wall-minutes") ?? (smoke ? 45 : 300)),
    designerMaxTurns: Number(flags.get("designer-max-turns") ?? 250),
  };
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

async function execCampaign(runDir: string, state: RunState): Promise<void> {
  const fixture = loadFixture(repoRoot, state.fixture);
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
      designer: designerKickoff(fixture),
      stakeholder: stakeholderKickoff(repoRoot, fixture),
    },
  );

  generateReport(runDir);
  console.log(`[vda] campaign ${final.status}${final.statusReason ? ` (${final.statusReason})` : ""}`);
  console.log(`[vda] report: ${join(runDir, "report.md")}`);
  console.log(`[vda] artifacts: ${join(state.workspace, "validation-design")}`);
  if (final.status !== "completed") process.exitCode = 1;
}

async function cmdRun(args: string[]): Promise<void> {
  const { positional, flags } = parseFlags(args);
  const fixtureName = positional[0];
  if (!fixtureName) {
    console.error(`usage: vda run <fixture> [--smoke] [--max-exchanges N] [--wall-minutes N]\n  [--designer-model M] [--stakeholder-model M] [--reader-model M] [--auditor-model M]\n  [--claude-auth subscription|api-key] [--codex-auth chatgpt|api-key] [--run-id ID]\nfixtures: ${listFixtures(repoRoot).join(", ")}`);
    process.exitCode = 2;
    return;
  }
  const fixture = loadFixture(repoRoot, fixtureName);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const runId = flags.get("run-id") ?? `${fixture.name}-${stamp}`;
  const runDir = join(runsRoot, runId);
  if (existsSync(runDir)) {
    console.error(`run dir already exists: ${runDir} (use vda resume ${runId})`);
    process.exitCode = 2;
    return;
  }
  mkdirSync(runDir, { recursive: true });
  const workspace = assembleWorkspace(repoRoot, fixture, runDir);
  const config = buildConfig(fixture.name, runId, flags);
  const state: RunState = {
    runId,
    fixture: fixture.name,
    workspace,
    status: "running",
    exchanges: 0,
    seq: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config,
  };
  saveState(runDir)(state);
  console.log(`[vda] run ${runId} — fixture ${fixture.displayName}, workspace ${workspace}`);
  await execCampaign(runDir, state);
}

async function cmdResume(args: string[]): Promise<void> {
  const { positional, flags } = parseFlags(args);
  const runId = positional[0];
  if (!runId) {
    console.error("usage: vda resume <runId> [--max-exchanges N] [--wall-minutes N]");
    process.exitCode = 2;
    return;
  }
  const runDir = join(runsRoot, runId);
  const state = loadState(runDir);
  if (state.status === "completed") {
    console.log(`[vda] run ${runId} already completed`);
    return;
  }
  // A run aborted at a cap is resumed by raising that cap.
  const maxExchanges = flags.get("max-exchanges");
  if (maxExchanges !== undefined) state.config.maxExchanges = Number(maxExchanges);
  const wallMinutes = flags.get("wall-minutes");
  if (wallMinutes !== undefined) state.config.maxWallMinutes = Number(wallMinutes);
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
  ensureAuditSkill(repoRoot, state.workspace);
  const model =
    flags.get("auditor-model") ?? state.config.auditorModel ?? state.config.designerModel;
  const auditor = new ClaudeAuditorRunner({ model, authMode: state.config.claudeAuth });
  // Iteration 2 (AUD-2xx, verification rubric) is reserved for the
  // in-campaign loop; a post-hoc audit is always first-pass-style, so its
  // iteration number skips from 1 to 3.
  const priorAudits = readTranscript(runDir).filter((e) => e.role === "auditor").length;
  const iteration = priorAudits === 1 ? 3 : priorAudits + 1;
  console.log(`[vda] running post-hoc audit of ${runId} (iteration ${iteration}, model ${model}, fresh context)`);
  const text = await auditor.run(auditorPrompt(iteration), state.workspace);
  const transcript = new Transcript(runDir, state.seq);
  transcript.append({ role: "auditor", text, note: `audit-iteration-${iteration} (post-hoc)` });
  saveAuditFile(runDir, state.workspace)(`audit-report-${iteration}.md`, text);
  state.seq = transcript.nextSeq();
  state.updatedAt = new Date().toISOString();
  saveState(runDir)(state);
  generateReport(runDir);
  console.log(`[vda] audit report: ${join(runDir, `audit-report-${iteration}.md`)}`);
  console.log(`[vda] report.md regenerated`);
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
    case "report":
      cmdReport(rest);
      break;
    case "list":
      cmdList();
      break;
    default:
      console.error("usage: vda <run|resume|readers|audit|report|list> ...");
      process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(`[vda] fatal: ${(err as Error).stack ?? String(err)}`);
  process.exitCode = 1;
});
