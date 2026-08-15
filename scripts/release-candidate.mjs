#!/usr/bin/env node
/**
 * Builds the reproducible release candidate: both tarballs from ONE clean
 * commit, with digests, and prints the exact approval preview a human binds
 * their release approval to. Read-only with respect to the registry — this
 * script never publishes, tags, or deploys.
 *
 * License: FSL-1.1-MIT. Copyright 2026 Bikram Gupta. See LICENSE.md.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(import.meta.url), "..", "..");
const run = (cmd, args, opts = {}) => {
  const output = execFileSync(cmd, args, { cwd: root, encoding: "utf8", ...opts });
  return typeof output === "string" ? output.trim() : "";
};

const dirty = run("git", ["status", "--porcelain"]);
if (dirty !== "" && !process.env.RELEASE_CANDIDATE_ALLOW_DIRTY) {
  console.error("The working tree is dirty; a candidate must be built from one clean commit.\n" + dirty);
  process.exit(1);
}
const commit = run("git", ["rev-parse", "HEAD"]);

const corePkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const designPkg = JSON.parse(readFileSync(join(root, "design", "package.json"), "utf8"));
if (corePkg.version !== designPkg.version) {
  console.error(`Version skew: core ${corePkg.version} vs design ${designPkg.version}. Lockstep is required.`);
  process.exit(1);
}
const version = corePkg.version;
const tag = `v${version}`;

run("pnpm", ["run", "build"], { stdio: ["ignore", "inherit", "inherit"] });
run("pnpm", ["-C", "design", "run", "build"], { stdio: ["ignore", "inherit", "inherit"] });

const out = mkdtempSync(join(tmpdir(), "va-candidate-"));
run("pnpm", ["pack", "--out", join(out, "core.tgz")]);
run("pnpm", ["-C", "design", "pack", "--out", join(out, "design.tgz")]);

const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const coreDigest = digest(join(out, "core.tgz"));
const designDigest = digest(join(out, "design.tgz"));

console.log(`
========== RELEASE CANDIDATE APPROVAL PREVIEW ==========
commit:         ${commit}
tag:            ${tag}
package 1:      validation-architect@${version}
  sha256:       ${coreDigest}
package 2:      validation-architect-design@${version}
  sha256:       ${designDigest}
tarballs:       ${out}
========================================================

To release, a human runs the "release" GitHub Actions workflow with EXACTLY
these inputs (commit, tag, both digests) and then approves the protected
"npm-publish" environment gate. Any rebuild that changes a digest voids this
preview. This script performed no tag, publication, or registry action.
`);
