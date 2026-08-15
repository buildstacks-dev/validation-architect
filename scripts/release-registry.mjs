#!/usr/bin/env node
/** Read-only npm registry reconciliation for the protected release workflow. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGES = ["validation-architect", "validation-architect-design"];

export function tarballIntegrity(path) {
  return `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
}

export function classifyViewResult(result, expectedVersion, expectedIntegrity, packageName) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    let code;
    try { code = JSON.parse(result.stdout || "null")?.error?.code; } catch { /* handled below */ }
    if (code === "E404") return { state: "missing" };
    throw new Error(
      `npm view ${packageName}@${expectedVersion} was ambiguous (exit ${result.status}):\n${result.stderr || result.stdout}`,
    );
  }
  let value;
  try { value = JSON.parse(result.stdout); } catch {
    throw new Error(`npm view ${packageName}@${expectedVersion} returned invalid JSON.`);
  }
  const version = value?.version;
  const integrity = value?.["dist.integrity"] ?? value?.dist?.integrity;
  if (version !== expectedVersion || typeof integrity !== "string") {
    throw new Error(`npm view ${packageName}@${expectedVersion} returned an invalid version/integrity record.`);
  }
  if (integrity !== expectedIntegrity) {
    throw new Error(
      `${packageName}@${expectedVersion} exists with different integrity; expected ${expectedIntegrity}, registry has ${integrity}.`,
    );
  }
  return { state: "matching", integrity };
}

export function publicationPlan(core, design) {
  if (core.state === "missing" && design.state === "matching") {
    throw new Error("Design is published while core is missing; stop for manual investigation.");
  }
  return {
    publishCore: core.state === "missing",
    publishDesign: design.state === "missing",
  };
}

function inspect(packageName, version, integrity) {
  const result = spawnSync(
    process.env["NPM_BINARY"] || "npm",
    ["view", `${packageName}@${version}`, "version", "dist.integrity", "--json"],
    { encoding: "utf8" },
  );
  return classifyViewResult(result, version, integrity, packageName);
}

function usage() {
  console.error("usage: release-registry.mjs <plan|verify> <version> <core.tgz> <design.tgz>");
  return 2;
}

export function main(argv) {
  const [mode, version, corePath, designPath] = argv;
  if ((mode !== "plan" && mode !== "verify") || !/^\d+\.\d+\.\d+$/.test(version ?? "") || !corePath || !designPath) {
    return usage();
  }
  try {
    const integrities = [tarballIntegrity(resolve(corePath)), tarballIntegrity(resolve(designPath))];
    const states = PACKAGES.map((name, index) => inspect(name, version, integrities[index]));
    console.error(`registry: core=${states[0].state} design=${states[1].state}`);
    if (mode === "verify") {
      if (states.some((state) => state.state !== "matching")) {
        throw new Error("Partial or ambiguous publication: both exact tarball integrities are required.");
      }
      return 0;
    }
    const plan = publicationPlan(states[0], states[1]);
    const output = process.env["GITHUB_OUTPUT"];
    if (output) {
      appendFileSync(output, `publish_core=${String(plan.publishCore)}\npublish_design=${String(plan.publishDesign)}\n`);
    }
    console.log(JSON.stringify(plan));
    return 0;
  } catch (error) {
    console.error(`[release-registry] ${(error).message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
