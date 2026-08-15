/**
 * The six published schema families (VA-API-001 §6). Each carries its own
 * major because persisted files outlive package installs. Validators are the
 * runtime authority; the JSON Schema assets under `schemas/` are the
 * machine-readable mirror shipped as package data.
 */

import { parse as parseYaml } from "yaml";
import { MANIFEST_SCHEMA, parseManifest, serializeManifest, type CaseCatalogManifest } from "../catalog.js";
import { compileValidationModel, type ModelFileSet } from "../model-compiler.js";
import type { CompiledDesignModel } from "../model.js";
import { IMPACT_PLAN_SCHEMA, type ExplainedImpactPlan } from "../impact.js";
import {
  canonicalValidationResult,
  parseValidationResult,
  validateValidationResult,
  type ValidationResultV1,
} from "../validation-result.js";
import { MODEL_SCHEMA, RESULT_SCHEMA } from "../versions.js";
import {
  DESIGN_RUN_SCHEMA,
  PROVENANCE_SCHEMA,
  validateCheckpoint,
  validateEnvelope,
  validateProvenance,
  type CampaignCheckpoint,
  type CampaignEnvelope,
  type Provenance,
} from "./campaign-contracts.js";
import { invalidInput, unsupportedSchemaMajor } from "./errors.js";
import { assertValid, isRecord, requireRecord, requireString } from "./validate.js";

export const CORPUS_SCHEMA = MODEL_SCHEMA;
export const CASE_CATALOG_SCHEMA = MANIFEST_SCHEMA;
export const PLAN_SCHEMA = IMPACT_PLAN_SCHEMA;
export { DESIGN_RUN_SCHEMA, PROVENANCE_SCHEMA, RESULT_SCHEMA };

export const PUBLISHED_SCHEMA_IDS = Object.freeze({
  corpus: CORPUS_SCHEMA,
  caseCatalog: CASE_CATALOG_SCHEMA,
  result: RESULT_SCHEMA,
  plan: PLAN_SCHEMA,
  designRun: DESIGN_RUN_SCHEMA,
  provenance: PROVENANCE_SCHEMA,
} as const);

/** Reject a self-described schema ID outside the supported major. */
export function assertSupportedSchema(actual: unknown, expected: string): void {
  if (actual === expected) return;
  if (typeof actual === "string" && actual.startsWith(expected.slice(0, expected.lastIndexOf("/v")))) {
    throw unsupportedSchemaMajor(actual, [expected]);
  }
  throw invalidInput(`Expected schema ${expected}, found ${String(actual)}`, { expected, actual });
}

/** Canonical JSON: stable key order, no incidental formatting variance. */
export function canonicalJson(value: unknown): string {
  const sorted = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sorted);
    if (isRecord(input)) {
      return Object.fromEntries(
        Object.keys(input)
          .sort()
          .map((key) => [key, sorted(input[key])]),
      );
    }
    return input;
  };
  return JSON.stringify(sorted(value), null, 2);
}

// ── corpus/v1 ────────────────────────────────────────────────────────────────

/** Validate the eight-file corpus by compiling it with the sole-authority
 * compiler; a corpus is valid exactly when the compiler accepts it. */
export function validateCorpus(files: Partial<ModelFileSet>): {
  valid: boolean;
  model?: CompiledDesignModel;
  identity?: string;
  problems: string[];
} {
  const compiled = compileValidationModel(files, { allowRegenerate: false });
  return {
    valid: compiled.accepted,
    ...(compiled.model ? { model: compiled.model } : {}),
    ...(compiled.identity ? { identity: compiled.identity } : {}),
    problems: compiled.diagnostics
      .filter((item) => item.severity === "error")
      .map((item) => `${item.location.file}:${item.location.line} ${item.message}`),
  };
}

// ── case-catalog/v1 ──────────────────────────────────────────────────────────

export function validateCaseCatalog(serialized: string): CaseCatalogManifest {
  let manifest: CaseCatalogManifest;
  try {
    manifest = parseManifest(serialized);
  } catch (error) {
    throw invalidInput(`case catalog rejected: ${(error as Error).message}`);
  }
  assertSupportedSchema(manifest.schema, CASE_CATALOG_SCHEMA);
  return manifest;
}

export function canonicalCaseCatalog(manifest: CaseCatalogManifest): string {
  return serializeManifest(manifest);
}

// ── result/v1 ────────────────────────────────────────────────────────────────

export function validateResult(value: unknown): ValidationResultV1 {
  if (!isRecord(value)) throw invalidInput("result must be an object");
  assertSupportedSchema(value.schema, RESULT_SCHEMA);
  let problems: string[];
  try {
    problems = validateValidationResult(value as unknown as ValidationResultV1);
  } catch (error) {
    // A structurally hostile record must fail validation, never crash past it.
    problems = [`record shape rejected: ${(error as Error).message}`];
  }
  assertValid(RESULT_SCHEMA, problems);
  return value as unknown as ValidationResultV1;
}

export function parseResult(serialized: string, format: "json" | "yaml"): ValidationResultV1 {
  try {
    return parseValidationResult(serialized, format);
  } catch (error) {
    throw invalidInput(`result rejected: ${(error as Error).message}`);
  }
}

export { canonicalValidationResult as canonicalResult };

// ── plan/v1 ──────────────────────────────────────────────────────────────────

export function validatePlan(value: unknown): ExplainedImpactPlan {
  const problems: string[] = [];
  if (!requireRecord(value, "plan", problems)) {
    assertValid(PLAN_SCHEMA, problems);
  }
  const plan = value as Record<string, unknown>;
  assertSupportedSchema(plan.schema, PLAN_SCHEMA);
  if (plan.advisory !== true) problems.push("plan.advisory must be true");
  if (plan.full_required_ci_authoritative !== true) problems.push("plan.full_required_ci_authoritative must be true");
  if (!requireRecord(plan.identity, "plan.identity", problems)) assertValid(PLAN_SCHEMA, problems);
  const identity = plan.identity as Record<string, unknown>;
  for (const key of ["model_identity", "graph_identity", "inventory_identity", "mapping_identity", "product_revision", "lane"]) {
    requireString(identity[key], `plan.identity.${key}`, problems);
  }
  for (const key of [
    "changed_inputs",
    "affected_meaning",
    "structure_ids",
    "family_ids",
    "test_ids",
    "negative_control_ids",
    "always_run_test_ids",
    "expansions",
    "unknowns",
    "commands",
  ]) {
    if (!Array.isArray(plan[key])) problems.push(`plan.${key} must be an array`);
  }
  if (!requireRecord(plan.full_required_ci, "plan.full_required_ci", problems)) assertValid(PLAN_SCHEMA, problems);
  const fullCi = plan.full_required_ci as Record<string, unknown>;
  requireString(fullCi.command, "plan.full_required_ci.command", problems);
  if (fullCi.run_count !== 1) problems.push("plan.full_required_ci.run_count must be 1");
  assertValid(PLAN_SCHEMA, problems);
  return value as unknown as ExplainedImpactPlan;
}

export function canonicalPlan(plan: ExplainedImpactPlan): string {
  return canonicalJson(plan);
}

// ── design-run/v1 ────────────────────────────────────────────────────────────

export function validateDesignRunEnvelope(value: unknown): CampaignEnvelope {
  const problems: string[] = [];
  validateEnvelope(value, problems);
  assertValid(`${DESIGN_RUN_SCHEMA} envelope`, problems);
  return value as CampaignEnvelope;
}

export function validateDesignRunCheckpoint(value: unknown): CampaignCheckpoint {
  const problems: string[] = [];
  validateCheckpoint(value, problems);
  assertValid(`${DESIGN_RUN_SCHEMA} checkpoint`, problems);
  return value as CampaignCheckpoint;
}

export function parseDesignRunCheckpoint(serialized: string): CampaignCheckpoint {
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch (error) {
    throw invalidInput(`checkpoint rejected: ${(error as Error).message}`);
  }
  if (isRecord(raw)) assertSupportedSchema(raw.schema, DESIGN_RUN_SCHEMA);
  return validateDesignRunCheckpoint(raw);
}

export function canonicalCheckpoint(checkpoint: CampaignCheckpoint): string {
  return canonicalJson(checkpoint);
}

// ── provenance/v1 ────────────────────────────────────────────────────────────

export function validateProvenanceRecord(value: unknown): Provenance {
  if (isRecord(value)) assertSupportedSchema(value.schema, PROVENANCE_SCHEMA);
  const problems: string[] = [];
  validateProvenance(value, problems);
  assertValid(PROVENANCE_SCHEMA, problems);
  return value as Provenance;
}

export function canonicalProvenance(provenance: Provenance): string {
  return canonicalJson(provenance);
}

// ── shared parsing helper ────────────────────────────────────────────────────

/** Parse repository YAML defensively; hostile content raises invalid_input. */
export function parseRepositoryYaml(content: string, describe: string): unknown {
  try {
    return parseYaml(content);
  } catch (error) {
    throw invalidInput(`${describe} is not readable YAML: ${(error as Error).message}`, { describe });
  }
}

const SCHEMA_ASSET_FILES = Object.freeze({
  [CORPUS_SCHEMA]: "corpus.v1.schema.json",
  [CASE_CATALOG_SCHEMA]: "case-catalog.v1.schema.json",
  [RESULT_SCHEMA]: "result.v1.schema.json",
  [PLAN_SCHEMA]: "plan.v1.schema.json",
  [DESIGN_RUN_SCHEMA]: "design-run.v1.schema.json",
  [PROVENANCE_SCHEMA]: "provenance.v1.schema.json",
});

/** Package-relative filenames of the machine-readable schema assets. */
export function schemaAssetFile(schemaId: string): string {
  const file = (SCHEMA_ASSET_FILES as Record<string, string>)[schemaId];
  if (!file) throw invalidInput(`No published schema asset for ${schemaId}`, { schemaId });
  return file;
}
