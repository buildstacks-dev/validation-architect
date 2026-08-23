#!/usr/bin/env node
/**
 * Remove the one declared package build directory without accepting an
 * arbitrary filesystem path. Build output is ignored by Git, so every build
 * starts from the exact verified root rather than trusting the prior host.
 */

import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = realpathSync.native(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
if (process.argv.length !== 2) {
  throw new Error("usage: clean-dist.mjs");
}

const packageRoot = repositoryRoot;
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
if (manifest.name !== "@cormidia/validation-architect") {
  throw new Error(`Refusing to clean: expected package @cormidia/validation-architect, found ${manifest.name ?? "(missing)"}.`);
}

const output = resolve(packageRoot, "dist");
const outputRelative = relative(repositoryRoot, output);
if (
  outputRelative !== "dist" ||
  outputRelative === ".." ||
  outputRelative.startsWith(`..${sep}`)
) {
  throw new Error(`Refusing to clean unresolved build output ${output}.`);
}

if (existsSync(output)) {
  const entry = lstatSync(output);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`Refusing to clean non-directory build output ${output}.`);
  }
  rmSync(output, { recursive: true, force: false });
}

if (existsSync(output)) {
  throw new Error(`Build output still exists after cleanup: ${output}.`);
}
