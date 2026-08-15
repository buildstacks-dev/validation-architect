import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CoreVersionBundle } from "./versions.js";
import { CURRENT_CORE_VERSIONS } from "./versions.js";

export const MIGRATION_OUTPUT_SCHEMA = "validation-architect/migration-output/v1";
export const NOOP_CURRENT_MIGRATION = "no-op-current";

export interface CompatibilityPolicy {
  lifecycle: "pre-1.0-clean-break" | "stable-current-plus-previous";
  current: CoreVersionBundle;
  previous?: CoreVersionBundle;
}

export const CURRENT_COMPATIBILITY_POLICY: Readonly<CompatibilityPolicy> = Object.freeze({
  lifecycle: "pre-1.0-clean-break",
  current: CURRENT_CORE_VERSIONS,
});

const VERSION_FIELDS: Array<keyof CoreVersionBundle> = ["package", "method", "model", "compiler", "policy", "result", "golden_set"];

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  return value;
}

export function canonicalVersionedValue(value: unknown): string {
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

export function versionedValueHash(value: unknown): string {
  return createHash("sha256").update(canonicalVersionedValue(value)).digest("hex");
}

function equalBundle(left: CoreVersionBundle, right: CoreVersionBundle): boolean {
  return VERSION_FIELDS.every((field) => left[field] === right[field]);
}

function major(value: string): number | undefined {
  const match = value.match(/(?:^|\/v|^v)(\d+)(?:\.|$)/);
  return match ? Number(match[1]) : undefined;
}

export interface CompatibilityDecision {
  accepted: boolean;
  mode: "current-read" | "explicit-previous-migration" | "rejected";
  problems: string[];
}

export function checkVersionCompatibility(
  actual: CoreVersionBundle,
  policy: CompatibilityPolicy = CURRENT_COMPATIBILITY_POLICY,
  operation: { kind: "read" } | { kind: "migrate"; migration_name: string } = { kind: "read" },
): CompatibilityDecision {
  if (equalBundle(actual, policy.current)) {
    return operation.kind === "read"
      ? { accepted: true, mode: "current-read", problems: [] }
      : { accepted: false, mode: "rejected", problems: [`current versions require explicit ${NOOP_CURRENT_MIGRATION}; they cannot masquerade as an upgrade`] };
  }
  if (policy.lifecycle === "stable-current-plus-previous" && policy.previous && equalBundle(actual, policy.previous)) {
    return operation.kind === "migrate" && operation.migration_name !== NOOP_CURRENT_MIGRATION
      ? { accepted: true, mode: "explicit-previous-migration", problems: [] }
      : { accepted: false, mode: "rejected", problems: ["the immediately previous major is readable only inside an explicitly named migration"] };
  }
  const mismatches = VERSION_FIELDS.filter((field) => actual[field] !== policy.current[field]);
  const tooOld = policy.previous && mismatches.some((field) => {
    const actualMajor = major(actual[field]);
    const previousMajor = major(policy.previous?.[field] ?? "");
    return actualMajor !== undefined && previousMajor !== undefined && actualMajor < previousMajor;
  });
  return {
    accepted: false,
    mode: "rejected",
    problems: [
      `${tooOld ? "two-or-more-majors-old" : "unknown or semantically mismatched"} version bundle: ${mismatches.map((field) => `${field}=${actual[field]} (expected ${policy.current[field]})`).join(", ")}`,
    ],
  };
}

export function assertCurrentVersionBundle(actual: CoreVersionBundle, policy: CompatibilityPolicy = CURRENT_COMPATIBILITY_POLICY): void {
  const decision = checkVersionCompatibility(actual, policy);
  if (!decision.accepted) throw new Error(`version compatibility refused: ${decision.problems.join("; ")}`);
}

export interface VersionedMigrationSource<T> {
  kind: string;
  versions: CoreVersionBundle;
  source_identity: string;
  payload: T;
}

export function createVersionedMigrationSource<T>(kind: string, versions: CoreVersionBundle, payload: T): VersionedMigrationSource<T> {
  const body = { kind, versions: structuredClone(versions), payload: structuredClone(payload) };
  return { ...body, source_identity: versionedValueHash(body) };
}

export function createCurrentVersionedArtifact<T>(kind: string, payload: T, policy: CompatibilityPolicy = CURRENT_COMPATIBILITY_POLICY): VersionedMigrationSource<T> {
  return createVersionedMigrationSource(kind, policy.current, payload);
}

export function readCurrentVersionedArtifact<T>(source: VersionedMigrationSource<T>, policy: CompatibilityPolicy = CURRENT_COMPATIBILITY_POLICY): VersionedMigrationSource<T> {
  validateSource(source);
  assertCurrentVersionBundle(source.versions, policy);
  return structuredClone(source);
}

export interface MigrationReviewEvidence {
  id: string;
  reviewer: string;
  decision: "approved";
  reference: string;
  integrity: string;
}

export function createMigrationReviewEvidence(id: string, reviewer: string, reference: string): MigrationReviewEvidence {
  const review = { id, reviewer, decision: "approved" as const, reference };
  return { ...review, integrity: versionedValueHash(review) };
}

export interface VersionMigrationDefinition<Source, Target> {
  name: string;
  source_versions: CoreVersionBundle;
  target_versions: CoreVersionBundle;
  migrate(payload: Readonly<Source>): Target;
  validate(source: Readonly<Source>, target: Readonly<Target>): string[];
}

export interface VersionMigrationPlan<Source, Target> {
  kind: "upgrade";
  migration_name: string;
  source: VersionedMigrationSource<Source>;
  source_versions: CoreVersionBundle;
  target_versions: CoreVersionBundle;
  review_evidence: MigrationReviewEvidence;
  definition: VersionMigrationDefinition<Source, Target>;
}

function validateSource<T>(source: VersionedMigrationSource<T>): void {
  const expected = versionedValueHash({ kind: source.kind, versions: source.versions, payload: source.payload });
  if (source.source_identity !== expected) throw new Error("migration source identity mismatch; source may be stale or tampered");
}

function validateReview(review: MigrationReviewEvidence | undefined): asserts review is MigrationReviewEvidence {
  if (!review?.id || !review.reviewer || !review.reference || review.decision !== "approved") throw new Error("migration requires recorded approved review evidence");
  const expected = versionedValueHash({ id: review.id, reviewer: review.reviewer, decision: review.decision, reference: review.reference });
  if (review.integrity !== expected) throw new Error("migration review evidence integrity mismatch");
}

export function planVersionMigration<Source, Target>(
  source: VersionedMigrationSource<Source>,
  definition: VersionMigrationDefinition<Source, Target>,
  review: MigrationReviewEvidence,
  policy: CompatibilityPolicy,
): VersionMigrationPlan<Source, Target> {
  validateSource(source);
  validateReview(review);
  const decision = checkVersionCompatibility(source.versions, policy, { kind: "migrate", migration_name: definition.name });
  if (!decision.accepted) throw new Error(`migration refused: ${decision.problems.join("; ")}`);
  if (!equalBundle(definition.source_versions, source.versions) || !equalBundle(definition.target_versions, policy.current)) throw new Error("migration definition source/target versions do not match the compatibility policy");
  if (!definition.name || definition.name === NOOP_CURRENT_MIGRATION) throw new Error("a previous-major upgrade requires a distinct named migration");
  return { kind: "upgrade", migration_name: definition.name, source: structuredClone(source), source_versions: structuredClone(source.versions), target_versions: structuredClone(policy.current), review_evidence: structuredClone(review), definition };
}

export interface MigrationEvidence {
  source_identity: string;
  source_versions: CoreVersionBundle;
  target_versions: CoreVersionBundle;
  migration_name: string;
  review_evidence: MigrationReviewEvidence;
  output_hash: string;
  validation: { accepted: boolean; problems: string[] };
}

export interface CompletedMigrationOutput<T> {
  schema: typeof MIGRATION_OUTPUT_SCHEMA;
  complete: true;
  artifact: VersionedMigrationSource<T>;
  evidence: MigrationEvidence;
}

export function applyVersionMigration<Source, Target>(plan: VersionMigrationPlan<Source, Target>): CompletedMigrationOutput<Target> {
  validateSource(plan.source);
  validateReview(plan.review_evidence);
  const sourcePayload = structuredClone(plan.source.payload);
  const targetPayload = plan.definition.migrate(sourcePayload);
  const problems = plan.definition.validate(plan.source.payload, targetPayload);
  const artifact = createVersionedMigrationSource(plan.source.kind, plan.target_versions, targetPayload);
  const outputHash = versionedValueHash(artifact);
  const output: CompletedMigrationOutput<Target> = {
    schema: MIGRATION_OUTPUT_SCHEMA,
    complete: true,
    artifact,
    evidence: {
      source_identity: plan.source.source_identity,
      source_versions: structuredClone(plan.source_versions),
      target_versions: structuredClone(plan.target_versions),
      migration_name: plan.migration_name,
      review_evidence: structuredClone(plan.review_evidence),
      output_hash: outputHash,
      validation: { accepted: problems.length === 0, problems: [...problems] },
    },
  };
  if (problems.length > 0) throw new Error(`migration validation failed: ${problems.join("; ")}`);
  return output;
}

export function validateCompletedMigration(value: CompletedMigrationOutput<unknown>): string[] {
  const problems: string[] = [];
  if (!record(value) || value.schema !== MIGRATION_OUTPUT_SCHEMA || value.complete !== true || !record(value.artifact) || !record(value.evidence)) {
    return ["migration output is partial or has an unsupported schema"];
  }
  try { validateSource(value.artifact); } catch (error) { problems.push((error as Error).message); }
  try { validateReview(value.evidence.review_evidence); } catch (error) { problems.push((error as Error).message); }
  if (!value.evidence.validation.accepted || value.evidence.validation.problems.length > 0) problems.push("migration validation did not accept the output");
  if (value.evidence.output_hash !== versionedValueHash(value.artifact)) problems.push("migration output hash mismatch");
  if (!equalBundle(value.artifact.versions, value.evidence.target_versions)) problems.push("artifact and evidence target versions disagree");
  return problems;
}

export function writeCompletedMigration(path: string, output: CompletedMigrationOutput<unknown>, sourcePath?: string, policy: CompatibilityPolicy = CURRENT_COMPATIBILITY_POLICY): void {
  const destination = resolve(path);
  if (sourcePath && destination === resolve(sourcePath)) throw new Error("migration output must be a new path; source corpora are never edited in place");
  const problems = validateCompletedMigration(output);
  if (problems.length > 0) throw new Error(`refusing invalid migration output: ${problems.join("; ")}`);
  assertCurrentVersionBundle(output.artifact.versions, policy);
  const temporary = `${destination}.tmp-${randomUUID()}`;
  writeFileSync(temporary, canonicalVersionedValue(output));
  renameSync(temporary, destination);
}

export function readCompletedMigration(path: string, policy: CompatibilityPolicy = CURRENT_COMPATIBILITY_POLICY): CompletedMigrationOutput<unknown> {
  const value = JSON.parse(readFileSync(path, "utf8")) as CompletedMigrationOutput<unknown>;
  const problems = validateCompletedMigration(value);
  if (problems.length > 0) throw new Error(`invalid completed migration: ${problems.join("; ")}`);
  assertCurrentVersionBundle(value.artifact.versions, policy);
  return structuredClone(value);
}

export interface CurrentVersionAcknowledgement {
  kind: "no-op";
  migration_name: typeof NOOP_CURRENT_MIGRATION;
  source_identity: string;
  versions: CoreVersionBundle;
}

export function acknowledgeCurrentVersion<T>(source: VersionedMigrationSource<T>, policy: CompatibilityPolicy): CurrentVersionAcknowledgement {
  validateSource(source);
  assertCurrentVersionBundle(source.versions, policy);
  return { kind: "no-op", migration_name: NOOP_CURRENT_MIGRATION, source_identity: source.source_identity, versions: structuredClone(source.versions) };
}

export function acceptedBundleIdentity(value: {
  sourceFingerprint: string;
  surfaceFingerprint: string;
  modelIdentity: string;
  versions: CoreVersionBundle;
}): string {
  return versionedValueHash({
    sourceFingerprint: value.sourceFingerprint,
    surfaceFingerprint: value.surfaceFingerprint,
    modelIdentity: value.modelIdentity,
    versions: value.versions,
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function looksLikeBundle(value: unknown): value is CoreVersionBundle {
  return record(value) && VERSION_FIELDS.every((field) => typeof value[field] === "string");
}

/** Optional conformance hook: versioned core artifacts are checked; unrelated host records remain outside core authority. */
export function inspectArtifactVersionProvenance(
  artifact: unknown,
  policy: CompatibilityPolicy = CURRENT_COMPATIBILITY_POLICY,
): { status: "not-versioned" } | { status: "accepted" | "rejected"; versions: CoreVersionBundle; decision: CompatibilityDecision } {
  if (!record(artifact)) return { status: "not-versioned" };
  const identity = record(artifact.identity) ? artifact.identity : undefined;
  const compilation = record(artifact.compilation) ? artifact.compilation : undefined;
  const versions = looksLikeBundle(artifact.versions)
    ? artifact.versions
    : looksLikeBundle(identity?.versions)
      ? identity.versions
      : looksLikeBundle(compilation?.versions)
        ? compilation.versions
        : undefined;
  if (!versions) return { status: "not-versioned" };
  const decision = checkVersionCompatibility(versions, policy);
  return { status: decision.accepted ? "accepted" : "rejected", versions: structuredClone(versions), decision };
}
