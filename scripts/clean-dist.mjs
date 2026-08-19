#!/usr/bin/env node
/**
 * Remove one declared package build directory without accepting an arbitrary
 * filesystem path. Build output is ignored by Git, so every build must start
 * from this small, verified allow-list rather than trusting the prior host.
 */

import { existsSync, lstatSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = realpathSync.native(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const packages = {
  core: { root: repositoryRoot, name: "validation-architect" },
  design: { root: join(repositoryRoot, "design"), name: "validation-architect-design" },
};

const selection = process.argv[2];
const declared = packages[selection];
if (!declared || process.argv.length !== 3) {
  throw new Error("usage: clean-dist.mjs <core|design>");
}

const packageRoot = realpathSync.native(declared.root);
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
if (manifest.name !== declared.name) {
  throw new Error(`Refusing to clean ${selection}: expected package ${declared.name}, found ${manifest.name ?? "(missing)"}.`);
}

const output = resolve(packageRoot, "dist");
const outputRelative = relative(repositoryRoot, output);
const expectedRelative = selection === "core" ? "dist" : join("design", "dist");
if (
  outputRelative !== expectedRelative ||
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
