import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { MODEL_FILE_SCHEMAS } from "../src/model.js";
import { CURRENT_CORE_VERSIONS } from "../src/versions.js";
import { compileWorkspaceModel } from "../src/workspace-compiler.js";

/**
 * The smallest authoritative model that compiles clean: one owner, one source,
 * one contract, one implementable family with its negative control, and a
 * policy that declares all six layers and all five lanes. Shared by the
 * orchestrator tests and the CLI acceptance tests so both exercise the same
 * corpus shape the compiler actually accepts.
 */
export function writeValidModel(root: string): void {
  const model = join(root, "validation-design", "model");
  mkdirSync(model, { recursive: true });
  const write = (name: string, value: unknown) =>
    writeFileSync(join(model, name), stringify(value, { lineWidth: 0 }));

  write("project.yaml", {
    schema: MODEL_FILE_SCHEMAS["project.yaml"],
    product: {
      id: "fixture-x",
      name: "Fixture X",
      revision: "abc123",
      intended_use: "Offline orchestrator fixture",
      criticality: "C1",
      criticality_reason: "Synthetic local data with bounded consequences",
    },
    versions: CURRENT_CORE_VERSIONS,
  });
  write("owners.yaml", {
    schema: MODEL_FILE_SCHEMAS["owners.yaml"],
    owners: [{ id: "OWN-1", name: "Runtime", responsibility: "Own the validation contract" }],
  });
  write("sources.yaml", {
    schema: MODEL_FILE_SCHEMAS["sources.yaml"],
    sources: [{ id: "SRC-1", kind: "doc", path: "docs/PRODUCT.md", locator: "Contract" }],
  });
  write("structures.yaml", {
    schema: MODEL_FILE_SCHEMAS["structures.yaml"],
    structures: [
      {
        id: "CON-1",
        kind: "contract",
        title: "Fixture contract",
        meaning: "The fixture response remains stable",
        owner: "OWN-1",
        source_ids: ["SRC-1"],
        acceptance_criteria: ["The same controlled request returns the same response without mutation"],
        changed_paths: ["src/**"],
      },
    ],
  });
  write("policy.yaml", {
    schema: MODEL_FILE_SCHEMAS["policy.yaml"],
    default: "blocking",
    inheritance: "tighten-only",
    layers: [
      { id: "L1", title: "Invariant and contract", status: "declared-empty", reason: "Focused L2 fixture" },
      { id: "L2", title: "Hermetic system", status: "active" },
      { id: "L3", title: "Live sandbox", status: "declared-empty", reason: "No live target" },
      { id: "L4", title: "Eval qualification", status: "declared-empty", reason: "No model site" },
      { id: "L5", title: "Ops hardening", status: "declared-empty", reason: "C1 fixture" },
      { id: "L6", title: "Outcome acceptance", status: "declared-empty", reason: "No judged output" },
    ],
    lanes: [
      { id: "inner-loop", title: "Fast local", kind: "test", status: "active", requirement: "blocking", triggers: ["before-push"], command: "pnpm test -- fixture" },
      { id: "per-commit", title: "Hermetic", kind: "test", status: "active", requirement: "blocking", triggers: ["per-commit"], command: "pnpm test" },
      { id: "triggered", title: "Triggered", kind: "evidence", status: "declared-empty", requirement: "blocking", triggers: [], reason: "No triggered work" },
      { id: "release", title: "Release", kind: "evidence", status: "declared-empty", requirement: "blocking", triggers: [], reason: "No release work" },
      { id: "scheduled", title: "Scheduled", kind: "evidence", status: "declared-empty", requirement: "blocking", triggers: [], reason: "No scheduled work" },
    ],
    exceptions: [],
  });
  write("controls.yaml", {
    schema: MODEL_FILE_SCHEMAS["controls.yaml"],
    controls: [
      {
        id: "NC-X01",
        title: "Fixture mutation",
        family_id: "CF-X01-S",
        owner: "OWN-1",
        expected_failure: "The detector turns red when the stable response changes",
      },
    ],
  });
  write("families.yaml", {
    schema: MODEL_FILE_SCHEMAS["families.yaml"],
    families: [
      {
        id: "CF-X01-S",
        title: "Fixture happy path",
        meaning: "The stable response is preserved",
        structure_ids: ["CON-1"],
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
  write("backlog.yaml", {
    schema: MODEL_FILE_SCHEMAS["backlog.yaml"],
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

  const compilation = compileWorkspaceModel(root, { regenerate: true });
  if (!compilation.accepted) {
    throw new Error(`test corpus did not compile: ${JSON.stringify(compilation.diagnostics)}`);
  }
}
