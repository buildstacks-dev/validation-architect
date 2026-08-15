import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "validation-architect-package-smoke-"));
const packageManager = process.env.PNPM_BINARY || "pnpm";

function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

try {
  const packDir = join(scratch, "pack");
  mkdirSync(packDir);
  // Build explicitly so the smoke can select an already-cached pnpm binary;
  // avoid a nested lifecycle shell resolving a different package manager.
  run(packageManager, ["run", "build"], repoRoot);
  run(packageManager, ["pack", "--config.ignore-scripts=true", "--pack-destination", packDir], repoRoot);
  const tarballs = readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) throw new Error(`expected one tarball, found ${tarballs.length}`);
  const tarball = join(packDir, tarballs[0]);

  const listed = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" })
    .trim()
    .split("\n");
  for (const forbidden of [
    /^package\/test\//,
    /^package\/fixtures\//,
    /^package\/src\//,
    /fixture\.yaml$/,
    /rambling\.txt$/,
    /STANDALONE_REVIEWER_PROMPT/,
  ]) {
    if (listed.some((path) => forbidden.test(path))) {
      throw new Error(`package contains forbidden content matching ${forbidden}`);
    }
  }
  for (const required of [
    "package/bin/validation-trace.js",
    "package/dist/trace-cli.js",
    "package/skill/implement-harness-ticket/SKILL.md",
    "package/enablement/INSTALL.md",
    "package/enablement/ci/validation-trace.yml",
  ]) {
    if (!listed.includes(required)) throw new Error(`package is missing ${required}`);
  }

  const extracted = join(scratch, "extracted");
  mkdirSync(extracted);
  execFileSync("tar", ["-xzf", tarball, "-C", extracted]);
  const packageRoot = join(extracted, "package");
  const packedManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (packedManifest.license !== "UNLICENSED") {
    throw new Error(`packed package license must be UNLICENSED, got ${packedManifest.license}`);
  }
  const install = readFileSync(join(packageRoot, "enablement", "INSTALL.md"), "utf8");
  if (
    install.includes("{{PACKAGE_VERSION}}") ||
    !install.includes(`validation-architect@${packedManifest.version}`)
  ) {
    throw new Error("packed enablement INSTALL does not pin the concrete package version");
  }
  const bin = join(packageRoot, "bin", "validation-trace.js");
  if (/tsx|src\/trace-cli\.ts/.test(readFileSync(bin, "utf8"))) {
    throw new Error("production bin still depends on TypeScript dev tooling");
  }

  const target = join(scratch, "target");
  mkdirSync(join(target, "validation-design"), { recursive: true });
  mkdirSync(join(target, "tests", "cf-smoke-001"), { recursive: true });
  writeFileSync(
    join(target, "validation-design", "case-catalog.yaml"),
    `schema: validation-architect/case-catalog/v1\nproduct: smoke\nconventions:\n  tests_root: tests\nfamilies:\n  - id: CF-SMOKE-001\n    section: Smoke\n    layers: "1"\n    oracle: contract\n    risk: low\n    status: implementable\n    ticket: HB-001\n    wave: "1"\ntickets:\n  - id: HB-001\n    title: Smoke\n    status: landed\n    wave: "1"\n    families: [CF-SMOKE-001]\n`,
  );
  writeFileSync(
    join(target, "tests", "cf-smoke-001", "smoke.test.js"),
    `// CF-SMOKE-001 (HB-001; smoke contract)\nit("smoke", () => {});\n`,
  );
  const dependencyPackDir = join(scratch, "dependency-pack");
  mkdirSync(dependencyPackDir);
  run(
    "npm",
    [
      "pack",
      join(repoRoot, "node_modules", "yaml"),
      "--pack-destination",
      dependencyPackDir,
      "--ignore-scripts",
      "--cache",
      join(scratch, "npm-cache"),
    ],
    repoRoot,
  );
  const yamlTarballs = readdirSync(dependencyPackDir).filter((name) => name.endsWith(".tgz"));
  if (yamlTarballs.length !== 1) throw new Error("could not create local yaml dependency tarball");
  const yamlTarball = join(dependencyPackDir, yamlTarballs[0]);

  writeFileSync(
    join(target, "package.json"),
    `${JSON.stringify({
      private: true,
      devDependencies: { "validation-architect": `file:${tarball}` },
    }, null, 2)}\n`,
  );
  writeFileSync(
    join(target, "pnpm-workspace.yaml"),
    `packages:\n  - .\noverrides:\n  yaml: file:${yamlTarball}\n`,
  );
  run(packageManager, ["install", "--offline", "--ignore-scripts"], target, { CI: "true" });
  const installedBin = join(
    target,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "validation-trace.cmd" : "validation-trace",
  );
  const help = run(installedBin, ["--help"], target);
  if (!help.stdout.includes("validation-trace <target-repo>")) {
    throw new Error("installed package help did not render");
  }
  const trace = run(installedBin, [target, "--quiet"], target);
  if (!trace.stderr.includes("[validation-trace] green")) {
    throw new Error("clean-target trace did not close green");
  }

  console.log(`package smoke passed: ${tarballs[0]} (${listed.length} entries)`);
} finally {
  if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
}
