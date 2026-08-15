import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runImpactBenchmark, type ImpactBenchmarkCase, type ImpactBenchmarkCategory } from "../src/impact-benchmark.js";
import { IMPACT_MAPPING_SCHEMA, planChangedImpact, type ChangedInput, type ImpactMappingSet, type ImpactPlannerInput } from "../src/impact.js";
import { buildRelationshipGraph } from "../src/relationship-graph.js";
import { impactPlanToValidationResult } from "../src/result-adapters.js";
import { canonicalValidationResult, parseValidationResult, validateValidationResult } from "../src/validation-result.js";
import { graphFixture } from "./core-graph-fixture.js";

function base(): ImpactPlannerInput {
  const fixture = graphFixture();
  const graph = buildRelationshipGraph({ ...fixture, model_identity: "model-1", projection_identity: "model-1" });
  const mappings: ImpactMappingSet = {
    schema: IMPACT_MAPPING_SCHEMA,
    identity: "mapping-1",
    product_revision: "rev-1",
    mappings: [
      { id: "MAP-TENANT", path_pattern: "src/tenant/**", structure_ids: ["CON-TENANT"], confidence: "exact" },
      { id: "MAP-RETRY", path_pattern: "src/retry/**", structure_ids: ["INV-RETRY"], confidence: "exact" },
    ],
  };
  return { model: fixture.model, graph, inventory: fixture.inventory, mappings, changed_inputs: [{ id: "change-tenant", path: "src/tenant/lookup.ts", kind: "content" }], lane: "per-commit", full_ci_command: "pnpm test" };
}

describe("conservative changed-path impact planning", () => {
  it("returns an explained deterministic known-path plan with controls, safety, commands, and full CI once", () => {
    const input = base();
    const first = planChangedImpact(input);
    const second = planChangedImpact(input);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ advisory: true, full_required_ci_authoritative: true, family_ids: ["CF-TENANT"], structure_ids: ["CON-TENANT"], negative_control_ids: ["NC-TENANT"], always_run_test_ids: ["TEST-SAFETY"], full_required_ci: { command: "pnpm test", run_count: 1 } });
    expect(first.affected_meaning[0]?.meaning).toContain("never returns another tenant");
    expect(first.test_ids).toEqual(expect.arrayContaining(["TEST-TENANT", "TEST-SAFETY"]));
    expect(first.commands.filter((item) => item.purpose === "full-required-ci")).toHaveLength(1);
    expect(first.expansions).toEqual([]);
    expect(first.unknowns).toEqual([]);
  });

  it("expands missing, uncertain, corrupt, stale, structural, and absent-inventory mappings to the full lane", () => {
    const variants: ImpactPlannerInput[] = [];
    const unknown = base();
    unknown.changed_inputs = [{ id: "unknown", path: "src/new-area/file.ts", kind: "content" }];
    variants.push(unknown);
    const uncertain = base();
    uncertain.mappings.mappings[0]!.confidence = "uncertain";
    variants.push(uncertain);
    const corrupt = base();
    corrupt.mappings.mappings[0]!.structure_ids = ["CON-MISSING"];
    variants.push(corrupt);
    const stale = base();
    stale.mappings.product_revision = "old-revision";
    variants.push(stale);
    const structural = base();
    structural.changed_inputs = [{ id: "structural", path: "src/tenant/lookup.ts", kind: "structural" }];
    variants.push(structural);
    const absentInventory = base();
    absentInventory.inventory.tests = [];
    variants.push(absentInventory);
    for (const variant of variants) {
      const plan = planChangedImpact(variant);
      expect(plan.family_ids).toEqual(["CF-RETRY", "CF-TENANT"]);
      expect(plan.expansions.join(" ")).toMatch(/full applicable suite/);
      expect(plan.unknowns.length + plan.expansions.length).toBeGreaterThan(1);
    }
  });

  it("allows broader advice but never silently narrower and preserves paired controls", () => {
    const exact = planChangedImpact(base());
    const uncertainInput = base();
    uncertainInput.mappings.mappings[0]!.confidence = "unknown";
    const broad = planChangedImpact(uncertainInput);
    expect(exact.family_ids.every((id) => broad.family_ids.includes(id))).toBe(true);

    const missingControl = base();
    missingControl.inventory.tests[0]!.control_ids = [];
    const protectedPlan = planChangedImpact(missingControl);
    expect(protectedPlan.family_ids).toEqual(["CF-RETRY", "CF-TENANT"]);
    expect(protectedPlan.negative_control_ids).toEqual(["NC-RETRY", "NC-TENANT"]);
    expect(protectedPlan.unknowns).toContainEqual(expect.stringContaining("NC-TENANT"));
    expect(protectedPlan.always_run_test_ids).toEqual(["TEST-SAFETY"]);
  });

  it("returns hostile host commands as inert data and never executes them", () => {
    const marker = resolve("/tmp", `validation-architect-impact-must-not-execute-${process.pid}`);
    const input = base();
    input.inventory.tests[0]!.command = `touch ${marker}`;
    const plan = planChangedImpact(input);
    expect(plan.commands).toContainEqual(expect.objectContaining({ command: `touch ${marker}` }));
    expect(existsSync(marker)).toBe(false);
  });

  it("rejects or redacts secret-shaped commands and unsafe symbols", () => {
    const input = base();
    input.inventory.tests[0]!.command = "TOKEN=supersecret-value pnpm test";
    input.changed_inputs = [{ id: "symbol-change", symbol: "password=supersecret-value", kind: "content" }];
    const plan = planChangedImpact(input);
    expect(plan.family_ids).toEqual(["CF-RETRY", "CF-TENANT"]);
    expect(plan.changed_inputs[0]?.symbol).toBe("[REDACTED]");
    expect(JSON.stringify(plan)).not.toContain("supersecret-value");
    expect(() => planChangedImpact({ ...base(), full_ci_command: "TOKEN=supersecret-value pnpm test" })).toThrow(/secret-free/);
  });

  it("round-trips the exact revision/lane selections, expansions, and unknowns through validation-architect/result/v1", () => {
    const input = base();
    input.changed_inputs = [{ id: "unknown", path: "unknown/file.ts", kind: "content" }];
    const plan = planChangedImpact(input);
    const evidence = [{ id: "EV-PLAN", kind: "artifact" as const, reference: "artifacts/impact-plan.json", integrity: { algorithm: "sha256" as const, digest: "c".repeat(64) } }];
    const result = impactPlanToValidationResult(plan, { identity: { product_revision: "rev-1", lane: "per-commit", environment: "offline-linux", versions: input.model.versions }, structure_id: "CON-TENANT", root_id: "IMPACT-PLAN", owner: "OWN-TENANCY", evidence });
    expect(validateValidationResult(result)).toEqual([]);
    const roundTrip = parseValidationResult(canonicalValidationResult(result), "json");
    expect(roundTrip.plan).toEqual(plan.result_plan);
    expect(roundTrip.identity).toMatchObject({ product_revision: "rev-1", lane: "per-commit" });
    expect(roundTrip.extensions["validation-architect.impact"]).toEqual(plan);
  });
});

describe("offline zero-miss impact benchmark", () => {
  interface FixtureRecord { id: string; category: ImpactBenchmarkCategory; change: "tenant" | "retry" | "unknown" | "structural"; expected: string[]; independently_reviewed?: boolean }
  const records = JSON.parse(readFileSync(resolve(__dirname, "fixtures", "impact", "benchmark.json"), "utf8")) as FixtureRecord[];
  const changes: Record<FixtureRecord["change"], ChangedInput> = {
    tenant: { id: "tenant", path: "src/tenant/lookup.ts", kind: "content" },
    retry: { id: "retry", path: "src/retry/worker.ts", kind: "content" },
    unknown: { id: "unknown", path: "src/unmapped/file.ts", kind: "content" },
    structural: { id: "structural", path: "src/tenant/layout.ts", kind: "structural" },
  };
  const fixtures: ImpactBenchmarkCase[] = records.map((record) => ({
    id: record.id,
    category: record.category,
    input: { ...base(), changed_inputs: [changes[record.change]] },
    expected_family_ids: record.expected,
    ...(record.independently_reviewed !== undefined ? { independently_reviewed: record.independently_reviewed } : {}),
  }));

  it("proves zero misses across generated, historical, corruption-negative, and reviewed shadow facts", () => {
    const report = runImpactBenchmark(fixtures);
    expect(report.trustworthy_advice).toBe(true);
    expect(report.selection_recall).toBe(1);
    expect(report.missed_family_ids).toEqual([]);
    expect(report.categories_present).toEqual(["corruption-negative", "generated", "historical", "shadow"]);
    expect(report.cases.every((item) => item.full_ci_exactly_once)).toBe(true);
    expect(report.planning_latency_ms).toBeGreaterThanOrEqual(0);
    expect(report.full_ci_remains_authoritative).toBe(true);
  });

  it("reports misses and extras separately and refuses a trust label", () => {
    const faulty = structuredClone(fixtures);
    faulty[0]!.expected_family_ids.push("CF-RETRY");
    const report = runImpactBenchmark(faulty);
    expect(report.trustworthy_advice).toBe(false);
    expect(report.selection_recall).toBeLessThan(1);
    expect(report.missed_family_ids).toContain("CF-RETRY");
    expect(report.extra_selections).toBeGreaterThanOrEqual(0);
  });
});
