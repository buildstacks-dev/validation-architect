import type { CompiledDesignModel, TestInventory, ValidationEvidenceSet } from "../src/model.js";
import { CURRENT_CORE_VERSIONS } from "../src/versions.js";

const digest = (character: string): string => character.repeat(64);

export function graphFixture(): {
  model: CompiledDesignModel;
  inventory: TestInventory;
  evidence: ValidationEvidenceSet;
} {
  const model: CompiledDesignModel = {
    schema: "validation-architect/model/v1",
    product: { id: "product", name: "Graph fixture", revision: "rev-1", intended_use: "Offline graph tests", criticality: "C1", criticality_reason: "Synthetic data" },
    versions: { ...CURRENT_CORE_VERSIONS },
    owners: [{ id: "OWN-TENANCY", name: "Runtime team", responsibility: "Own tenant isolation and retry safety" }],
    sources: [
      { id: "SRC-TENANCY", kind: "doc", path: "docs/contracts.md", locator: "Tenant isolation" },
      { id: "SRC-RETRY", kind: "doc", path: "docs/retries.md", locator: "Retry contract" },
    ],
    structures: [
      { id: "CON-TENANT", kind: "contract", title: "Tenant boundary", meaning: "A lookup never returns another tenant's record", owner: "OWN-TENANCY", source_ids: ["SRC-TENANCY"], changed_paths: ["src/tenant/**"], acceptance_criteria: ["Foreign records are rejected"], failure_modes: ["Cross-tenant data is returned"] },
      { id: "INV-RETRY", kind: "invariant", title: "Retry safety", meaning: "A retry never applies the same mutation twice", owner: "OWN-TENANCY", source_ids: ["SRC-RETRY"], changed_paths: ["src/retry/**"], acceptance_criteria: ["Repeated delivery has one effect"], failure_modes: ["Mutation is duplicated"] },
    ],
    policy: {
      default: "blocking",
      inheritance: "tighten-only",
      layers: [
        { id: "L1", title: "Contract", status: "active" },
        { id: "L2", title: "Hermetic", status: "active" },
        { id: "L3", title: "Live", status: "declared-empty", reason: "No live target" },
        { id: "L4", title: "Eval", status: "declared-empty", reason: "No model" },
        { id: "L5", title: "Ops", status: "declared-empty", reason: "C1" },
        { id: "L6", title: "Outcome", status: "declared-empty", reason: "No human output" },
      ],
      lanes: [
        { id: "inner-loop", title: "Local", kind: "test", status: "active", requirement: "blocking", triggers: ["local"], command: "pnpm test -- tenant" },
        { id: "per-commit", title: "CI", kind: "test", status: "active", requirement: "blocking", triggers: ["commit"], command: "pnpm test" },
        { id: "triggered", title: "Triggered", kind: "evidence", status: "active", requirement: "blocking", triggers: ["change"] },
        { id: "release", title: "Release", kind: "evidence", status: "declared-empty", requirement: "blocking", triggers: [], reason: "No release lane" },
        { id: "scheduled", title: "Scheduled", kind: "evidence", status: "declared-empty", requirement: "blocking", triggers: [], reason: "No scheduled lane" },
      ],
      exceptions: [],
    },
    controls: [
      { id: "NC-TENANT", title: "Foreign row seed", family_id: "CF-TENANT", owner: "OWN-TENANCY", expected_failure: "Detector fails when a foreign row is returned" },
      { id: "NC-RETRY", title: "Double mutation seed", family_id: "CF-RETRY", owner: "OWN-TENANCY", expected_failure: "Detector fails when retry mutates twice" },
    ],
    families: [
      { id: "CF-TENANT", title: "Tenant detector", meaning: "Reject a foreign tenant row", structure_ids: ["CON-TENANT"], owner: "OWN-TENANCY", source_ids: ["SRC-TENANCY"], lane: "per-commit", status: "implementable", layer: "L2", oracle: "state", risk: "E1", control_ids: ["NC-TENANT"], ticket: "HB-TENANT", planned_tests: ["tests/tenant.test.ts"], exclusions: ["Live cloud tenancy"] },
      { id: "CF-RETRY", title: "Retry detector", meaning: "Prove one durable mutation after a retry", structure_ids: ["INV-RETRY"], owner: "OWN-TENANCY", source_ids: ["SRC-RETRY"], lane: "per-commit", status: "implementable", layer: "L1", oracle: "state", risk: "E1", control_ids: ["NC-RETRY"], ticket: "HB-RETRY", planned_tests: ["tests/retry.test.ts"], exclusions: ["Third-party delivery guarantees"] },
    ],
    tickets: [
      { id: "HB-TENANT", title: "Land tenant detector", wave: "0", status: "landed", owner: "OWN-TENANCY", executor: "coding agent", lane: "per-commit", layer: "L2", acceptance_criteria: ["Tenant detector and seed pass"], family_ids: ["CF-TENANT"] },
      { id: "HB-RETRY", title: "Land retry detector", wave: "0", status: "landed", owner: "OWN-TENANCY", executor: "coding agent", lane: "per-commit", layer: "L1", acceptance_criteria: ["Retry detector and seed pass"], family_ids: ["CF-RETRY"] },
    ],
  };
  const inventory: TestInventory = {
    kind: "test-inventory",
    revision: "rev-1",
    environment: "offline-linux",
    tests_root: "tests",
    tests_root_present: true,
    tests: [
      { id: "TEST-TENANT", path: "tests/tenant.test.ts", family_ids: ["CF-TENANT"], control_ids: ["NC-TENANT"], command: "pnpm test -- tenant" },
      { id: "TEST-RETRY", path: "tests/retry.test.ts", family_ids: ["CF-RETRY"], control_ids: ["NC-RETRY"], command: "pnpm test -- retry" },
      { id: "TEST-SAFETY", path: "tests/safety.test.ts", family_ids: ["CF-TENANT"], command: "pnpm test -- safety", always_run: true },
    ],
  };
  const evidence: ValidationEvidenceSet = {
    kind: "validation-evidence",
    revision: "rev-1",
    environment: "offline-linux",
    items: [
      { id: "EV-TENANT", family_ids: ["CF-TENANT"], state: "complete", path: "artifacts/tenant.json", integrity: digest("a") },
      { id: "EV-RETRY", family_ids: ["CF-RETRY"], state: "complete", path: "artifacts/retry.json", integrity: digest("b") },
    ],
  };
  return { model, inventory, evidence };
}
