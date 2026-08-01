#!/usr/bin/env node
/**
 * Package bin for `validation-trace` (issue #5). Runs the TypeScript entry
 * via the repo's tsx, same as the `pnpm vda` / `pnpm trace` scripts.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "src", "trace-cli.ts");
const tsx = join(here, "..", "node_modules", ".bin", "tsx");
const runner = existsSync(tsx) ? tsx : "tsx";
const result = spawnSync(runner, [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status === null ? 1 : result.status);
