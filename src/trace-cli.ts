import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runTrace } from "./trace.js";
import { runModelTrace } from "./model-trace.js";

/**
 * validation-trace — the DEPRECATED ALIAS for `validation-architect check`
 * (decision record 2026-08-15, Decision 2). Retained through 0.x, removed at
 * 1.0: every invocation prints one deterministic warning line on stderr and
 * then behaves exactly as before for the check path — the warning never
 * alters exit status. The former `generate` subcommand is superseded by the
 * supported `validation-architect compile` workflow.
 */

export const TRACE_ALIAS_DEPRECATION =
  'validation-trace is a deprecated alias for "validation-architect check" and will be removed at 1.0.';

const USAGE = `usage:
  validation-trace <target-repo> [--model <path> | --manifest <path>] [--tests <path>] [--out <report.md>] [--quiet]
      --model runs the current checked-model relationship graph. --manifest
      preserves the explicit legacy catalog/header inventory adapter.
      Exit code: 0 all green, 1 any red, 2 usage/setup error.

  Deprecated alias: prefer "validation-architect check". The former
  "validation-trace generate" subcommand moved to "validation-architect
  compile".`;

function parseFlags(argv: string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("-") && a !== "-") {
      const key = a.replace(/^--?/, "");
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
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

function cmdGenerate(): number {
  // Decision-record disposition: `generate` migrated to the compile workflow.
  console.error(
    'validation-trace generate has been removed: the supported workflow is "validation-architect compile", which validates the corpus and regenerates its views (use --write to write them).',
  );
  return 2;
}

function cmdCheck(args: string[]): number {
  const { positional, flags } = parseFlags(args);
  const target = positional[0];
  if (!target) {
    console.error(USAGE);
    return 2;
  }
  const opts: Parameters<typeof runTrace>[1] = {};
  const manifest = flags.get("manifest");
  // Resolve --manifest against cwd so an absolute OR cwd-relative path works
  // when the enablement bundle hasn't been installed into the target yet
  // (the Operon pilot smoke case).
  if (manifest) opts.manifestPath = resolve(manifest);
  const tests = flags.get("tests");
  if (tests) opts.testsRoot = tests;

  const model = flags.get("model");
  const result = model
    ? runModelTrace(resolve(target), { modelPath: model, ...(tests ? { testsRoot: tests } : {}) })
    : runTrace(resolve(target), opts);
  const out = flags.get("out");
  if (out) writeFileSync(resolve(out), result.report);
  if (flags.get("quiet") !== "true") process.stdout.write(result.report);
  if (!result.ok) {
    console.error(`\n[validation-trace] RED — ${result.reds.length} finding(s):`);
    for (const r of result.reds) console.error(`  - ${r}`);
    return 1;
  }
  console.error(model
    ? "\n[validation-trace] green — checked-model relationship closure holds; fidelity remains separate."
    : "\n[validation-trace] green — legacy agreement, spec structure, forward, backward, and status-honesty closure hold.");
  return 0;
}

// One deterministic deprecation line on stderr on EVERY invocation; the
// warning never alters exit status (Decision 2).
console.error(TRACE_ALIAS_DEPRECATION);

const [first, ...rest] = process.argv.slice(2);
if (first === "generate") {
  process.exitCode = cmdGenerate();
} else if (first === "--help" || first === "-h") {
  console.log(USAGE);
  process.exitCode = 0;
} else if (first === undefined) {
  console.error(USAGE);
  process.exitCode = 2;
} else {
  process.exitCode = cmdCheck([first, ...rest]);
}
