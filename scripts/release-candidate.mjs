#!/usr/bin/env node
/**
 * Build the release tarball from one clean commit and print the immutable
 * values a human approves. This script never tags, publishes, or reads npm.
 *
 * Licensed under Apache-2.0. Copyright 2026 Bikram Gupta. See LICENSE.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");
const run = (command, args, options = {}) => {
  const output = execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
  return typeof output === "string" ? output.trim() : "";
};
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const assertClean = (stage) => {
  const dirty = run("git", ["status", "--porcelain", "--untracked-files=all"]);
  if (dirty !== "") fail(`The working tree is dirty ${stage}:\n${dirty}`);
};

assertClean("before candidate construction");
const commit = run("git", ["rev-parse", "HEAD"]);

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (manifest.name !== "@cormidia/validation-architect") {
  fail("The release package name does not match the approved public identity.");
}
if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  fail(`Invalid package version ${manifest.version}.`);
}

const packageManager = /^pnpm@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager ?? "");
if (!packageManager) fail("packageManager must exact-pin pnpm before constructing a release candidate.");
const actualPnpm = run("pnpm", ["--version"]);
if (actualPnpm !== packageManager[1]) {
  fail(`pnpm ${packageManager[1]} is required by packageManager; found ${actualPnpm}.`);
}

run("pnpm", ["run", "build"], { stdio: ["ignore", "inherit", "inherit"] });
const builtVersions = await import(
  `${pathToFileURL(join(root, "dist", "versions.js")).href}?candidate=${commit}`
);
if (builtVersions.CORE_PACKAGE_VERSION !== manifest.version) {
  fail(
    `Code/package version skew: ${builtVersions.CORE_PACKAGE_VERSION} vs ${manifest.version}.`,
  );
}
assertClean("after building");

const outputDirectory = mkdtempSync(join(tmpdir(), "validation-architect-candidate-"));
const tarball = join(outputDirectory, "package.tgz");
run("pnpm", ["pack", "--out", tarball]);
assertClean("after packing");

const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const tarballDigest = digest(tarball);
const version = manifest.version;

console.log(`
========== RELEASE CANDIDATE APPROVAL PREVIEW ==========
commit:         ${commit}
tag:            v${version}
package:         @cormidia/validation-architect@${version}
sha256:          ${tarballDigest}
tarball:         ${tarball}
========================================================

To release, use exactly the commit, tag, and digest above as the three inputs
to the GitHub Actions release workflow. The tag must first
be created at that commit. The protected npm-publish environment supplies the
separate publication approval. Any changed digest voids this preview.

No tag, publication, or registry read was performed.
`);
