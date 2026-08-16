/** Deprecated binary shim with one bounded pre-model cutover bridge. */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main as coreMain } from "./core-cli.js";
import { MODEL_FILES } from "./model.js";
import { runTrace } from "./trace.js";

export const TRACE_ALIAS_DEPRECATION =
  'validation-trace is a deprecated alias for "validation-architect check" and will be removed at 1.0.';
export const TRACE_LEGACY_BRIDGE_ACTIVE =
  "validation-trace legacy manifest bridge active: no checked-model files were found; this bridge is removed at 1.0.";
export const TRACE_CHECKED_MODEL_SELECTED =
  "validation-trace checked-model authority selected: --manifest has no effect and --tests maps to --tests-root.";

interface LegacyBridgeArgs {
  target: string;
  manifest?: string;
  tests?: string;
}

function parseLegacyBridge(argv: string[]): { args?: LegacyBridgeArgs; problem?: string } | null {
  if (!argv.some((argument) => argument === "--manifest" || argument === "--tests")) return null;
  const positional: string[] = [];
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index] as string;
    if (argument === "--manifest" || argument === "--tests") {
      if (values.has(argument)) return { problem: `legacy flag ${argument} may appear only once` };
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) return { problem: `legacy flag ${argument} requires a value` };
      values.set(argument, value);
      index++;
    } else if (argument.startsWith("-")) {
      return { problem: `legacy bridge does not accept ${argument}` };
    } else {
      positional.push(argument);
    }
  }
  if (positional.length !== 1) return { problem: "legacy bridge requires exactly one target repository" };
  const manifest = values.get("--manifest");
  const tests = values.get("--tests");
  return {
    args: {
      target: resolve(positional[0] as string),
      ...(manifest ? { manifest } : {}),
      ...(tests ? { tests } : {}),
    },
  };
}

function hasCheckedModelFile(target: string): boolean {
  return MODEL_FILES.some((file) => existsSync(join(target, "validation-design", "model", file)));
}

function runLegacyBridge(args: LegacyBridgeArgs): number {
  console.error(TRACE_LEGACY_BRIDGE_ACTIVE);
  const result = runTrace(args.target, {
    ...(args.manifest ? { manifestPath: args.manifest } : {}),
    ...(args.tests ? { testsRoot: args.tests } : {}),
  });
  process.stdout.write(result.report);
  if (!result.ok) {
    console.error(`\n[validation-trace] RED — ${result.reds.length} finding(s):`);
    for (const red of result.reds) console.error(`  - ${red}`);
    return 1;
  }
  console.error("\n[validation-trace] green — forward, backward, and status-honesty closure hold.");
  return 0;
}

export async function traceAliasMain(argv: string[]): Promise<number> {
  console.error(TRACE_ALIAS_DEPRECATION);
  if (argv[0] === "generate") {
    console.error(
      'validation-trace generate has been removed: use "validation-architect compile" (and --write when publication is intended).',
    );
    return 2;
  }
  const bridge = parseLegacyBridge(argv);
  if (bridge?.problem) {
    console.error(`validation-trace: ${bridge.problem}`);
    return 2;
  }
  if (bridge?.args) {
    if (!hasCheckedModelFile(bridge.args.target)) return runLegacyBridge(bridge.args);
    console.error(TRACE_CHECKED_MODEL_SELECTED);
    return coreMain([
      "check",
      bridge.args.target,
      ...(bridge.args.tests ? ["--tests-root", bridge.args.tests] : []),
    ]);
  }
  return coreMain(["check", ...argv]);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await traceAliasMain(process.argv.slice(2));
}
