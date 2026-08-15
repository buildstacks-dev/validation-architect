import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { planChangedImpact, IMPACT_MAPPING_SCHEMA } from "../src/impact.js";
import { runCampaign, type OrchestratorDeps } from "../src/orchestrator.js";
import { buildRelationshipGraph } from "../src/relationship-graph.js";
import { assertRunStateVersionCompatible, recoverUnversionedRunState, UNVERSIONED_RUN_RECOVERY } from "../src/run-state-version.js";
import type { RunConfig, RunState } from "../src/types.js";
import {
  acknowledgeCurrentVersion,
  acceptedBundleIdentity,
  applyVersionMigration,
  assertCurrentVersionBundle,
  canonicalVersionedValue,
  checkVersionCompatibility,
  createMigrationReviewEvidence,
  createCurrentVersionedArtifact,
  createVersionedMigrationSource,
  CURRENT_COMPATIBILITY_POLICY,
  inspectArtifactVersionProvenance,
  MIGRATION_OUTPUT_SCHEMA,
  NOOP_CURRENT_MIGRATION,
  planVersionMigration,
  readCurrentVersionedArtifact,
  readCompletedMigration,
  validateCompletedMigration,
  versionedValueHash,
  writeCompletedMigration,
  type CompatibilityPolicy,
  type VersionMigrationDefinition,
} from "../src/version-compatibility.js";
import { CURRENT_CORE_VERSIONS, type CoreVersionBundle } from "../src/versions.js";
import { graphFixture } from "./core-graph-fixture.js";

interface FixturePayload {
  schema: string;
  status: string;
  owner: { id: string; name: string };
  source: { id: string; path: string };
  control: { id: string; family_id: string; expected_failure: string };
  family: { id: string; structure_ids: string[]; control_ids: string[]; evidence: { state: string; path: string } };
  trace: string[];
}

function bundle(major: number): CoreVersionBundle {
  return {
    package: `${major}.0.0`,
    method: `${major}.0.0`,
    model: `validation-architect/model/v${major}`,
    compiler: `validation-architect/compiler/v${major}`,
    policy: `validation-architect/policy/v${major}`,
    result: `validation-architect/result/v${major}`,
    golden_set: `validation-architect/golden-set/v${major}`,
  };
}

const stablePolicy: CompatibilityPolicy = {
  lifecycle: "stable-current-plus-previous",
  current: bundle(2),
  previous: bundle(1),
};

function fixture(name: "previous-v1" | "current-v2"): FixturePayload {
  return JSON.parse(readFileSync(resolve(__dirname, "fixtures", "versioning", `${name}.json`), "utf8")) as FixturePayload;
}

const definition: VersionMigrationDefinition<FixturePayload, FixturePayload> = {
  name: "fixture-design-v1-to-v2",
  source_versions: stablePolicy.previous!,
  target_versions: stablePolicy.current,
  migrate: (payload) => ({ ...structuredClone(payload), schema: "validation-architect/fixture-design/v2" }),
  validate: (source, target) => {
    const { schema: _sourceSchema, ...sourceMeaning } = source;
    const { schema: _targetSchema, ...targetMeaning } = target;
    return canonicalVersionedValue(sourceMeaning) === canonicalVersionedValue(targetMeaning) && target.schema.endsWith("/v2")
      ? []
      : ["required design meaning changed"];
  },
};

function config(): RunConfig {
  return { fixture: "fixture", runId: "run", designerModel: "designer", stakeholderModel: "stakeholder", readerModel: "reader", claudeAuth: "subscription", codexAuth: "chatgpt", maxExchanges: 1, maxWallMinutes: 1, designerMaxTurns: 1 };
}

function state(versions: CoreVersionBundle | null = CURRENT_CORE_VERSIONS): RunState {
  return {
    runId: "run",
    fixture: "fixture",
    workspace: "/tmp/version-fixture",
    status: "running",
    ...(versions ? { coreVersions: structuredClone(versions) } : {}),
    exchanges: 0,
    seq: 0,
    pending: { to: "designer", text: "resume exactly this" },
    startedAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    config: config(),
  };
}

describe("core compatibility decisions", () => {
  it("reads current versions without mutation and uses an explicit no-op acknowledgement", () => {
    const versions = structuredClone(CURRENT_CORE_VERSIONS);
    const before = canonicalVersionedValue(versions);
    expect(checkVersionCompatibility(versions, CURRENT_COMPATIBILITY_POLICY)).toEqual({ accepted: true, mode: "current-read", problems: [] });
    assertCurrentVersionBundle(versions);
    expect(canonicalVersionedValue(versions)).toBe(before);
    const source = createCurrentVersionedArtifact("current", { value: 1 });
    const sourceBefore = canonicalVersionedValue(source);
    expect(readCurrentVersionedArtifact(source)).toEqual(source);
    expect(canonicalVersionedValue(source)).toBe(sourceBefore);
    expect(acknowledgeCurrentVersion(source, CURRENT_COMPATIBILITY_POLICY)).toMatchObject({ kind: "no-op", migration_name: NOOP_CURRENT_MIGRATION, source_identity: source.source_identity });
    const falseUpgrade: VersionMigrationDefinition<{ value: number }, { value: number }> = { name: "false-current-upgrade", source_versions: versions, target_versions: versions, migrate: (payload) => ({ ...payload }), validate: () => [] };
    expect(() => planVersionMigration(source, falseUpgrade, createMigrationReviewEvidence("R", "reviewer", "reviews/current.md"), CURRENT_COMPATIBILITY_POLICY)).toThrow(/cannot masquerade as an upgrade/);
  });

  it("rejects previous major on ordinary read and accepts it only in a named migration", () => {
    expect(checkVersionCompatibility(stablePolicy.previous!, stablePolicy)).toMatchObject({ accepted: false, mode: "rejected" });
    expect(checkVersionCompatibility(stablePolicy.previous!, stablePolicy, { kind: "migrate", migration_name: definition.name })).toEqual({ accepted: true, mode: "explicit-previous-migration", problems: [] });
    expect(checkVersionCompatibility(stablePolicy.previous!, stablePolicy, { kind: "migrate", migration_name: NOOP_CURRENT_MIGRATION }).accepted).toBe(false);
  });

  it("rejects too-old, unknown, and semantically mixed bundles", () => {
    expect(checkVersionCompatibility(bundle(0), stablePolicy).problems.join(" ")).toContain("two-or-more-majors-old");
    const unknown = bundle(9);
    expect(checkVersionCompatibility(unknown, stablePolicy).accepted).toBe(false);
    const mixed = { ...stablePolicy.current, method: stablePolicy.previous!.method };
    expect(checkVersionCompatibility(mixed, stablePolicy).problems.join(" ")).toMatch(/semantically mismatched.*method=/);
  });
});

describe("named deterministic migration", () => {
  it("requires integrity-bound review evidence and exact source identity", () => {
    const source = createVersionedMigrationSource("fixture-design", stablePolicy.previous!, fixture("previous-v1"));
    expect(() => planVersionMigration(source, definition, undefined as never, stablePolicy)).toThrow(/requires recorded approved review evidence/);
    const tamperedReview = createMigrationReviewEvidence("REV-1", "reviewer", "reviews/v2.md");
    tamperedReview.reference = "reviews/changed.md";
    expect(() => planVersionMigration(source, definition, tamperedReview, stablePolicy)).toThrow(/review evidence integrity mismatch/);
    const tamperedSource = structuredClone(source);
    tamperedSource.payload.status = "pending";
    expect(() => planVersionMigration(tamperedSource, definition, createMigrationReviewEvidence("REV-1", "reviewer", "reviews/v2.md"), stablePolicy)).toThrow(/source identity mismatch/);
  });

  it("preserves status, evidence, controls, ownership, provenance, and trace deterministically", () => {
    const previous = fixture("previous-v1");
    const previousBefore = canonicalVersionedValue(previous);
    const source = createVersionedMigrationSource("fixture-design", stablePolicy.previous!, previous);
    const review = createMigrationReviewEvidence("REV-1", "human-reviewer", "reviews/fixture-v2.md");
    const plan = planVersionMigration(source, definition, review, stablePolicy);
    const first = applyVersionMigration(plan);
    const second = applyVersionMigration(plan);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ schema: MIGRATION_OUTPUT_SCHEMA, complete: true, evidence: { source_identity: source.source_identity, source_versions: stablePolicy.previous, target_versions: stablePolicy.current, migration_name: definition.name, review_evidence: review, validation: { accepted: true, problems: [] } } });
    expect(first.evidence.output_hash).toBe(versionedValueHash(first.artifact));
    expect(first.artifact.payload).toEqual(fixture("current-v2"));
    expect(canonicalVersionedValue(previous)).toBe(previousBefore);
    expect(validateCompletedMigration(first)).toEqual([]);
  });

  it("writes only a new atomic output and rejects interrupted or tampered output", () => {
    const dir = mkdtempSync(join(tmpdir(), "vda-migration-"));
    const sourcePath = join(dir, "source.json");
    const outputPath = join(dir, "output.json");
    writeFileSync(sourcePath, canonicalVersionedValue(fixture("previous-v1")));
    const sourceBefore = readFileSync(sourcePath, "utf8");
    const source = createVersionedMigrationSource("fixture-design", stablePolicy.previous!, fixture("previous-v1"));
    const output = applyVersionMigration(planVersionMigration(source, definition, createMigrationReviewEvidence("REV-1", "reviewer", "reviews/v2.md"), stablePolicy));
    expect(() => writeCompletedMigration(sourcePath, output, sourcePath)).toThrow(/never edited in place/);
    writeCompletedMigration(outputPath, output, sourcePath, stablePolicy);
    expect(readCompletedMigration(outputPath, stablePolicy)).toEqual(output);
    expect(readFileSync(sourcePath, "utf8")).toBe(sourceBefore);

    const partialPath = join(dir, "partial.json");
    writeFileSync(partialPath, JSON.stringify({ schema: MIGRATION_OUTPUT_SCHEMA, complete: false }));
    expect(() => readCompletedMigration(partialPath)).toThrow(/partial|invalid/i);
    const tampered = structuredClone(output);
    tampered.artifact.payload.status = "changed-after-migration";
    expect(validateCompletedMigration(tampered).join(" ")).toMatch(/identity mismatch|output hash mismatch/);
  });
});

describe("version provenance integration and resume safety", () => {
  it("checks model/result/graph/plan artifacts while leaving unrelated host records unblocked", () => {
    const fixtureData = graphFixture();
    const graph = buildRelationshipGraph({ ...fixtureData, model_identity: "model-1" });
    const plan = planChangedImpact({ model: fixtureData.model, graph, inventory: fixtureData.inventory, mappings: { schema: IMPACT_MAPPING_SCHEMA, identity: "map", product_revision: "rev-1", mappings: [{ id: "map", path_pattern: "src/tenant/**", structure_ids: ["CON-TENANT"], confidence: "exact" }] }, changed_inputs: [{ id: "change", path: "src/tenant/x.ts", kind: "content" }], lane: "per-commit", full_ci_command: "pnpm test" });
    expect(inspectArtifactVersionProvenance(fixtureData.model).status).toBe("accepted");
    expect(inspectArtifactVersionProvenance(graph).status).toBe("accepted");
    expect(inspectArtifactVersionProvenance(plan).status).toBe("accepted");
    expect(inspectArtifactVersionProvenance({ host: "unrelated" })).toEqual({ status: "not-versioned" });
  });

  it("validates accepted bundle identity and rejects mismatches before a provider turn", async () => {
    const run = state();
    const compilation = { sourceFingerprint: "source", surfaceFingerprint: "surface", status: "accepted" as const, compilerVersion: CURRENT_CORE_VERSIONS.compiler, modelIdentity: "model", versions: structuredClone(CURRENT_CORE_VERSIONS), diagnosticCodes: [] as string[], acceptedBundleIdentity: "" };
    compilation.acceptedBundleIdentity = acceptedBundleIdentity(compilation);
    run.compilation = compilation;
    expect(() => assertRunStateVersionCompatible(run)).not.toThrow();
    run.compilation.acceptedBundleIdentity = "tampered";
    expect(() => assertRunStateVersionCompatible(run)).toThrow(/bundle identity mismatch/);

    const wrong = state({ ...CURRENT_CORE_VERSIONS, method: "9.0.0" });
    let providerCalls = 0;
    const deps = { designer: { send: async () => { providerCalls++; return { text: "" }; }, sessionId: () => undefined } } as unknown as OrchestratorDeps;
    await expect(runCampaign(deps, wrong, {} as never)).rejects.toThrow(/version compatibility refused/);
    expect(providerCalls).toBe(0);
    expect(wrong.pending).toEqual({ to: "designer", text: "resume exactly this" });
  });

  it("rejects an invalid persisted intent source before a provider turn", () => {
    const run = state();
    (run as unknown as { intentSource: string }).intentSource = "filesystem-whim";
    expect(() => assertRunStateVersionCompatible(run)).toThrow(/invalid intent source/);
  });

  it("uses a named pre-1.0 recovery without repeating or dropping the pending message", () => {
    const legacy = state(null);
    const pendingBefore = structuredClone(legacy.pending);
    expect(() => assertRunStateVersionCompatible(legacy)).toThrow(new RegExp(UNVERSIONED_RUN_RECOVERY));
    recoverUnversionedRunState(legacy, UNVERSIONED_RUN_RECOVERY);
    expect(legacy.pending).toEqual(pendingBefore);
    expect(legacy.coreVersions).toEqual(CURRENT_CORE_VERSIONS);
    expect(legacy.versionRecovery).toMatchObject({ name: UNVERSIONED_RUN_RECOVERY, source: "unversioned-pre1-run-state", pendingIdentity: versionedValueHash(pendingBefore) });
    expect(() => assertRunStateVersionCompatible(legacy)).not.toThrow();
    expect(() => recoverUnversionedRunState(legacy, UNVERSIONED_RUN_RECOVERY)).toThrow(/already has version provenance/);
  });
});
