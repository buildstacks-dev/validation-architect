/**
 * validation-architect-design — starts or resumes a local design campaign by
 * composing the core's public design()/resume() with the three local
 * adapters. The CLI is the publisher: by default the finished bundle is
 * written NOWHERE; `--out <dir>` writes the bundle files under that
 * directory. `--help` works offline and performs no SDK import or call
 * (the provider port is loaded lazily, only when a campaign actually runs).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  canonicalProvenance,
  design,
  isPublicContractError,
  resume,
  type DesignOutcome,
  type ProfileTier,
} from "validation-architect";
import { LocalRepository } from "./local-repository.js";
import { LocalCampaignStore } from "./local-store.js";

const PROFILES: readonly ProfileTier[] = ["C0", "C1", "C2", "C3", "C4"];

const USAGE = `usage:
  validation-architect-design [target-dir] --profile <C0|C1|C2|C3|C4> --intake-file <file>
      [--run-id <id>] [--state-dir <dir>] [--out <dir>] [--allow-dirty]
      [--model-designer <m>] [--model-stakeholder <m>] [--model-auditor <m>] [--model-reader <m>]
      Start a design campaign against <target-dir> (default "."). The state
      directory defaults to <target-dir>/.validation-architect/design-runs
      and is always printed. The bundle is written nowhere unless --out is
      given — the CLI is the publisher, the library never writes.

  validation-architect-design resume <runId> [target-dir] [--state-dir <dir>] [--out <dir>]
      [--allow-dirty] [--model-designer <m>] [--model-stakeholder <m>] [--model-auditor <m>] [--model-reader <m>]
      Resume an INTERRUPTED campaign from its checkpoint (same package
      version, same source revision, untouched envelope). A settled failed
      run stays failed.

exit codes: 0 complete · 1 incomplete/contract failure · 2 usage error`;

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string>;
  help: boolean;
}

const BOOLEAN_FLAGS = new Set(["allow-dirty", "help"]);

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

function stateDirectory(flags: Map<string, string>, targetDir: string, stderr: (line: string) => void): string {
  const explicit = flags.get("state-dir");
  const directory = resolve(explicit ?? join(targetDir, ".validation-architect", "design-runs"));
  stderr(`[validation-architect-design] state directory: ${directory}${explicit ? "" : " (default)"}`);
  return directory;
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
    for (const file of bundle.files) {
      const target = join(outDir, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content);
    }
    const provenancePath = join(outDir, "provenance.json");
    mkdirSync(dirname(provenancePath), { recursive: true });
    writeFileSync(provenancePath, `${canonicalProvenance(bundle.provenance)}\n`);
    stdout(`bundle written: ${bundle.files.length} file(s) + provenance.json under ${resolve(outDir)}`);
  } else {
    stdout(`bundle: ${bundle.files.length} unwritten file(s); pass --out <dir> to publish them`);
  }
  return 0;
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

  const isResume = args.positional[0] === "resume";
  try {
    const allowDirty = args.flags.has("allow-dirty");

    if (isResume) {
      const runId = args.positional[1];
      if (!runId) {
        io.stderr(USAGE);
        return 2;
      }
      const targetDir = resolve(args.positional[2] ?? ".");
      // The provider port (and with it the SDK modules) loads only when a
      // campaign actually runs; --help and usage errors never touch it.
      const { LocalTurnPort } = await import("./provider-port.js");
      const store = new LocalCampaignStore({ directory: stateDirectory(args.flags, targetDir, io.stderr) });
      const outcome = await resume(runId, {
        repository: new LocalRepository({ root: targetDir, allowDirty }),
        turns: new LocalTurnPort({ workspace: targetDir, models: models(args.flags) }),
        store,
      });
      return reportOutcome(outcome, args.flags.get("out"), io.stdout);
    }

    const targetDir = resolve(args.positional[0] ?? ".");
    const profile = args.flags.get("profile");
    if (!profile || !(PROFILES as readonly string[]).includes(profile)) {
      io.stderr(`validation-architect-design: --profile must be one of ${PROFILES.join(", ")}`);
      return 2;
    }
    const intakeFile = args.flags.get("intake-file");
    if (!intakeFile) {
      io.stderr("validation-architect-design: --intake-file <file> is required (the campaign's product summary and sources)");
      return 2;
    }
    const intake = readFileSync(resolve(intakeFile), "utf8");
    const runId =
      args.flags.get("run-id") ?? `design-${new Date().toISOString().replaceAll(/[:.]/g, "-").slice(0, 19)}`;
    io.stderr(`[validation-architect-design] run id: ${runId}`);
    // Lazy provider-port import: after every usage gate, before the campaign.
    const { LocalTurnPort } = await import("./provider-port.js");
    const store = new LocalCampaignStore({ directory: stateDirectory(args.flags, targetDir, io.stderr) });
    const outcome = await design(
      { runId, profile: profile as ProfileTier, intake },
      {
        repository: new LocalRepository({ root: targetDir, allowDirty }),
        turns: new LocalTurnPort({ workspace: targetDir, models: models(args.flags) }),
        store,
      },
    );
    return reportOutcome(outcome, args.flags.get("out"), io.stdout);
  } catch (error) {
    if (isPublicContractError(error)) {
      io.stderr(`[validation-architect-design] ${error.code}: ${error.message}`);
      return 1;
    }
    io.stderr(`[validation-architect-design] error: ${(error as Error).message}`);
    return 1;
  }
}
