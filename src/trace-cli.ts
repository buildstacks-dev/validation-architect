/** Deprecated binary shim. The check path delegates to the core CLI verbatim. */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main as coreMain } from "./core-cli.js";

export const TRACE_ALIAS_DEPRECATION =
  'validation-trace is a deprecated alias for "validation-architect check" and will be removed at 1.0.';

export async function traceAliasMain(argv: string[]): Promise<number> {
  console.error(TRACE_ALIAS_DEPRECATION);
  if (argv[0] === "generate") {
    console.error(
      'validation-trace generate has been removed: use "validation-architect compile" (and --write when publication is intended).',
    );
    return 2;
  }
  return coreMain(["check", ...argv]);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await traceAliasMain(process.argv.slice(2));
}
