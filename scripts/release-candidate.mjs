#!/usr/bin/env node
/**
 * Build both release tarballs from one clean commit and print the immutable
 * values a human approves. This script never tags, publishes, or reads npm.
 *
 * License: FSL-1.1-MIT. Copyright 2026 Bikram Gupta. See LICENSE.md.
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

const corePackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const designPackage = JSON.parse(readFileSync(join(root, "design", "package.json"), "utf8"));
if (corePackage.name !== "validation-architect" || designPackage.name !== "validation-architect-design") {
  fail("The release package names do not match the approved public identities.");
}
if (corePackage.version !== designPackage.version || !/^\d+\.\d+\.\d+$/.test(corePackage.version)) {
  fail(`Version skew: core ${corePackage.version} vs design ${designPackage.version}. Lockstep is required.`);
}

const packageManager = /^pnpm@(\d+\.\d+\.\d+)$/.exec(corePackage.packageManager ?? "");
if (!packageManager) fail("packageManager must exact-pin pnpm before constructing a release candidate.");
const actualPnpm = run("pnpm", ["--version"]);
if (actualPnpm !== packageManager[1]) {
  fail(`pnpm ${packageManager[1]} is required by packageManager; found ${actualPnpm}.`);
}

run("pnpm", ["run", "build"], { stdio: ["ignore", "inherit", "inherit"] });
run("pnpm", ["-C", "design", "run", "build"], {
  stdio: ["ignore", "inherit", "inherit"],
});
const builtVersions = await import(
  `${pathToFileURL(join(root, "dist", "versions.js")).href}?candidate=${commit}`
);
if (builtVersions.CORE_PACKAGE_VERSION !== corePackage.version) {
  fail(
    `Code/package version skew: ${builtVersions.CORE_PACKAGE_VERSION} vs ${corePackage.version}.`,
  );
}
assertClean("after building");

const outputDirectory = mkdtempSync(join(tmpdir(), "validation-architect-candidate-"));
const coreTarball = join(outputDirectory, "core.tgz");
const designTarball = join(outputDirectory, "design.tgz");
run("pnpm", ["pack", "--out", coreTarball]);
run("pnpm", ["-C", "design", "pack", "--out", designTarball]);
assertClean("after packing");

const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const coreDigest = digest(coreTarball);
const designDigest = digest(designTarball);
const version = corePackage.version;

console.log(`
========== RELEASE CANDIDATE APPROVAL PREVIEW ==========
commit:         ${commit}
tag:            v${version}
package 1:      validation-architect@${version}
  sha256:       ${coreDigest}
package 2:      validation-architect-design@${version}
  sha256:       ${designDigest}
tarballs:       ${outputDirectory}
========================================================

To release, use exactly the commit, tag, core digest, and design digest above
as the four inputs to the GitHub Actions release workflow. The tag must first
be created at that commit. The protected npm-publish environment supplies the
separate publication approval. Any changed digest voids this preview.

No tag, publication, or registry read was performed.
`);
