import { isAbsolute } from "node:path";
import type {
  CompiledDesignModel,
  DesignInventoryJoin,
  InventoryDiagnostic,
  TestInventory,
} from "./model.js";
import { MODEL_SCHEMA } from "./versions.js";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function assertSeparateDomains(model: CompiledDesignModel, value: unknown): void {
  if (value === model || (record(value) && value.schema === MODEL_SCHEMA)) {
    throw new Error("design authority cannot impersonate inventory or evidence");
  }
  if (!record(value) || !["test-inventory", "validation-evidence"].includes(String(value.kind))) {
    throw new Error("repository facts require an explicit test-inventory or validation-evidence kind");
  }
}

function safePath(path: string): boolean {
  const parts = path.replaceAll("\\", "/").split("/");
  return path.length > 0 && !isAbsolute(path) && !path.includes("\0") && !parts.includes("..");
}

function problem(
  diagnostics: InventoryDiagnostic[],
  value: Omit<InventoryDiagnostic, "correction"> & { correction: string },
): void {
  diagnostics.push(value);
}

/**
 * Join adapter-observed tests to design families without promoting repository
 * observations into design authority. Invalid inventory yields no accepted
 * relationship set and never mutates the compiled model.
 */
export function joinTestInventory(
  model: CompiledDesignModel,
  inventory: TestInventory,
): DesignInventoryJoin {
  const diagnostics: InventoryDiagnostic[] = [];
  if (inventory.kind !== "test-inventory") {
    problem(diagnostics, {
      code: "INVENTORY_KIND_INVALID",
      message: `Expected test-inventory, received ${String(inventory.kind)}.`,
      correction: "Have the repository adapter emit an explicit test-inventory value.",
    });
  }
  if (inventory.revision !== model.product.revision) {
    problem(diagnostics, {
      code: "INVENTORY_REVISION_MISMATCH",
      message: `Inventory revision ${inventory.revision} does not match design revision ${model.product.revision}.`,
      correction: "Read tests from the exact product revision recorded by the design model.",
    });
  }

  const families = new Set(model.families.map((family) => family.id));
  const controls = new Map(model.controls.map((control) => [control.id, control]));
  const seenTests = new Set<string>();
  const linked = new Map<string, Array<{ id: string; path: string }>>();
  for (const test of inventory.tests) {
    if (!test.id || !test.path || test.family_ids.length === 0 || test.case_count === 0) {
      problem(diagnostics, {
        code: "INVENTORY_ENTRY_INVALID",
        test_id: test.id,
        message: `Inventory test ${test.id || "(missing id)"} lacks an id, path, family link, or executable case.`,
        correction: "Emit a stable test id, repository-relative path, at least one family id, and a non-zero observed case count.",
      });
      continue;
    }
    if (seenTests.has(test.id)) {
      problem(diagnostics, {
        code: "INVENTORY_ID_DUPLICATE",
        test_id: test.id,
        message: `Inventory test id ${test.id} is duplicated.`,
        correction: "Give each observed test one stable identity.",
      });
    }
    seenTests.add(test.id);
    if (!safePath(test.path)) {
      problem(diagnostics, {
        code: "INVENTORY_PATH_UNSAFE",
        test_id: test.id,
        message: `Inventory test ${test.id} has unsafe path ${test.path}.`,
        correction: "Emit a bounded repository-relative test path with no traversal.",
      });
    }
    for (const familyId of test.family_ids) {
      if (!families.has(familyId)) {
        problem(diagnostics, {
          code: "INVENTORY_FAMILY_UNKNOWN",
          test_id: test.id,
          family_id: familyId,
          message: `Inventory test ${test.id} cites unknown family ${familyId}.`,
          correction: "Correct the adapter mapping or add the family through the reviewed design workflow.",
        });
        continue;
      }
      const entries = linked.get(familyId) ?? [];
      entries.push({ id: test.id, path: test.path });
      linked.set(familyId, entries);
    }
    for (const controlId of test.control_ids ?? []) {
      const control = controls.get(controlId);
      if (!control) {
        problem(diagnostics, {
          code: "INVENTORY_CONTROL_UNKNOWN",
          test_id: test.id,
          message: `Inventory test ${test.id} cites unknown negative control ${controlId}.`,
          correction: "Correct the adapter mapping or add the control through the reviewed design workflow.",
        });
      } else if (!test.family_ids.includes(control.family_id)) {
        problem(diagnostics, {
          code: "INVENTORY_CONTROL_FAMILY_MISMATCH",
          test_id: test.id,
          family_id: control.family_id,
          message: `Inventory test ${test.id} implements ${controlId} but not its family ${control.family_id}.`,
          correction: "Map a negative-control test to both the control and its owning family.",
        });
      }
    }
  }

  const links = [...linked.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([family_id, tests]) => ({
      family_id,
      test_ids: [...new Set(tests.map((test) => test.id))].sort(),
      test_paths: [...new Set(tests.map((test) => test.path))].sort(),
    }));
  const implemented = new Set(links.map((link) => link.family_id));
  return {
    accepted: diagnostics.length === 0,
    revision: inventory.revision,
    diagnostics,
    links,
    unimplemented_family_ids: model.families
      .filter((family) => family.status === "implementable" && !implemented.has(family.id))
      .map((family) => family.id)
      .sort(),
  };
}
