/**
 * validation-architect-design — starts or resumes a local design campaign by
 * composing the core's public design()/resume() with the three local
 * adapters. The CLI is the publisher: by default the finished bundle is
 * written NOWHERE; `--out <dir>` writes the bundle files under that
 * directory. `--help` works offline and performs no SDK import or call
 * (the provider port is loaded lazily, only when a campaign actually runs).
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  canonicalProvenance,
  design,
  isPublicContractError,
  resume,
  type DesignOutcome,
  type ProfileTier,
} from "../api/index.js";
import { LocalCampaignStore } from "./local-store.js";
import { captureRunContext, listRunContexts, loadRunContext, type RunContext } from "./run-context.js";
import { RunRepository } from "./run-repository.js";
import { materializeFixtureTarget, packagedFixtureDirectory } from "./fixtures.js";
import { deliverRun } from "./delivery.js";
import { runPostHocAudit, runPostHocReaders } from "./posthoc.js";
import { runFidelity } from "./fidelity.js";
import {
  recordCampaignCompletion,
  recordDeliveryCompletion,
  evaluateFleetStatus,
  registryEntries,
  registryStatus,
  recordFidelityCompletion,
} from "./registry.js";

const PROFILES: readonly ProfileTier[] = ["C0", "C1", "C2", "C3", "C4"];

const USAGE = `usage:
  validation-architect-design [target-dir] --profile <C0|C1|C2|C3|C4> [--intake-file <file>]
      [--run-id <id>] [--state-dir <dir>] [--out <dir>]
      [--model-designer <m>] [--model-stakeholder <m>] [--model-auditor <m>] [--model-reader <m>]
      [--claude-auth <subscription|api-key>] [--codex-auth <chatgpt|api-key>]
      Start a design campaign against <target-dir> (default "."). Optional
      intake augments repository docs; when absent, intent derives
      from the admitted repository snapshot. State defaults outside the target
      under the user state home and is always printed. The bundle is written
      nowhere unless --out is given.

  validation-architect-design resume <runId> [target-dir] [--state-dir <dir>] [--out <dir>]
      [--model-designer <m>] [--model-stakeholder <m>] [--model-auditor <m>] [--model-reader <m>]
      [--claude-auth <subscription|api-key>] [--codex-auth <chatgpt|api-key>]
      Resume an INTERRUPTED campaign from its checkpoint (same package
      version, same source revision, untouched envelope). A settled failed
      run stays failed.

  validation-architect-design fixture <name> [--profile <C0|C1|C2|C3|C4>] [--smoke]
      [--run-id <id>] [--state-dir <dir>] [--out <dir>]
      Run a packaged synthetic fixture through the same public engine. --smoke
      defaults to C3 and tightens admission to one turn, ending by limit.

  validation-architect-design list [target-dir] [--state-dir <dir>]
      List public-checkpoint runs for the target state home. Historical
      repository-local run directories are never discovered.

  validation-architect-design report <runId> [target-dir] [--state-dir <dir>]
      Render a human-readable report from public checkpoint and immutable
      run metadata only. No provider is loaded.

  validation-architect-design deliver <runId> [target-dir] [--state-dir <dir>]
      Idempotently land a completed public checkpoint on its captured base in
      validation-design/<runId>, without touching the user checkout.

  validation-architect-design repos [target-dir ...] [--state-dir <dir>]
      Show the offline fleet registry. A target absent from the registry is
      UNKNOWN, never healthy by default.

  validation-architect-design readers <runId> [target-dir] [provider flags]
      Run three fresh post-hoc readers over a completed public bundle. Live:
      spends Claude quota, writes operational evidence, never campaign state.

  validation-architect-design audit <runId> [target-dir] [provider flags]
      Run one fresh post-hoc audit over a completed public bundle. Live:
      spends Claude quota, writes operational evidence, never campaign state.

  validation-architect-design fidelity <target-dir> [--wave <n> | --tickets <ids>]
      [--run-id <id>] [--state-dir <dir>] [auditor model/auth flags]
      Run one immutable, closure-gated, findings-only fidelity audit. Live:
      spends Claude quota and can never patch the target.

exit codes: 0 complete · 1 incomplete/contract failure · 2 usage error`;

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string>;
  help: boolean;
}

const BOOLEAN_FLAGS = new Set(["help", "smoke"]);
const VALUE_FLAGS = new Set([
  "profile", "intake-file", "run-id", "state-dir", "out",
  "model-designer", "model-stakeholder", "model-auditor", "model-reader",
  "claude-auth", "codex-auth",
  "wave", "tickets",
]);
const COMMON_FLAGS = [
  "state-dir", "out", "model-designer", "model-stakeholder", "model-auditor", "model-reader",
  "claude-auth", "codex-auth",
];
const START_FLAGS = new Set([...COMMON_FLAGS, "profile", "intake-file", "run-id"]);
const FIXTURE_FLAGS = new Set([...START_FLAGS, "smoke"]);
const RESUME_FLAGS = new Set(COMMON_FLAGS);
const INSPECT_FLAGS = new Set(["state-dir"]);
const FIDELITY_FLAGS = new Set(["state-dir", "run-id", "wave", "tickets", "model-auditor", "claude-auth"]);

class UsageError extends Error {}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i] as string;
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument.startsWith("--")) {
      const key = argument.slice(2);
      if (!BOOLEAN_FLAGS.has(key) && !VALUE_FLAGS.has(key)) throw new UsageError(`unknown flag --${key}`);
      if (BOOLEAN_FLAGS.has(key)) {
        flags.set(key, "true");
        continue;
      }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`flag --${key} requires a value`);
      flags.set(key, value);
      i++;
      continue;
    }
    positional.push(argument);
  }
  return { positional, flags, help };
}

function models(flags: Map<string, string>): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const seat of ["designer", "stakeholder", "auditor", "reader"] as const) {
    const value = flags.get(`model-${seat}`);
    if (value) overrides[seat] = value;
  }
  return overrides;
}

function turnConfiguration(flags: Map<string, string>): {
  models: Record<string, string>;
  claudeAuth: "subscription" | "api-key";
  codexAuth: "chatgpt" | "api-key";
} {
  const claudeAuth = flags.get("claude-auth") ?? "subscription";
  const codexAuth = flags.get("codex-auth") ?? "chatgpt";
  if (claudeAuth !== "subscription" && claudeAuth !== "api-key") {
    throw new UsageError("--claude-auth must be subscription or api-key");
  }
  if (codexAuth !== "chatgpt" && codexAuth !== "api-key") {
    throw new UsageError("--codex-auth must be chatgpt or api-key");
  }
  return { models: models(flags), claudeAuth, codexAuth };
}

export function defaultStateDirectory(targetDir: string): string {
  const stateHome = process.env["XDG_STATE_HOME"] || join(homedir(), ".local", "state");
  const target = existsSync(targetDir) ? realpathSync.native(targetDir) : resolve(targetDir);
  const targetKey = createHash("sha256").update(target).digest("hex").slice(0, 16);
  return join(stateHome, "validation-architect", "design-runs", targetKey);
}

function stateDirectory(flags: Map<string, string>, targetDir: string, stderr: (line: string) => void): string {
  const explicit = flags.get("state-dir");
  const directory = resolve(explicit ?? defaultStateDirectory(targetDir));
  stderr(`[validation-architect-design] state directory: ${directory}${explicit ? "" : " (default)"}`);
  return directory;
}

function registryPath(flags: Map<string, string>): string {
  const explicit = flags.get("state-dir");
  const stateHome = process.env["XDG_STATE_HOME"] || join(homedir(), ".local", "state");
  return explicit
    ? join(resolve(explicit), "registry.json")
    : join(stateHome, "validation-architect", "registry.json");
}

function bundleTarget(outputRoot: string, path: string): string {
  const target = resolve(outputRoot, path);
  const rel = relative(outputRoot, target);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(`Bundle path escapes --out: ${path}`);
  let directory = outputRoot;
  for (const segment of relative(outputRoot, dirname(target)).split(sep).filter(Boolean)) {
    directory = join(directory, segment);
    if (!existsSync(directory)) break;
    const entry = lstatSync(directory);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Bundle output parent is not a real directory: ${directory}`);
    }
  }
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error(`Bundle output refuses to follow a symlink: ${target}`);
  }
  return target;
}

function writeBundleFile(outputRoot: string, path: string, content: string): void {
  const target = bundleTarget(outputRoot, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function reportOutcome(
  outcome: DesignOutcome,
  outDir: string | undefined,
  stdout: (line: string) => void,
): number {
  if (outcome.status === "incomplete") {
    stdout(`incomplete (${outcome.reason}) at generation ${outcome.checkpoint.generation}, position ${outcome.checkpoint.position}`);
    stdout(`next action: ${outcome.nextAction}`);
    return 1;
  }
  const bundle = outcome.bundle;
  stdout(`complete: run ${bundle.provenance.runId} at revision ${bundle.provenance.sourceRevision}`);
  stdout(
    `profile ${bundle.profileAssessment.selected}; minimum supported by findings ${bundle.profileAssessment.minimumSupportedByFindings}; escalation required: ${bundle.profileAssessment.escalationRequired}`,
  );
  stdout(
    bundle.audit.status === "performed"
      ? `audit: performed, verdict ${bundle.audit.verdict}, ${bundle.audit.findings.length} finding(s)`
      : `audit: ${bundle.audit.status}`,
  );
  stdout(`usage: ${bundle.usage.turns} turns, ${bundle.usage.inputTokens} in / ${bundle.usage.outputTokens} out tokens`);
  if (outDir) {
    mkdirSync(resolve(outDir), { recursive: true });
    const outputRoot = realpathSync.native(resolve(outDir));
    const files = [
      ...bundle.files,
      { path: "provenance.json", content: `${canonicalProvenance(bundle.provenance)}\n` },
    ];
    for (const file of files) bundleTarget(outputRoot, file.path);
    for (const file of files) writeBundleFile(outputRoot, file.path, file.content);
    stdout(`bundle written: ${bundle.files.length} file(s) + provenance.json under ${resolve(outDir)}`);
  } else {
    stdout(`bundle: ${bundle.files.length} unwritten file(s); pass --out <dir> to publish them`);
  }
  return 0;
}

function checkpointStatus(checkpoint: Awaited<ReturnType<LocalCampaignStore["load"]>>): string {
  if (checkpoint === null) return "missing-checkpoint";
  if (checkpoint.pendingTurn) return "interrupted";
  const last = checkpoint.receipts.at(-1);
  if (last && (last.status !== "ok" || last.accepted === false)) return "failed";
  return checkpoint.envelope.terminals.includes(checkpoint.position) ? "complete" : "interrupted";
}

function renderRunReport(context: RunContext, checkpoint: NonNullable<Awaited<ReturnType<LocalCampaignStore["load"]>>>): string {
  const artifacts = Object.keys(checkpoint.artifacts).sort();
  const transcript = checkpoint.receipts.flatMap((receipt, index) => [
    `### Turn ${index + 1}: ${receipt.seat.seat}:${receipt.seat.instance}`,
    "",
    `- Transition: ${receipt.state} → ${receipt.nextState}`,
    `- Status: ${receipt.status}${receipt.status === "ok" ? `; accepted: ${String(receipt.accepted)}` : ""}`,
    `- Identity: ${receipt.identity ? `${receipt.identity.provider}/${receipt.identity.model}/${receipt.identity.session}` : "(none)"}`,
    `- Text digest: ${receipt.textDigest ?? "(not retained)"}`,
    `- Usage: ${receipt.usage?.inputTokens ?? 0} input / ${receipt.usage?.outputTokens ?? 0} output tokens`,
    ...(receipt.output !== undefined ? ["", "```json", JSON.stringify(receipt.output, null, 2), "```"] : []),
    "",
  ]);
  return [
    `# Validation Architect run ${context.runId}`,
    "",
    `- Status: ${checkpointStatus(checkpoint)}`,
    `- Profile: ${context.profile}`,
    `- Source revision: ${context.sourceRevision}`,
    `- Immutable snapshot: ${context.snapshot}`,
    `- Position: ${checkpoint.position}`,
    `- Generation: ${checkpoint.generation}`,
    `- Usage: ${checkpoint.usage.turns} turns; ${checkpoint.usage.inputTokens} input / ${checkpoint.usage.outputTokens} output tokens`,
    `- Artifacts: ${artifacts.length}`,
    "",
    "## Artifact paths",
    "",
    ...(artifacts.length > 0 ? artifacts.map((path) => `- ${path}`) : ["(none)"]),
    "",
    "## Transcript projection",
    "",
    ...(transcript.length > 0 ? transcript : ["(no settled turns)"]),
  ].join("\n");
}

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const defaultIo: CliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

export async function main(argv: string[], io: CliIo = defaultIo): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.stderr(`validation-architect-design: ${(error as Error).message}`);
    io.stderr(USAGE);
    return 2;
  }
  if (args.help || argv.length === 0) {
    (args.help ? io.stdout : io.stderr)(USAGE);
    return args.help ? 0 : 2;
  }

  const command = ["resume", "fixture", "list", "report", "deliver", "repos", "readers", "audit", "fidelity"].includes(args.positional[0] ?? "")
    ? args.positional[0]
    : "start";
  const isResume = command === "resume";
  try {
    const allowedFlags = command === "start"
      ? START_FLAGS
      : command === "fixture"
        ? FIXTURE_FLAGS
        : command === "fidelity"
          ? FIDELITY_FLAGS
          : isResume || command === "readers" || command === "audit"
          ? RESUME_FLAGS
          : INSPECT_FLAGS;
    for (const key of args.flags.keys()) {
      if (!allowedFlags.has(key)) throw new UsageError(`flag --${key} is not valid for ${command}`);
    }
    if (command === "list") {
      if (args.positional.length > 2) throw new UsageError("list accepts at most one target directory");
      const targetDir = resolve(args.positional[1] ?? ".");
      const stateDir = stateDirectory(args.flags, targetDir, io.stderr);
      const store = new LocalCampaignStore({ directory: stateDir });
      for (const context of listRunContexts(stateDir)) {
        io.stdout(`${context.runId}\t${checkpointStatus(await store.load(context.runId))}\t${context.profile}\t${context.sourceRevision}`);
      }
      return 0;
    }
    if (command === "repos") {
      const registry = registryPath(args.flags);
      const requested = args.positional.slice(1).map((target) => resolve(target));
      if (requested.length === 0) {
        for (const entry of registryEntries(registry)) {
          io.stdout(`${entry.target}\t${evaluateFleetStatus(entry, entry.target)}\t${entry.campaign?.runId ?? "-"}`);
        }
      } else {
        for (const target of requested) {
          const entry = registryStatus(registry, target);
          io.stdout(`${target}\t${evaluateFleetStatus(entry, target)}\t${entry?.campaign?.runId ?? "-"}`);
        }
      }
      return 0;
    }
    if (command === "report") {
      const runId = args.positional[1];
      if (!runId) {
        io.stderr(USAGE);
        return 2;
      }
      if (args.positional.length > 3) throw new UsageError("report accepts only <runId> and one target directory");
      const targetDir = resolve(args.positional[2] ?? ".");
      const stateDir = stateDirectory(args.flags, targetDir, io.stderr);
      const context = loadRunContext(stateDir, runId);
      const checkpoint = await new LocalCampaignStore({ directory: stateDir }).load(runId);
      if (!checkpoint) throw new Error(`run ${runId} has metadata but no public checkpoint`);
      io.stdout(renderRunReport(context, checkpoint));
      return 0;
    }
    if (command === "deliver") {
      const runId = args.positional[1];
      if (!runId) {
        io.stderr(USAGE);
        return 2;
      }
      if (args.positional.length > 3) throw new UsageError("deliver accepts only <runId> and one target directory");
      const targetDir = resolve(args.positional[2] ?? ".");
      const stateDir = stateDirectory(args.flags, targetDir, io.stderr);
      const context = loadRunContext(stateDir, runId);
      const checkpoint = await new LocalCampaignStore({ directory: stateDir }).load(runId);
      if (!checkpoint) throw new Error(`run ${runId} has metadata but no public checkpoint`);
      const delivery = deliverRun(context, checkpoint);
      recordDeliveryCompletion(registryPath(args.flags), context, delivery);
      io.stdout(`delivered ${runId} to ${delivery.branch} at ${delivery.commit}`);
      return 0;
    }
    if (command === "readers" || command === "audit") {
      const runId = args.positional[1];
      if (!runId) {
        io.stderr(USAGE);
        return 2;
      }
      if (args.positional.length > 3) throw new UsageError(`${command} accepts only <runId> and one target directory`);
      const targetDir = resolve(args.positional[2] ?? ".");
      const turnConfig = turnConfiguration(args.flags);
      const stateDir = stateDirectory(args.flags, targetDir, io.stderr);
      const context = loadRunContext(stateDir, runId);
      const checkpoint = await new LocalCampaignStore({ directory: stateDir }).load(runId);
      if (!checkpoint) throw new Error(`run ${runId} has metadata but no public checkpoint`);
      const { LocalTurnPort } = await import("./provider-port.js");
      const turns = new LocalTurnPort({ workspace: context.snapshot, stateDirectory: stateDir, ...turnConfig });
      if (command === "audit") {
        const result = await runPostHocAudit(checkpoint, turns, stateDir);
        io.stdout(`post-hoc audit written to ${result.path}`);
      } else {
        const result = await runPostHocReaders(checkpoint, turns, stateDir);
        io.stdout(`post-hoc readers written to ${result.path}`);
      }
      return 0;
    }
    if (command === "fidelity") {
      const target = args.positional[1];
      if (!target || args.positional.length > 2) throw new UsageError("fidelity requires exactly one target directory");
      const waveRaw = args.flags.get("wave");
      const ticketsRaw = args.flags.get("tickets");
      if (waveRaw && ticketsRaw) throw new UsageError("fidelity accepts --wave or --tickets, not both");
      const wave = waveRaw === undefined ? undefined : Number(waveRaw);
      if (wave !== undefined && (!Number.isInteger(wave) || wave < 1)) throw new UsageError("--wave must be a positive integer");
      const tickets = ticketsRaw?.split(",").map((item) => item.trim()).filter(Boolean);
      if (ticketsRaw !== undefined && tickets?.length === 0) throw new UsageError("--tickets must name at least one ticket");
      const targetDir = resolve(target);
      const stateDir = stateDirectory(args.flags, targetDir, io.stderr);
      const operationId = args.flags.get("run-id") ?? `fidelity-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
      io.stderr(`[validation-architect-design] fidelity operation id: ${operationId}`);
      const turnConfig = turnConfiguration(args.flags);
      const { LocalTurnPort } = await import("./provider-port.js");
      const result = await runFidelity({
        target: targetDir,
        stateDirectory: stateDir,
        operationId,
        ...(wave !== undefined ? { scope: { wave } } : tickets ? { scope: { tickets } } : {}),
      }, (workspace) => new LocalTurnPort({ workspace, stateDirectory: stateDir, ...turnConfig }));
      const findings = Array.isArray(result.output.findings) ? result.output.findings.length : 0;
      recordFidelityCompletion(
        registryPath(args.flags),
        targetDir,
        result.sourceRevision,
        result.output.verdict === "clean" && findings === 0 ? "clean" : "findings",
      );
      io.stdout(`fidelity evidence written to ${result.path}`);
      return 0;
    }
    if (isResume) {
      const runId = args.positional[1];
      if (!runId) {
        io.stderr(USAGE);
        return 2;
      }
      if (args.positional.length > 3) throw new UsageError("resume accepts only <runId> and one target directory");
      const targetDir = resolve(args.positional[2] ?? ".");
      const turnConfig = turnConfiguration(args.flags);
      // The provider port (and with it the SDK modules) loads only when a
      // campaign actually runs; --help and usage errors never touch it.
      const { LocalTurnPort } = await import("./provider-port.js");
      const stateDir = stateDirectory(args.flags, targetDir, io.stderr);
      const context = loadRunContext(stateDir, runId);
      const store = new LocalCampaignStore({ directory: stateDir });
      const outcome = await resume(runId, {
        repository: new RunRepository({ root: context.snapshot, intakeSource: context.intakeSource }),
        turns: new LocalTurnPort({ workspace: context.snapshot, stateDirectory: stateDir, ...turnConfig }),
        store,
      });
      if (outcome.status === "complete") recordCampaignCompletion(registryPath(args.flags), context);
      return reportOutcome(outcome, args.flags.get("out"), io.stdout);
    }

    const fixtureName = command === "fixture" ? args.positional[1] : undefined;
    if (command === "fixture" && (!fixtureName || args.positional.length > 2)) {
      throw new UsageError("fixture requires exactly one packaged fixture name");
    }
    if (command === "start" && args.positional.length > 1) throw new UsageError("start accepts at most one target directory");
    const stateTarget = command === "fixture"
      ? packagedFixtureDirectory(fixtureName as string)
      : resolve(args.positional[0] ?? ".");
    const smoke = args.flags.get("smoke") === "true";
    const profile = args.flags.get("profile") ?? (smoke ? "C3" : undefined);
    if (!profile || !(PROFILES as readonly string[]).includes(profile)) {
      io.stderr(`validation-architect-design: --profile must be one of ${PROFILES.join(", ")}`);
      return 2;
    }
    const turnConfig = turnConfiguration(args.flags);
    const intakeFile = args.flags.get("intake-file");
    const runId =
      args.flags.get("run-id") ?? `design-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
    io.stderr(`[validation-architect-design] run id: ${runId}`);
    // Lazy provider-port import: after every usage gate, before the campaign.
    const { LocalTurnPort } = await import("./provider-port.js");
    const stateDir = stateDirectory(args.flags, stateTarget, io.stderr);
    const targetDir = command === "fixture"
      ? materializeFixtureTarget(fixtureName as string, stateDir, runId)
      : stateTarget;
    const store = new LocalCampaignStore({ directory: stateDir });
    const context = captureRunContext({
      runId,
      target: targetDir,
      stateDirectory: stateDir,
      profile: profile as ProfileTier,
      ...(intakeFile ? { intakeFile: resolve(intakeFile) } : {}),
      ...(fixtureName ? { fixture: fixtureName } : {}),
    });
    const repository = new RunRepository({ root: context.snapshot, intakeSource: context.intakeSource });
    const mode = await repository.readFile("validation-design/model/project.yaml") === null ? "greenfield" : "revision";
    const outcome = await design(
      {
        runId,
        profile: profile as ProfileTier,
        mode,
        ...(smoke ? { limits: { maxTurns: 1, maxWallMs: 45 * 60_000 } } : {}),
        admit: (envelope) => {
          io.stderr(`[validation-architect-design] admitted ${envelope.profile} envelope: ${envelope.limits.maxTurns} turns, ${envelope.limits.maxWallMs}ms wall`);
          return envelope;
        },
      },
      {
        repository,
        turns: new LocalTurnPort({ workspace: context.snapshot, stateDirectory: stateDir, ...turnConfig }),
        store,
      },
    );
    if (outcome.status === "complete") recordCampaignCompletion(registryPath(args.flags), context);
    return reportOutcome(outcome, args.flags.get("out"), io.stdout);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`validation-architect-design: ${error.message}`);
      return 2;
    }
    if (isPublicContractError(error)) {
      io.stderr(`[validation-architect-design] ${error.code}: ${error.message}`);
      return 1;
    }
    io.stderr(`[validation-architect-design] error: ${(error as Error).message}`);
    return 1;
  }
}
