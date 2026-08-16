/**
 * Loads validated repository facts through the read-only RepositoryPort. This
 * is the one composition every deterministic entry point shares: corpus files,
 * generated views, derived test inventory, and observed evidence. It performs
 * no filesystem, Git, network, or process effect of its own.
 */

import { createHash } from "node:crypto";
import { compileValidationModel, type ModelFileSet } from "../model-compiler.js";
import {
  MODEL_FILES,
  type CompiledDesignModel,
  type TestInventory,
  type ValidationEvidenceSet,
} from "../model.js";
import { GENERATED_MODEL_VIEWS } from "../model-views.js";
import {
  buildRelationshipGraph,
  type RelationshipGraph,
  type TraceFinding,
} from "../relationship-graph.js";
import { parseSpecSource, type SpecFileInfo } from "../trace.js";
import type { CompilerDiagnostic } from "../model.js";
import { invalidInput } from "./errors.js";
import type { RepositoryPort } from "./ports.js";
import { safeRepositoryPath } from "./validate.js";

export const DESIGN_ROOT = "validation-design";
export const SPEC_SUFFIXES = [".test.ts", ".test.tsx", ".test.js", ".test.mjs", ".spec.ts"] as const;

export interface RepositoryFactsOptions {
  /** Tests root relative to the repository root; defaults to "tests". */
  testsRoot?: string;
  /** Environment identity stamped into inventory and results. */
  environment?: string;
}

export interface CompiledRepositoryFacts {
  revision: string;
  accepted: boolean;
  model?: CompiledDesignModel;
  identity?: string;
  diagnostics: CompilerDiagnostic[];
  views: Record<string, string>;
  /** Raw corpus source files that were read, keyed by repository path. */
  modelFiles: Record<string, string>;
}

export interface RepositoryFacts extends CompiledRepositoryFacts {
  accepted: true;
  model: CompiledDesignModel;
  identity: string;
  inventory: TestInventory;
  evidence: ValidationEvidenceSet;
  graph: RelationshipGraph;
}

const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");
const testId = (path: string): string => `TEST-${sha256(path).slice(0, 16)}`;

type PlannedFamily = CompiledDesignModel["families"][number];

function plannedFamiliesByPath(model: CompiledDesignModel): Map<string, PlannedFamily[]> {
  const planned = new Map<string, PlannedFamily[]>();
  for (const family of [...model.families].sort((left, right) => left.id.localeCompare(right.id))) {
    for (const path of family.planned_tests ?? []) {
      const families = planned.get(path) ?? [];
      if (!families.some((candidate) => candidate.id === family.id)) families.push(family);
      planned.set(path, families);
    }
  }
  return planned;
}

function specConventionFindings(
  specs: readonly SpecFileInfo[],
  planned: ReadonlyMap<string, readonly PlannedFamily[]>,
): TraceFinding[] {
  const findings: TraceFinding[] = [];
  const add = (spec: SpecFileInfo, code: string, message: string, correction: string): void => {
    findings.push({ code, level: "red", subject_id: testId(spec.path), message, correction });
  };

  for (const spec of specs) {
    if (!spec.hasHeader) {
      add(spec, "SPEC_HEADER_MISSING", `${spec.path} does not begin with the required traceability header.`, "Add a first-comment traceability note; current family links remain authoritative in model/families.yaml planned_tests.");
    }
    if ((planned.get(spec.path) ?? []).length === 0) {
      add(spec, "ORPHAN_TEST", `${spec.path} is not named by any compiled family's planned_tests.`, "Add the exact path through the reviewed model workflow and recompile, or remove the unplanned spec from the configured test root.");
    }
    if (spec.tests === 0) {
      add(spec, "SPEC_CASE_MISSING", `${spec.path} contains no observed it/test call site.`, "Add an executable test case or remove the empty spec file.");
    }
  }
  return findings;
}

async function readSafe(repo: RepositoryPort, path: string): Promise<string | null> {
  if (!safeRepositoryPath(path)) throw invalidInput(`Repository path rejected: ${path}`, { path });
  return repo.readFile(path);
}

/** Compile the corpus over the port without joining tests or evidence. */
export async function compileFromRepository(
  repo: RepositoryPort,
  options: RepositoryFactsOptions = {},
): Promise<CompiledRepositoryFacts> {
  void options;
  const revision = await repo.revision();
  if (typeof revision !== "string" || revision.length === 0) {
    throw invalidInput("RepositoryPort.revision() must return the exact commit identity");
  }
  const files: Partial<ModelFileSet> = {};
  const modelFiles: Record<string, string> = {};
  for (const file of MODEL_FILES) {
    const path = `${DESIGN_ROOT}/model/${file}`;
    const content = await readSafe(repo, path);
    if (content !== null) {
      files[file] = content;
      modelFiles[path] = content;
    }
  }
  const existingViews: Partial<Record<string, string>> = {};
  for (const view of GENERATED_MODEL_VIEWS) {
    const content = await readSafe(repo, `${DESIGN_ROOT}/${view}`);
    if (content !== null) existingViews[view] = content;
  }
  const compiled = compileValidationModel(files, { existingViews, allowRegenerate: true });
  return {
    revision,
    accepted: compiled.accepted,
    ...(compiled.model ? { model: compiled.model } : {}),
    ...(compiled.identity ? { identity: compiled.identity } : {}),
    diagnostics: compiled.diagnostics,
    views: compiled.generated_views,
    modelFiles,
  };
}

/**
 * Full fact load: compiled corpus joined to the derived test inventory and
 * observed evidence, with the relationship graph built from injected facts
 * only. Mirrors the trace host adapter, but every read goes through the port.
 */
export async function loadRepositoryFacts(
  repo: RepositoryPort,
  options: RepositoryFactsOptions = {},
): Promise<{ facts?: RepositoryFacts; failure?: { revision: string; problems: string[] } }> {
  const compiled = await compileFromRepository(repo, options);
  if (!compiled.accepted || !compiled.model || !compiled.identity) {
    return {
      failure: {
        revision: compiled.revision,
        problems: compiled.diagnostics
          .filter((item) => item.severity === "error")
          .map(
            (item) =>
              `${item.location.file}:${item.location.line}:${item.location.column} ${item.message} Correction: ${item.correction}`,
          ),
      },
    };
  }
  const model = compiled.model;
  const testsRoot = options.testsRoot ?? "tests";
  if (!safeRepositoryPath(testsRoot)) throw invalidInput(`testsRoot rejected: ${testsRoot}`);
  const environment = options.environment ?? "repository-port";

  const listedTestPaths = await repo.listFiles([`${testsRoot}/**`]);
  const specPaths = listedTestPaths
    .filter((path) => SPEC_SUFFIXES.some((suffix) => path.endsWith(suffix)))
    .sort();
  const testsRootPresent = listedTestPaths.length > 0;
  const specSources = new Map<string, string>();
  for (const path of specPaths) {
    const content = await readSafe(repo, path);
    if (content !== null) specSources.set(path, content);
  }
  const specs = [...specSources.entries()].map(([path, source]) => parseSpecSource(path, source));
  const planned = plannedFamiliesByPath(model);
  const repositoryFindings = specConventionFindings(specs, planned);

  const lanes = new Map(model.policy.lanes.map((item) => [item.id, item]));
  const families = new Map(model.families.map((item) => [item.id, item]));
  const inventory: TestInventory = {
    kind: "test-inventory",
    revision: compiled.revision,
    environment,
    tests_root: testsRoot,
    tests_root_present: testsRootPresent,
    tests: specs.map((spec) => {
      const plannedFamilies = planned.get(spec.path) ?? [];
      const familyIds = plannedFamilies.map((family) => family.id);
      const controlIds = [...new Set(plannedFamilies.flatMap((family) => family.control_ids ?? []))].sort();
      const commands = [
        ...new Set(
          plannedFamilies
            .map((family) => lanes.get(family.lane)?.command)
            .filter((item): item is string => Boolean(item)),
        ),
      ];
      return {
        id: testId(spec.path),
        path: spec.path,
        family_ids: familyIds,
        ...(controlIds.length > 0 ? { control_ids: controlIds } : {}),
        ...(commands.length === 1 ? { command: commands[0] } : {}),
        case_count: spec.tests,
      };
    }),
  };

  const evidenceItems: ValidationEvidenceSet["items"] = [];
  for (const test of inventory.tests) {
    const content = specSources.get(test.path);
    if (content !== undefined) {
      evidenceItems.push({
        id: `STRUCT-${test.id}`,
        family_ids: test.family_ids.filter((id) => families.has(id)),
        state: "complete",
        path: test.path,
        integrity: sha256(content),
        scope: "structural",
      });
    }
  }
  for (const family of model.families) {
    if (!family.evidence) continue;
    const content = await readSafe(repo, family.evidence.path);
    if (content !== null) {
      evidenceItems.push({
        id: `EVIDENCE-${family.id}`,
        family_ids: [family.id],
        state: family.evidence.state,
        path: family.evidence.path,
        integrity: sha256(content),
        scope: "run",
      });
    }
  }
  const evidence: ValidationEvidenceSet = {
    kind: "validation-evidence",
    revision: compiled.revision,
    environment,
    items: evidenceItems,
  };

  const observedCandidates = [
    ...model.sources.map((item) => item.path),
    ...evidenceItems.map((item) => item.path),
  ].filter((item): item is string => Boolean(item));
  const observedPaths: string[] = [];
  for (const path of [...new Set(observedCandidates)]) {
    if (evidenceItems.some((item) => item.path === path) || (await readSafe(repo, path)) !== null) {
      observedPaths.push(path);
    }
  }

  const graph = buildRelationshipGraph({
    model,
    model_identity: compiled.identity,
    projection_identity: compiled.identity,
    repository_revision: compiled.revision,
    repository_findings: repositoryFindings,
    inventory,
    evidence,
    observed_paths: observedPaths,
  });

  return {
    facts: {
      ...compiled,
      accepted: true,
      model,
      identity: compiled.identity,
      inventory,
      evidence,
      graph,
    },
  };
}
