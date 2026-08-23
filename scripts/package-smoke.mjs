/**
 * Single-tarball offline packaging smoke (VA-PKG-001).
 *
 * Builds and packs the publishable package, then proves in isolated consumers:
 *   1. a clean install without provider SDKs succeeds and the deterministic
 *      API/CLI runs with yaml as its sole runtime dependency;
 *   2. a live design command without its SDK fails closed with the exact
 *      optional-peer install message and a non-zero exit;
 *   3. both pinned provider SDKs can be installed from the repository's tested
 *      closure and the design CLI/programmatic surface load without a call.
 * It also checks the exact allowlist, Apache license/notice, all three bins,
 * source + dist + fixture closure, schemas, skills, and deep-import refusal.
 * Plus target-repo behavior: the deprecated alias preserves legacy closure
 * before cutover, refuses fallback after the first model file appears, and
 * executes the same committed-model path after cutover.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "validation-architect-package-smoke-"));
const packageManager = process.env.PNPM_BINARY || "pnpm";
const packageManagerPath = packageManager.includes("/")
  ? `${dirname(resolve(packageManager))}:${process.env.PATH ?? ""}`
  : process.env.PATH;

function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, PATH: packageManagerPath, ...env },
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

/** Like run() but returns the result whatever the exit code. */
function tryRun(command, args, cwd) {
  return spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env } });
}

const git = (cwd, args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const TRACE_WARNING =
  'validation-trace is a deprecated alias for "validation-architect check" and will be removed at 1.0.';
const LEGACY_BRIDGE_ACTIVE = "validation-trace legacy manifest bridge active";
const CHECKED_MODEL_SELECTED = "validation-trace checked-model authority selected";

function fileTree(root) {
  const files = new Map();
  const visit = (directory, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`build output contains symlink ${relativePath}`);
      if (entry.isDirectory()) visit(path, relativePath);
      else if (entry.isFile()) files.set(relativePath, readFileSync(path));
      else throw new Error(`build output contains non-file entry ${relativePath}`);
    }
  };
  visit(root);
  return files;
}

function assertSameTree(actualRoot, expectedRoot, label) {
  const actual = fileTree(actualRoot);
  const expected = fileTree(expectedRoot);
  if (JSON.stringify([...actual.keys()]) !== JSON.stringify([...expected.keys()])) {
    throw new Error(`${label} output paths differ from a clean isolated TypeScript build\nactual: ${[...actual.keys()].join(", ")}\nexpected: ${[...expected.keys()].join(", ")}`);
  }
  for (const [path, content] of expected) {
    if (!actual.get(path)?.equals(content)) throw new Error(`${label} output differs from the clean build at ${path}`);
  }
  return expected;
}

function packOne(destination) {
  mkdirSync(destination);
  run(packageManager, ["pack", "--pack-destination", destination], repoRoot);
  const tarballs = readdirSync(destination).filter((name) => name.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    throw new Error(`expected exactly one package tarball, found: ${tarballs.join(", ")}`);
  }
  return join(destination, tarballs[0]);
}

const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function installedPackageDirectories() {
  const packages = new Map();
  const virtualStore = join(repoRoot, "node_modules", ".pnpm");
  for (const entry of readdirSync(virtualStore).sort()) {
    const modules = join(virtualStore, entry, "node_modules");
    if (!existsSync(modules)) continue;
    for (const first of readdirSync(modules).sort()) {
      if (first === ".bin") continue;
      const firstPath = join(modules, first);
      const candidates = first.startsWith("@") && existsSync(firstPath)
        ? readdirSync(firstPath).sort().map((second) => join(firstPath, second))
        : [firstPath];
      for (const candidate of candidates) {
        const manifestPath = join(candidate, "package.json");
        if (!existsSync(manifestPath)) continue;
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (typeof manifest.name !== "string" || typeof manifest.version !== "string") continue;
        const key = `${manifest.name}@${manifest.version}`;
        if (!packages.has(key)) packages.set(key, { name: manifest.name, version: manifest.version, path: candidate });
      }
    }
  }
  return [...packages.values()];
}

try {
  // ── build + pack the package ───────────────────────────────────────────────
  const referenceDist = join(scratch, "reference-dist");
  const seeded = [
    join(repoRoot, "dist", "src", "stale-provider.js"),
    join(repoRoot, "dist", "test", "stale-test.js"),
    join(repoRoot, "dist", "design", "stale-design.js"),
  ];
  for (const path of seeded) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "stale ignored build residue\n");
  }

  run(packageManager, ["exec", "tsc", "-p", "tsconfig.build.json", "--outDir", referenceDist], repoRoot);
  run(packageManager, ["run", "build"], repoRoot);
  for (const path of seeded) {
    if (existsSync(path)) throw new Error(`ordinary build left stale output ${path}`);
  }
  const expectedDist = assertSameTree(join(repoRoot, "dist"), referenceDist, "package");

  const cleanTarball = packOne(join(scratch, "pack-clean"));
  for (const path of seeded) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "different stale residue before prepack\n");
  }
  const residueTarball = packOne(join(scratch, "pack-after-residue"));
  for (const path of seeded) {
    if (existsSync(path)) throw new Error(`prepack left stale output ${path}`);
  }
  if (digest(cleanTarball) !== digest(residueTarball)) {
    throw new Error("package tarball digest depends on prior ignored build residue");
  }
  const packageTarball = residueTarball;

  // ── tarball listing ────────────────────────────────────────────────────────
  const listed = execFileSync("tar", ["-tzf", packageTarball], { encoding: "utf8" }).trim().split("\n");
  for (const forbidden of [
    /^package\/test\//,
    /^package\/docs\//,
    /^package\/research\//,
    /^package\/design\//,
    /^package\/dist\/(?:src|test)\//,
    /^package\/src\/(?:test|.*\.test\.ts$)/,
    /(?:^|\/)\.env(?:\.|$)/,
    /\/VERSION$/,
  ]) {
    if (listed.some((path) => forbidden.test(path))) {
      throw new Error(`package contains forbidden content matching ${forbidden}`);
    }
  }
  const packedDist = listed.filter((path) => path.startsWith("package/dist/")).map((path) => path.slice("package/dist/".length)).sort();
  if (JSON.stringify(packedDist) !== JSON.stringify([...expectedDist.keys()].sort())) {
    throw new Error("tarball dist paths differ from the clean TypeScript build closure");
  }
  const requiredCoreFiles = [
    "package/LICENSE",
    "package/NOTICE",
    "package/README.md",
    "package/THIRD-PARTY-NOTICES.md",
    "package/bin/validation-architect.js",
    "package/bin/validation-trace.js",
    "package/bin/validation-architect-design.js",
    "package/dist/api/index.js",
    "package/dist/api/index.d.ts",
    "package/dist/compiler-report.js",
    "package/dist/compiler-report.d.ts",
    "package/dist/core-cli.js",
    "package/dist/trace-cli.js",
    "package/dist/design/cli.js",
    "package/dist/design/index.js",
    "package/dist/design/index.d.ts",
    "package/dist/design/provider-port.js",
    "package/src/api/index.ts",
    "package/src/core-cli.ts",
    "package/src/design/cli.ts",
    "package/src/design/provider-port.ts",
    "package/schemas/corpus.v1.schema.json",
    "package/schemas/case-catalog.v1.schema.json",
    "package/schemas/result.v1.schema.json",
    "package/schemas/plan.v1.schema.json",
    "package/schemas/design-run.v1.schema.json",
    "package/schemas/provenance.v1.schema.json",
    "package/enablement/INSTALL.md",
    "package/enablement/ci/validation-trace.yml",
    "package/enablement/ci/control-sweep.yml",
    "package/enablement/sweep/control-sweep.mjs",
    "package/enablement/sweep/control-sweep.d.mts",
    "package/fixtures/lumen-webapp/docs/PRODUCT.md",
    "package/fixtures/lumen-webapp/fixture.yaml",
    "package/fixtures/lumen-webapp/rambling.txt",
  ];
  for (const required of requiredCoreFiles) {
    if (!listed.includes(required)) throw new Error(`package is missing ${required}`);
  }
  // ALL THREE complete skill trees: every git-tracked file under each skill
  // directory must be in the packed listing (reference closure by superset).
  for (const skill of ["validation-harness-design", "validation-harness-audit", "implement-harness-ticket"]) {
    const trackedSkillFiles = git(repoRoot, ["ls-files", `skill/${skill}`]).trim().split("\n").filter(Boolean);
    if (trackedSkillFiles.length === 0) throw new Error(`skill tree ${skill} has no tracked files`);
    for (const file of trackedSkillFiles) {
      // npm packing always drops ignore files themselves.
      if (file.endsWith(".gitignore") || file.endsWith(".npmignore")) continue;
      if (!listed.includes(`package/${file}`)) {
        throw new Error(`package is missing skill file ${file} (skill trees must ship whole)`);
      }
    }
  }

  // ── packed manifest, license, optional peers, install pin, bins ────────────
  const extracted = join(scratch, "extracted");
  mkdirSync(extracted);
  execFileSync("tar", ["-xzf", packageTarball, "-C", extracted]);
  const packageRoot = join(extracted, "package");
  const packedManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const expectedRepository = "git+https://github.com/cormidia/validation-architect.git";
  if (
    packedManifest.name !== "@cormidia/validation-architect" ||
    packedManifest.version !== "0.5.0" ||
    packedManifest.repository?.url !== expectedRepository ||
    packedManifest.repository?.directory !== undefined ||
    packedManifest.homepage !== "https://github.com/cormidia/cormidia-web" ||
    packedManifest.bugs?.url !== "https://github.com/cormidia/validation-architect/issues" ||
    packedManifest.publishConfig?.access !== "public" ||
    Object.hasOwn(packedManifest.publishConfig ?? {}, "provenance")
  ) {
    throw new Error("packed manifest has invalid identity, registry, or provenance metadata");
  }
  if (packedManifest.license !== "Apache-2.0") {
    throw new Error(`packed license must be Apache-2.0, got ${packedManifest.license}`);
  }
  const packedLicense = readFileSync(join(packageRoot, "LICENSE"), "utf8");
  const packedNotice = readFileSync(join(packageRoot, "NOTICE"), "utf8");
  if (!packedLicense.includes("Apache License") || !packedLicense.includes("Version 2.0")) {
    throw new Error("packed LICENSE is not Apache-2.0");
  }
  if (!packedNotice.includes("Copyright 2026 Bikram Gupta")) {
    throw new Error("packed NOTICE is missing the confirmed copyright holder");
  }
  const dependencyNames = Object.keys(packedManifest.dependencies ?? {});
  if (dependencyNames.length !== 1 || dependencyNames[0] !== "yaml") {
    throw new Error(`runtime dependencies must be exactly [yaml], got [${dependencyNames.join(", ")}]`);
  }
  const expectedPeers = {
    "@anthropic-ai/claude-agent-sdk": "0.3.220",
    "@openai/codex-sdk": "0.146.0",
  };
  if (JSON.stringify(packedManifest.peerDependencies) !== JSON.stringify(expectedPeers)) {
    throw new Error(`packed optional peers differ from the exact tested pins: ${JSON.stringify(packedManifest.peerDependencies)}`);
  }
  for (const [sdk, version] of Object.entries(expectedPeers)) {
    if (packedManifest.peerDependenciesMeta?.[sdk]?.optional !== true) {
      throw new Error(`${sdk}@${version} must be marked as an optional peer`);
    }
    if (packedManifest.devDependencies?.[sdk] !== version) {
      throw new Error(`${sdk} must remain an exact dev dependency at ${version}`);
    }
  }
  const install = readFileSync(join(packageRoot, "enablement", "INSTALL.md"), "utf8");
  if (install.includes("{{PACKAGE_VERSION}}") || !install.includes(`@cormidia/validation-architect@${packedManifest.version}`)) {
    throw new Error("packed enablement INSTALL does not pin the concrete package version");
  }
  if (!install.includes("validation-architect check")) {
    throw new Error("packed enablement INSTALL does not migrate to `validation-architect check`");
  }
  const ciTemplate = readFileSync(join(packageRoot, "enablement", "ci", "validation-trace.yml"), "utf8");
  if (!ciTemplate.includes("validation-architect check")) {
    throw new Error("packed CI template does not invoke `validation-architect check`");
  }
  for (const bin of ["validation-architect.js", "validation-trace.js", "validation-architect-design.js"]) {
    if (/tsx|src\/.+\.ts/.test(readFileSync(join(packageRoot, "bin", bin), "utf8"))) {
      throw new Error(`production bin ${bin} still depends on TypeScript dev tooling`);
    }
  }

  // ── vendor the yaml dependency for a fully offline consumer install ───────
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

  // ── isolated consumer: package tarball without optional peers ──────────────
  const consumer = join(scratch, "consumer");
  mkdirSync(consumer, { recursive: true });
  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify({ private: true, devDependencies: { "@cormidia/validation-architect": `file:${packageTarball}` } }, null, 2)}\n`,
  );
  writeFileSync(
    join(consumer, "pnpm-workspace.yaml"),
    `packages:\n  - .\noverrides:\n  yaml: file:${yamlTarball}\n`,
  );
  run(packageManager, ["install", "--offline", "--ignore-scripts", "--config.minimumReleaseAge=0"], consumer, { CI: "true" });

  // Dependency tree: yaml present, NO provider SDK anywhere. pnpm keeps the
  // real tree under node_modules/.pnpm, so inspect the virtual store.
  const virtualStore = () =>
    existsSync(join(consumer, "node_modules", ".pnpm")) ? readdirSync(join(consumer, "node_modules", ".pnpm")) : [];
  if (!virtualStore().some((entry) => entry.startsWith("yaml@"))) {
    throw new Error("minimal install did not bring the yaml runtime dependency");
  }
  const forbiddenDependency = (entries) =>
    entries.find((entry) => entry.includes("claude-agent-sdk") || entry.includes("codex"));
  {
    const hit = forbiddenDependency(virtualStore());
    if (hit) throw new Error(`minimal install must not bring provider SDKs (found ${hit})`);
  }

  // Import surface: nine entry points + schema IDs + assets + fakes; deep
  // imports refused by the exports map.
  writeFileSync(
    join(consumer, "surface.mjs"),
    `
import { createRequire } from "node:module";
import {
  compile, check, explain, plan, ingest, render, migrate, design, resume,
  PUBLISHED_SCHEMA_IDS, schemaAssetFile, isGreenValidationResult,
  FakeRepositoryPort, ScriptedTurnPort, InMemoryCampaignStore, PublicContractError,
} from "@cormidia/validation-architect";

const nine = { compile, check, explain, plan, ingest, render, migrate, design, resume };
for (const [name, value] of Object.entries(nine)) {
  if (typeof value !== "function") throw new Error(name + " is not exported as a function");
}
for (const fake of [FakeRepositoryPort, ScriptedTurnPort, InMemoryCampaignStore, PublicContractError]) {
  if (typeof fake !== "function") throw new Error("conformance fake missing");
}
if (Object.keys(PUBLISHED_SCHEMA_IDS).length !== 6) throw new Error("expected six published schema IDs");
const require = createRequire(import.meta.url);
for (const id of Object.values(PUBLISHED_SCHEMA_IDS)) {
  const asset = require("@cormidia/validation-architect/schemas/" + schemaAssetFile(id));
  if (typeof asset !== "object" || asset === null) throw new Error("schema asset unreadable for " + id);
}
if (typeof isGreenValidationResult !== "function") throw new Error("isGreenValidationResult missing");
// The fakes run offline end to end.
const repo = new FakeRepositoryPort({ revision: "rev-1", files: {} });
if ((await repo.revision()) !== "rev-1") throw new Error("FakeRepositoryPort broken");
// Unsupported deep imports must fail (no wildcard into dist).
try {
  await import("@cormidia/validation-architect/dist/api/errors.js");
  throw new Error("deep import into dist unexpectedly succeeded");
} catch (error) {
  if (error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
}
console.log("surface ok");
`,
  );
  const surface = run("node", ["surface.mjs"], consumer);
  if (!surface.stdout.includes("surface ok")) throw new Error("consumer surface script did not confirm");

  // ── installed bins ─────────────────────────────────────────────────────────
  const binPath = (name) =>
    join(consumer, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);

  const rootHelp = run(binPath("validation-architect"), ["--help"], consumer);
  if (!rootHelp.stdout.includes("usage: validation-architect <command>")) {
    throw new Error("validation-architect --help did not render");
  }
  const checkHelp = run(binPath("validation-architect"), ["check", "--help"], consumer);
  if (!checkHelp.stdout.includes("validation-architect check [dir]")) {
    throw new Error("validation-architect check --help did not render");
  }
  const unknown = tryRun(binPath("validation-architect"), ["frobnicate"], consumer);
  if (unknown.status !== 2) throw new Error(`unknown command must exit 2, got ${unknown.status}`);

  const aliasHelp = tryRun(binPath("validation-trace"), ["--help"], consumer);
  if (aliasHelp.status !== 0) throw new Error("validation-trace --help must exit 0");
  if (!aliasHelp.stderr.includes(TRACE_WARNING)) {
    throw new Error("validation-trace did not print the deterministic deprecation warning");
  }
  if (aliasHelp.stderr.split(TRACE_WARNING).length - 1 !== 1) {
    throw new Error("the deprecation warning must be exactly one line per invocation");
  }
  const aliasGenerate = tryRun(binPath("validation-trace"), ["generate", "a.md", "b.md"], consumer);
  if (aliasGenerate.status !== 2 || !aliasGenerate.stderr.includes("validation-architect compile")) {
    throw new Error("validation-trace generate must exit 2 and point at validation-architect compile");
  }

  // A legacy consumer can pin the package in a preparatory commit without
  // dropping its incumbent closure gate. This bridge is alias-only and ends
  // as soon as the first checked-model file appears.
  const legacyTarget = join(scratch, "legacy-target");
  mkdirSync(join(legacyTarget, "validation-design"), { recursive: true });
  mkdirSync(join(legacyTarget, "tests", "cf-legacy"), { recursive: true });
  writeFileSync(
    join(legacyTarget, "validation-design", "case-catalog.yaml"),
    [
      "schema: validation-architect/case-catalog/v1",
      "product: legacy-smoke",
      "families:",
      "  - id: CF-LEGACY",
      "    section: Legacy bridge",
      "    status: implementable",
      "    layers: '2'",
      "    risk: STD",
      "    ticket: HB-LEGACY",
      "    wave: '0'",
      "tickets:",
      "  - id: HB-LEGACY",
      "    wave: '0'",
      "    status: landed",
      "    families: [CF-LEGACY]",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(legacyTarget, "tests", "cf-legacy", "cf-legacy.test.ts"),
    ["// CF-LEGACY — retained detector (HB-LEGACY)", "it('holds', () => {});", ""].join("\n"),
  );
  const legacyAlias = tryRun(
    binPath("validation-trace"),
    [legacyTarget, "--manifest", "validation-design/case-catalog.yaml", "--tests", "tests"],
    consumer,
  );
  if (legacyAlias.status !== 0 || !legacyAlias.stdout.includes("Trace report — legacy-smoke")) {
    throw new Error(`legacy alias bridge did not preserve closure\n${legacyAlias.stdout}\n${legacyAlias.stderr}`);
  }
  if (!legacyAlias.stderr.includes(LEGACY_BRIDGE_ACTIVE)) {
    throw new Error("legacy alias bridge did not identify the selected legacy authority");
  }

  mkdirSync(join(legacyTarget, "validation-design", "model"), { recursive: true });
  writeFileSync(
    join(legacyTarget, "validation-design", "model", "project.yaml"),
    "schema: validation-architect/model/project/v1\n",
  );
  git(scratch, ["init", "-q", "-b", "main", "legacy-target"]);
  git(legacyTarget, ["add", "-A"]);
  git(legacyTarget, ["-c", "user.name=smoke", "-c", "user.email=smoke@local", "commit", "-q", "-m", "partial model"]);
  const partialAlias = tryRun(
    binPath("validation-trace"),
    [legacyTarget, "--manifest", "validation-design/case-catalog.yaml", "--tests", "tests"],
    consumer,
  );
  if (
    partialAlias.status !== 1 ||
    !partialAlias.stderr.includes(CHECKED_MODEL_SELECTED) ||
    !partialAlias.stderr.includes("invalid_input") ||
    partialAlias.stdout.includes("Trace report — legacy-smoke")
  ) {
    throw new Error(`partial model fell back to legacy closure\n${partialAlias.stdout}\n${partialAlias.stderr}`);
  }

  // ── target-repo behavior: check against a committed model corpus ───────────
  const { CURRENT_CORE_VERSIONS } = await import(pathToFileURL(join(repoRoot, "dist", "versions.js")).href);
  const target = join(scratch, "target");
  const model = join(target, "validation-design", "model");
  mkdirSync(model, { recursive: true });
  mkdirSync(join(target, "docs"), { recursive: true });
  mkdirSync(join(target, "tests"), { recursive: true });
  writeFileSync(join(target, "docs", "PRODUCT.md"), "# Product\n\nContract\n");
  writeFileSync(
    join(target, "tests", "fixture.test.ts"),
    ["// Family: CF-X01-S", "// Ticket: HB-001", "it('holds', () => {});", ""].join("\n"),
  );
  git(scratch, ["init", "-q", "-b", "main", "target"]);
  git(target, ["add", "-A"]);
  git(target, ["-c", "user.name=smoke", "-c", "user.email=smoke@local", "commit", "-q", "-m", "source"]);
  const sourceRevision = git(target, ["rev-parse", "HEAD"]).trim();
  // JSON is valid YAML: the corpus files mirror test/model-corpus-fixture.ts.
  const writeModel = (name, value) => writeFileSync(join(model, name), `${JSON.stringify(value, null, 2)}\n`);
  writeModel("project.yaml", {
    schema: "validation-architect/model/project/v1",
    product: {
      id: "smoke-x",
      name: "Smoke X",
      revision: sourceRevision,
      intended_use: "Packaging smoke fixture",
      criticality: "C1",
      criticality_reason: "Synthetic local data with bounded consequences",
    },
    versions: CURRENT_CORE_VERSIONS,
  });
  writeModel("owners.yaml", {
    schema: "validation-architect/model/owners/v1",
    owners: [{ id: "OWN-1", name: "Runtime", responsibility: "Own the validation contract" }],
  });
  writeModel("sources.yaml", {
    schema: "validation-architect/model/sources/v1",
    sources: [{ id: "SRC-1", kind: "doc", path: "docs/PRODUCT.md", locator: "Contract" }],
  });
  writeModel("structures.yaml", {
    schema: "validation-architect/model/structures/v1",
    structures: [
      {
        id: "J-1",
        kind: "journey",
        title: "First smoke response",
        meaning: "A new consumer completes its first stable smoke request",
        owner: "OWN-1",
        source_ids: ["SRC-1"],
      },
      {
        id: "CON-1",
        kind: "contract",
        title: "Smoke contract",
        meaning: "The smoke response remains stable",
        owner: "OWN-1",
        source_ids: ["SRC-1"],
        acceptance_criteria: ["The same controlled request returns the same response without mutation"],
        error_criteria: ["An invalid smoke request is refused with a typed error and no mutation"],
        changed_paths: ["src/**"],
      },
    ],
  });
  writeModel("policy.yaml", {
    schema: "validation-architect/model/policy/v1",
    default: "blocking",
    inheritance: "tighten-only",
    smoke_journey_ids: ["J-1"],
    sourcing: [
      { id: "acceptance-criteria", status: "active", owner: "OWN-1", trigger: "A ratified acceptance criterion is added or changed" },
      { id: "adversarial-derivation", status: "active", owner: "OWN-1", trigger: "A journey, interface, boundary, or contract changes" },
      { id: "production-incident", status: "declared-empty", owner: "OWN-1", reason: "The smoke fixture has no production deployment" },
      { id: "substrate-drift", status: "declared-empty", owner: "OWN-1", reason: "No substrate dependency is tracked" },
    ],
    layers: [
      { id: "L1", title: "Invariant and contract", status: "declared-empty", reason: "Focused L2 fixture" },
      { id: "L2", title: "Hermetic system", status: "active" },
      { id: "L3", title: "Live sandbox", status: "declared-empty", reason: "No live target" },
      { id: "L4", title: "Eval qualification", status: "declared-empty", reason: "No model site" },
      { id: "L5", title: "Ops hardening", status: "declared-empty", reason: "C1 fixture" },
      { id: "L6", title: "Outcome acceptance", status: "declared-empty", reason: "No judged output" },
    ],
    lanes: [
      { id: "inner-loop", title: "Fast local", kind: "test", status: "active", requirement: "blocking", triggers: ["before-push"], command: "pnpm test -- fixture", max_duration_seconds: 120 },
      { id: "per-commit", title: "Hermetic", kind: "test", status: "active", requirement: "blocking", triggers: ["per-commit"], command: "pnpm test", max_duration_seconds: 600 },
      { id: "triggered", title: "Triggered", kind: "evidence", status: "declared-empty", requirement: "blocking", triggers: [], reason: "No triggered work" },
      { id: "release", title: "Release", kind: "evidence", status: "declared-empty", requirement: "blocking", triggers: [], reason: "No release work" },
      { id: "scheduled", title: "Scheduled", kind: "evidence", status: "declared-empty", requirement: "blocking", triggers: [], reason: "No scheduled work" },
    ],
    exceptions: [],
  });
  writeModel("controls.yaml", {
    schema: "validation-architect/model/controls/v1",
    controls: [
      {
        id: "NC-X01",
        title: "Smoke mutation",
        family_id: "CF-X01-S",
        owner: "OWN-1",
        expected_failure: "The detector turns red when the stable response changes",
      },
    ],
  });
  writeModel("families.yaml", {
    schema: "validation-architect/model/families/v1",
    families: [
      {
        id: "CF-X01-S",
        title: "Smoke happy path",
        meaning: "The stable response is preserved",
        structure_ids: ["CON-1", "J-1"],
        owner: "OWN-1",
        source_ids: ["SRC-1"],
        lane: "per-commit",
        status: "implementable",
        layer: "L2",
        oracle: "state",
        risk: "STD",
        control_ids: ["NC-X01"],
        ticket: "HB-001",
        planned_tests: ["tests/fixture.test.ts"],
      },
    ],
  });
  writeModel("backlog.yaml", {
    schema: "validation-architect/model/backlog/v1",
    tickets: [
      {
        id: "HB-001",
        title: "Minimal harness",
        wave: "0",
        status: "pending",
        owner: "OWN-1",
        executor: "standing coding agent",
        lane: "per-commit",
        layer: "L2",
        acceptance_criteria: ["The fixture detector and negative control pass in the per-commit lane"],
        family_ids: ["CF-X01-S"],
      },
    ],
  });
  git(target, ["add", "validation-design"]);
  git(target, ["-c", "user.name=smoke", "-c", "user.email=smoke@local", "commit", "-q", "-m", "design"]);

  // The packed PUBLIC ROOT import must preserve honest pre-implementation
  // backlog state: pending is partial/inconclusive, never green and never a
  // false closure red. Keep an observed test root while omitting the planned
  // spec so TESTS_ROOT_ABSENT remains an independent fail-closed detector.
  const pendingFiles = {
    "docs/PRODUCT.md": readFileSync(join(target, "docs", "PRODUCT.md"), "utf8"),
    "tests/.keep": "",
  };
  for (const name of readdirSync(model)) {
    pendingFiles[`validation-design/model/${name}`] = readFileSync(join(model, name), "utf8");
  }
  // Same corpus with a landed owner ticket: the unimplemented declared control
  // must turn the gate red and name the control id (VA-ENF-002).
  const landedFiles = {
    ...pendingFiles,
    "validation-design/model/backlog.yaml": pendingFiles[
      "validation-design/model/backlog.yaml"
    ].replace('"status": "pending"', '"status": "landed"'),
  };
  if (landedFiles["validation-design/model/backlog.yaml"] === pendingFiles["validation-design/model/backlog.yaml"]) {
    throw new Error("landed smoke corpus did not flip the owner ticket status");
  }
  writeFileSync(
    join(consumer, "pending-root-import.mjs"),
    `
import {
  check, compile, explain, FakeRepositoryPort, isGreenValidationResult,
} from "@cormidia/validation-architect";

const repo = new FakeRepositoryPort({
  revision: ${JSON.stringify(sourceRevision)},
  files: ${JSON.stringify(pendingFiles)},
});
const compilation = await compile(repo);
if (!compilation.accepted) throw new Error("pending corpus must compile");
if (
  compilation.report.record.schema !== "validation-architect/compiler/v1" ||
  compilation.report.record.accepted !== true ||
  compilation.report.record.generated_views.length !== 5 ||
  Object.keys(compilation.views).length !== 5 ||
  compilation.report.content !== JSON.stringify(compilation.report.record, null, 2) + "\\n"
) {
  throw new Error("public compile did not return the canonical compiler/v1 report and five Markdown views");
}
const result = await check(repo);
if (result.verdict !== "inconclusive" || result.completeness !== "incomplete") {
  throw new Error("pending family must remain incomplete/inconclusive");
}
if (isGreenValidationResult(result)) throw new Error("pending family became green by absence");
const graph = (await explain(repo, "CF-X01-S")).graph;
const familyFindings = graph.findings.filter((finding) => finding.subject_id === "CF-X01-S");
if (!familyFindings.some((finding) => finding.code === "IMPLEMENTATION_PENDING" && finding.level === "partial")) {
  throw new Error("pending family lacks the explicit partial finding");
}
if (!familyFindings.some((finding) => finding.code === "CONTROL_IMPLEMENTATION_PENDING" && finding.level === "partial")) {
  throw new Error("pending family lacks the explicit partial negative-control finding");
}
for (const code of ["IMPLEMENTATION_MISSING", "EVIDENCE_ARTIFACT_MISSING", "PLANNED_IMPLEMENTATION_DRIFT", "CONTROL_UNIMPLEMENTED"]) {
  if (familyFindings.some((finding) => finding.code === code && finding.level === "red")) {
    throw new Error("pending family produced false closure red " + code);
  }
}

const landedRepo = new FakeRepositoryPort({
  revision: ${JSON.stringify(sourceRevision)},
  files: ${JSON.stringify(landedFiles)},
});
const landedResult = await check(landedRepo);
if (landedResult.verdict !== "fail") throw new Error("landed family with an unimplemented control must fail");
const landedFindings = (await explain(landedRepo, "CF-X01-S")).graph.findings;
const controlRed = landedFindings.find(
  (finding) => finding.code === "CONTROL_UNIMPLEMENTED" && finding.level === "red",
);
if (!controlRed || !controlRed.message.includes("NC-X01")) {
  throw new Error("landed unimplemented control must be red and name NC-X01");
}
console.log("pending public root import ok");
`,
  );
  const pendingRootImport = run("node", ["pending-root-import.mjs"], consumer);
  if (!pendingRootImport.stdout.includes("pending public root import ok")) {
    throw new Error("packed public root did not confirm pending-family semantics");
  }

  const checkRun = tryRun(binPath("validation-architect"), ["check", target], consumer);
  if (checkRun.status !== 0) {
    throw new Error(`validation-architect check must exit 0 on a closed corpus, got ${checkRun.status}\n${checkRun.stdout}\n${checkRun.stderr}`);
  }
  if (!checkRun.stdout.includes("verdict: inconclusive")) {
    throw new Error(`structural-only evidence must record inconclusive, got:\n${checkRun.stdout}`);
  }

  const aliasTrace = tryRun(binPath("validation-trace"), [target], consumer);
  if (aliasTrace.status !== checkRun.status || aliasTrace.stdout !== checkRun.stdout) {
    throw new Error(`validation-trace did not execute the exact check path (${aliasTrace.status} vs ${checkRun.status})`);
  }
  if (!aliasTrace.stderr.includes(TRACE_WARNING)) {
    throw new Error("alias trace run must carry the deprecation warning");
  }
  const cutoverAlias = tryRun(
    binPath("validation-trace"),
    [target, "--manifest", "validation-design/legacy-does-not-exist.yaml", "--tests", "tests"],
    consumer,
  );
  if (cutoverAlias.status !== checkRun.status || cutoverAlias.stdout !== checkRun.stdout) {
    throw new Error("legacy alias flags did not select the exact checked-model result after cutover");
  }
  if (!cutoverAlias.stderr.includes(CHECKED_MODEL_SELECTED)) {
    throw new Error("cutover alias did not identify checked-model authority");
  }

  // ── live design command fails closed without its optional SDK ──────────────
  const helpWithoutPeers = tryRun(binPath("validation-architect-design"), ["--help"], consumer);
  if (helpWithoutPeers.status !== 0 || !helpWithoutPeers.stdout.includes("validation-architect-design [target-dir] --profile")) {
    throw new Error(`design help must load without optional peers\n${helpWithoutPeers.stdout}\n${helpWithoutPeers.stderr}`);
  }
  const missingPeerRun = tryRun(
    binPath("validation-architect-design"),
    [target, "--profile", "C0", "--run-id", "missing-peer", "--state-dir", join(scratch, "missing-peer-state")],
    consumer,
  );
  const missingPeerOutput = `${missingPeerRun.stdout}\n${missingPeerRun.stderr}`;
  const missingClaudeMessage =
    "Missing optional peer @anthropic-ai/claude-agent-sdk. Install exactly @anthropic-ai/claude-agent-sdk@0.3.220 before running this design command.";
  if (missingPeerRun.status !== 1 || !missingPeerOutput.includes(missingClaudeMessage)) {
    throw new Error(`design without SDK must exit 1 with the pinned install message\n${missingPeerOutput}`);
  }
  if (missingPeerOutput.includes("ERR_MODULE_NOT_FOUND") || missingPeerOutput.includes("node:internal/modules")) {
    throw new Error(`design without SDK leaked a module-loader stack trace\n${missingPeerOutput}`);
  }

  // ── install both exact tested SDK closures from local packages ─────────────
  const installed = installedPackageDirectories();
  const versionsByName = new Map();
  for (const item of installed) {
    if (!versionsByName.has(item.name)) versionsByName.set(item.name, new Set());
    versionsByName.get(item.name).add(item.version);
  }
  const providerPeers = {};
  for (const name of ["@anthropic-ai/sdk", "@modelcontextprotocol/sdk", "zod"]) {
    const matches = installed.filter((item) => item.name === name);
    if (matches.length !== 1) throw new Error(`expected one installed ${name}, found ${matches.length}`);
    providerPeers[name] = `file:${matches[0].path}`;
  }
  const providerSdks = {};
  for (const [name, version] of Object.entries({
    "@anthropic-ai/claude-agent-sdk": "0.3.220",
    "@openai/codex-sdk": "0.146.0",
  })) {
    const match = installed.find((item) => item.name === name && item.version === version);
    if (!match) throw new Error(`repository install is missing tested SDK ${name}@${version}`);
    providerSdks[name] = `file:${match.path}`;
  }
  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        devDependencies: {
          "@cormidia/validation-architect": `file:${packageTarball}`,
          ...providerSdks,
          ...providerPeers,
        },
      },
      null,
      2,
    )}\n`,
  );
  // The smoke must be offline on an empty host cache. Route every installed
  // package in the provider closure to the exact local package directory.
  // Single-version names can use a name-wide override; multi-version names
  // (notably @openai/codex platform variants) use exact selectors.
  const overrideEntries = new Map(installed
    .filter((item) => item.name !== "yaml" && item.name !== "@cormidia/validation-architect")
    .map((item) => {
      const selector = versionsByName.get(item.name).size === 1 ? item.name : `${item.name}@${item.version}`;
      return [selector, `file:${item.path}`];
    }));
  // npm aliases resolve by dependency key, not by the target package's name.
  // Bind those keys too so platform packages never consult a registry.
  for (const item of installed) {
    const manifest = JSON.parse(readFileSync(join(item.path, "package.json"), "utf8"));
    for (const [alias, specifier] of Object.entries({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      const match = /^npm:(.+)@(\d[^ ]*)$/.exec(specifier);
      if (!match) continue;
      const target = installed.find((candidate) => candidate.name === match[1] && candidate.version === match[2]);
      if (target) overrideEntries.set(alias, `file:${target.path}`);
    }
  }
  const localOverrides = [...overrideEntries]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([selector, path]) => `  ${JSON.stringify(selector)}: ${JSON.stringify(path)}`)
    .join("\n");
  writeFileSync(
    join(consumer, "pnpm-workspace.yaml"),
    `packages:\n  - .\noverrides:\n  yaml: file:${yamlTarball}\n  "@cormidia/validation-architect": file:${packageTarball}\n${localOverrides}\n`,
  );
  // The overrides changed relative to the first install's lockfile; this is
  // still offline, just not frozen.
  run(packageManager, ["install", "--offline", "--ignore-scripts", "--no-frozen-lockfile", "--config.minimumReleaseAge=0"], consumer, { CI: "true" });

  writeFileSync(
    join(consumer, "provider-load.mjs"),
    `
const claude = await import("@anthropic-ai/claude-agent-sdk");
const codex = await import("@openai/codex-sdk");
const design = await import("@cormidia/validation-architect/design");
if (typeof claude.query !== "function") throw new Error("Claude Agent SDK did not load");
if (typeof codex.Codex !== "function") throw new Error("Codex SDK did not load");
if (typeof design.LocalTurnPort !== "function") throw new Error("design subpath did not load");
if (design.CLAUDE_AGENT_SDK_VERSION !== "0.3.220") throw new Error("Claude SDK pin drifted");
if (design.CODEX_SDK_VERSION !== "0.146.0") throw new Error("Codex SDK pin drifted");
console.log("provider and design surfaces loaded");
`,
  );
  const providerLoad = run("node", ["provider-load.mjs"], consumer);
  if (!providerLoad.stdout.includes("provider and design surfaces loaded")) {
    throw new Error("both pinned SDKs and the design subpath did not load");
  }

  const designHelp = tryRun(binPath("validation-architect-design"), ["--help"], consumer);
  if (designHelp.status !== 0 || !designHelp.stdout.includes("validation-architect-design [target-dir] --profile")) {
    throw new Error(`validation-architect-design --help failed with pinned SDKs (${designHelp.status})\n${designHelp.stdout}\n${designHelp.stderr}`);
  }
  const designUsage = tryRun(binPath("validation-architect-design"), [], consumer);
  if (designUsage.status !== 2) throw new Error("bare validation-architect-design must exit 2");

  console.log(
    `package smoke passed: ${basename(packageTarball)} (${listed.length} entries); minimal install + missing-peer failure + pinned-SDK load`,
  );
} finally {
  if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
}
