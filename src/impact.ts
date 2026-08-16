import type { CompiledDesignModel, TestInventory } from "./model.js";
import { relationshipPayloadIdentity, type RelationshipGraph } from "./relationship-graph.js";
import type { ResultPlan } from "./validation-result.js";
import { containsSecretPattern } from "./secret-safety.js";

export const IMPACT_MAPPING_SCHEMA = "validation-architect/impact-mapping/v1";
export const IMPACT_PLAN_SCHEMA = "validation-architect/plan/v1";

export interface ChangedInput {
  id: string;
  path?: string;
  symbol?: string;
  kind: "content" | "structural";
}

export interface ImpactMapping {
  id: string;
  path_pattern?: string;
  symbol?: string;
  structure_ids: string[];
  confidence: "exact" | "uncertain" | "unknown";
}

export interface ImpactMappingSet {
  schema: typeof IMPACT_MAPPING_SCHEMA;
  identity: string;
  product_revision: string;
  mappings: ImpactMapping[];
}

export interface ImpactCommand {
  id: string;
  command: string;
  purpose: "selected-test" | "always-run" | "full-required-ci";
}

export interface ExplainedImpactPlan {
  schema: typeof IMPACT_PLAN_SCHEMA;
  identity: {
    model_identity: string;
    graph_identity: string;
    inventory_identity: string;
    mapping_identity: string;
    product_revision: string;
    lane: string;
    versions: CompiledDesignModel["versions"];
  };
  advisory: true;
  full_required_ci_authoritative: true;
  changed_inputs: ChangedInput[];
  affected_meaning: Array<{ structure_id: string; meaning: string }>;
  structure_ids: string[];
  family_ids: string[];
  test_ids: string[];
  negative_control_ids: string[];
  always_run_test_ids: string[];
  expansions: string[];
  unknowns: string[];
  commands: ImpactCommand[];
  full_required_ci: { command: string; run_count: 1 };
  result_plan: ResultPlan;
}

export interface ImpactPlannerInput {
  model: CompiledDesignModel;
  graph: RelationshipGraph;
  inventory: TestInventory;
  mappings: ImpactMappingSet;
  changed_inputs: ChangedInput[];
  lane: string;
  full_ci_command: string;
}

function safe(value: string): boolean {
  return value.length > 0 && !value.includes("\0") && !containsSecretPattern(value) && !value.replaceAll("\\", "/").split("/").includes("..") && !value.startsWith("/");
}

const safeSymbol = (value: string): boolean => /^[A-Za-z0-9_.:#/-]{1,256}$/.test(value) && !containsSecretPattern(value);
const safeCommand = (value: string | undefined): value is string => Boolean(value && !value.includes("\0") && !containsSecretPattern(value));

function glob(pattern: string, path: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", "\0").replaceAll("*", "[^/]*").replaceAll("\0", ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

const unique = (values: readonly string[]): string[] => [...new Set(values)].sort();

export function planChangedImpact(input: ImpactPlannerInput): ExplainedImpactPlan {
  if (!safeCommand(input.full_ci_command)) throw new Error("full_ci_command must be non-empty, secret-free adapter data");
  const structures = new Map(input.model.structures.map((item) => [item.id, item]));
  const applicableFamilies = input.model.families.filter((item) => item.status === "implementable" && item.lane === input.lane);
  const applicableIds = applicableFamilies.map((item) => item.id).sort();
  const selectedStructures = new Set<string>();
  const expansions: string[] = [];
  const unknowns: string[] = [];
  let widen = false;
  const changedIds = new Set<string>();
  const checkedRevision = input.graph.identity.product_revision;

  if (input.mappings.schema !== IMPACT_MAPPING_SCHEMA || input.mappings.product_revision !== checkedRevision) {
    widen = true;
    unknowns.push("Mapping schema or product revision is stale/unknown.");
  }
  if (input.inventory.revision !== checkedRevision || input.model.product.revision !== checkedRevision) {
    widen = true;
    unknowns.push("Model or inventory identity is stale relative to the checked repository revision.");
  }
  if (relationshipPayloadIdentity(input.inventory) !== input.graph.identity.inventory_identity) {
    widen = true;
    unknowns.push("Inventory content does not match the exact graph identity.");
  }
  const seenMappings = new Set<string>();
  for (const mapping of input.mappings.mappings) {
    if (!mapping.id || seenMappings.has(mapping.id) || (!mapping.path_pattern && !mapping.symbol)
      || (mapping.path_pattern !== undefined && !safe(mapping.path_pattern))
      || (mapping.symbol !== undefined && !safeSymbol(mapping.symbol))
      || mapping.structure_ids.some((id) => !structures.has(id))) {
      widen = true;
      unknowns.push(`Mapping ${mapping.id || "(missing id)"} is duplicate, unsafe, incomplete, or corrupt.`);
    }
    seenMappings.add(mapping.id);
  }
  if (input.changed_inputs.length === 0) {
    widen = true;
    unknowns.push("No changed inputs were supplied.");
  }

  for (const changed of input.changed_inputs) {
    if (!changed.id || changedIds.has(changed.id) || (changed.path && !safe(changed.path)) || (changed.symbol && !safeSymbol(changed.symbol)) || (!changed.path && !changed.symbol)) {
      widen = true;
      unknowns.push(`${containsSecretPattern(changed.id) ? "[REDACTED]" : changed.id || "(missing id)"} is duplicate or missing a safe path/symbol mapping input.`);
      continue;
    }
    changedIds.add(changed.id);
    if (changed.kind === "structural") {
      widen = true;
      expansions.push(`${changed.id} is structural; expanded to the full applicable suite.`);
    }
    const matching = input.mappings.mappings.filter((mapping) =>
      (changed.path && mapping.path_pattern && safe(mapping.path_pattern) && glob(mapping.path_pattern, changed.path))
      || (changed.symbol && mapping.symbol === changed.symbol),
    );
    const declared = changed.path
      ? input.model.structures.filter((structure) => (structure.changed_paths ?? []).some((pattern) => glob(pattern, changed.path as string)))
      : [];
    if (matching.length === 0 && declared.length === 0) {
      widen = true;
      unknowns.push(`${changed.id} has no declared path/symbol relationship.`);
    }
    if (matching.length > 1 && unique(matching.flatMap((item) => item.structure_ids)).length > 1) {
      widen = true;
      unknowns.push(`${changed.id} has ambiguous overlapping mappings.`);
    }
    for (const mapping of matching) {
      if (mapping.confidence !== "exact" || mapping.structure_ids.length === 0) {
        widen = true;
        unknowns.push(`${mapping.id} is ${mapping.confidence} or empty.`);
      }
      for (const structureId of mapping.structure_ids) {
        if (!structures.has(structureId)) {
          widen = true;
          unknowns.push(`${mapping.id} cites unknown structure ${structureId}.`);
        } else selectedStructures.add(structureId);
      }
    }
    for (const structure of declared) selectedStructures.add(structure.id);
  }

  let familyIds = unique(applicableFamilies.filter((family) => family.structure_ids.some((id) => selectedStructures.has(id))).map((item) => item.id));
  for (const structureId of selectedStructures) {
    if (!applicableFamilies.some((family) => family.structure_ids.includes(structureId))) {
      widen = true;
      unknowns.push(`${structureId} has no applicable family in lane ${input.lane}.`);
    }
  }
  const inventoryFamilyIds = new Set(input.inventory.tests.flatMap((item) => item.family_ids));
  if (familyIds.some((id) => !inventoryFamilyIds.has(id))) {
    widen = true;
    unknowns.push("At least one affected family has no inventory implementation.");
  }
  if (input.graph.findings.some((item) => item.level !== "partial")) {
    widen = true;
    unknowns.push("Relationship graph contains unresolved or red closure findings.");
  }
  if (widen) {
    familyIds = applicableIds;
    expansions.push("Fail-safe expansion selected the full applicable suite; advice was broadened, never narrowed.");
  }

  let controlIds = unique(input.model.families.filter((item) => familyIds.includes(item.id)).flatMap((item) => item.control_ids ?? []));
  let controlTests = input.inventory.tests.filter((test) => (test.control_ids ?? []).some((id) => controlIds.includes(id)));
  for (const controlId of controlIds) {
    if (!controlTests.some((test) => test.control_ids?.includes(controlId))) {
      unknowns.push(`Negative control ${controlId} has no inventory implementation; full-suite expansion remains in force.`);
      if (!widen) {
        widen = true;
        familyIds = applicableIds;
        expansions.push("Missing paired negative-control implementation expanded to the full applicable suite.");
      }
    }
  }
  controlIds = unique(input.model.families.filter((item) => familyIds.includes(item.id)).flatMap((item) => item.control_ids ?? []));
  controlTests = input.inventory.tests.filter((test) => (test.control_ids ?? []).some((id) => controlIds.includes(id)));
  let selectedTests = input.inventory.tests.filter((test) => test.family_ids.some((id) => familyIds.includes(id)));
  const alwaysRun = input.inventory.tests.filter((test) => test.always_run === true);
  let commandInputs = [...selectedTests, ...controlTests, ...alwaysRun];
  if (commandInputs.some((item) => !safeCommand(item.command)) && !widen) {
    widen = true;
    familyIds = applicableIds;
    expansions.push("Missing exact host command expanded to the full applicable suite.");
    controlIds = unique(input.model.families.filter((item) => familyIds.includes(item.id)).flatMap((item) => item.control_ids ?? []));
    controlTests = input.inventory.tests.filter((test) => (test.control_ids ?? []).some((id) => controlIds.includes(id)));
    selectedTests = input.inventory.tests.filter((test) => test.family_ids.some((id) => familyIds.includes(id)));
    commandInputs = [...selectedTests, ...controlTests, ...alwaysRun];
  }
  const allTests = unique(commandInputs.map((item) => item.id));
  for (const test of commandInputs) if (!safeCommand(test.command)) unknowns.push(`Exact secret-free command for ${test.id} was not supplied by the host.`);
  const commands: ImpactCommand[] = unique(commandInputs.filter((item) => safeCommand(item.command)).map((item) => `${item.id}\0${item.command}\0${item.always_run ? "always-run" : "selected-test"}`)).map((entry) => {
    const [id, command, purpose] = entry.split("\0") as [string, string, "always-run" | "selected-test"];
    return { id, command, purpose };
  });
  commands.push({ id: "full-required-ci", command: input.full_ci_command, purpose: "full-required-ci" });

  const structureIds = widen
    ? unique(input.model.families.filter((item) => familyIds.includes(item.id)).flatMap((item) => item.structure_ids))
    : [...selectedStructures].sort();
  const resultPlan = {
    selected_scope: familyIds,
    expansions: unique(expansions),
    unresolved_mappings: unique(unknowns),
  };
  return {
    schema: IMPACT_PLAN_SCHEMA,
    identity: { model_identity: input.graph.identity.model_identity, graph_identity: input.graph.identity.graph_identity, inventory_identity: input.graph.identity.inventory_identity, mapping_identity: input.mappings.identity, product_revision: checkedRevision, lane: input.lane, versions: structuredClone(input.model.versions) },
    advisory: true,
    full_required_ci_authoritative: true,
    changed_inputs: input.changed_inputs.map((item) => ({ ...item, ...(item.path && !safe(item.path) ? { path: "[REDACTED]" } : {}), ...(item.symbol && !safeSymbol(item.symbol) ? { symbol: "[REDACTED]" } : {}), ...(containsSecretPattern(item.id) ? { id: "[REDACTED]" } : {}) })).sort((a, b) => a.id.localeCompare(b.id)),
    affected_meaning: structureIds.map((id) => ({ structure_id: id, meaning: structures.get(id)?.meaning ?? "unresolved structure" })),
    structure_ids: structureIds,
    family_ids: familyIds,
    test_ids: allTests,
    negative_control_ids: controlIds,
    always_run_test_ids: alwaysRun.map((item) => item.id).sort(),
    expansions: resultPlan.expansions,
    unknowns: resultPlan.unresolved_mappings,
    commands,
    full_required_ci: { command: input.full_ci_command, run_count: 1 },
    result_plan: resultPlan,
  };
}
