import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { compileValidationModel } from "./model-compiler.js";
import { GENERATED_MODEL_VIEWS } from "./model-views.js";
import { MODEL_FILES, type CompiledDesignModel, type ModelFileSet, type TestInventory, type ValidationEvidenceSet } from "./model.js";
import { buildRelationshipGraph, type RelationshipGraph } from "./relationship-graph.js";
import { scanSpecs } from "./trace.js";

export interface ModelTraceOptions {
  modelPath?: string;
  testsRoot?: string;
  environment?: string;
}

export interface ModelTraceResult {
  ok: boolean;
  reds: string[];
  report: string;
  graph?: RelationshipGraph;
  model?: CompiledDesignModel;
  inventory?: TestInventory;
}

const SPEC_SUFFIXES = [".test.ts", ".test.tsx", ".test.js", ".test.mjs", ".spec.ts"];

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fail(messages: string[]): ModelTraceResult {
  return { ok: false, reds: messages, report: `# Validation Trace\n\nFAILED before graph construction:\n\n${messages.map((item) => `- ${item}`).join("\n")}\n` };
}

/**
 * CLI host adapter for the checked model. Repository reads and the legacy
 * header-token scan stay here; the graph itself accepts injected facts only.
 */
export function runModelTrace(targetRoot: string, options: ModelTraceOptions = {}): ModelTraceResult {
  const root = resolve(targetRoot);
  const modelRoot = options.modelPath
    ? (options.modelPath.startsWith("/") ? options.modelPath : resolve(root, options.modelPath))
    : join(root, "validation-design", "model");
  const files: Partial<ModelFileSet> = {};
  for (const file of MODEL_FILES) if (existsSync(join(modelRoot, file))) files[file] = readFileSync(join(modelRoot, file), "utf8");
  const designRoot = dirname(modelRoot);
  const existingViews: Partial<Record<string, string>> = {};
  for (const file of GENERATED_MODEL_VIEWS) if (existsSync(join(designRoot, file))) existingViews[file] = readFileSync(join(designRoot, file), "utf8");
  const compiled = compileValidationModel(files, { existingViews, allowRegenerate: false });
  if (!compiled.accepted || !compiled.model || !compiled.identity) {
    return fail(compiled.diagnostics.filter((item) => item.severity === "error").map((item) => `${item.location.file}:${item.location.line}:${item.location.column} ${item.message} Correction: ${item.correction}`));
  }

  const testsRoot = options.testsRoot ?? "tests";
  const testsPresent = existsSync(join(root, testsRoot));
  const specs = testsPresent ? scanSpecs(root, testsRoot, SPEC_SUFFIXES) : [];
  const lanes = new Map(compiled.model.policy.lanes.map((item) => [item.id, item]));
  const families = new Map(compiled.model.families.map((item) => [item.id, item]));
  const inventory: TestInventory = {
    kind: "test-inventory",
    revision: compiled.model.product.revision,
    environment: options.environment ?? "trace-host",
    tests_root: testsRoot,
    tests_root_present: testsPresent,
    tests: specs.map((spec) => {
      const familyIds = spec.citations.filter((id) => families.has(id));
      const commands = [...new Set(familyIds.map((id) => lanes.get(families.get(id)?.lane ?? "")?.command).filter((item): item is string => Boolean(item)))];
      // Control links follow the checked model, never spec prose: a citing
      // test implements the controls its cited families declare (VA-ENF-002).
      const controlIds = [...new Set(familyIds.flatMap((id) => families.get(id)?.control_ids ?? []))].sort();
      return {
        id: `TEST-${createHash("sha256").update(spec.path).digest("hex").slice(0, 16)}`,
        path: spec.path,
        family_ids: spec.citations,
        ...(controlIds.length > 0 ? { control_ids: controlIds } : {}),
        ...(commands.length === 1 ? { command: commands[0] } : {}),
        case_count: spec.tests,
      };
    }),
  };
  const evidenceItems: ValidationEvidenceSet["items"] = [];
  for (const test of inventory.tests) {
    const path = join(root, test.path);
    if (existsSync(path)) evidenceItems.push({ id: `STRUCT-${test.id}`, family_ids: test.family_ids.filter((id) => families.has(id)), state: "complete", path: test.path, integrity: sha256(path), scope: "structural" });
  }
  for (const family of compiled.model.families) {
    if (!family.evidence) continue;
    const path = join(root, family.evidence.path);
    if (existsSync(path)) evidenceItems.push({ id: `EVIDENCE-${family.id}`, family_ids: [family.id], state: family.evidence.state, path: family.evidence.path, integrity: sha256(path), scope: "run" });
  }
  const evidence: ValidationEvidenceSet = { kind: "validation-evidence", revision: compiled.model.product.revision, environment: inventory.environment, items: evidenceItems };
  const observedPaths = [...compiled.model.sources.map((item) => item.path), ...evidenceItems.map((item) => item.path)].filter((item): item is string => Boolean(item && existsSync(join(root, item))));
  const graph = buildRelationshipGraph({ model: compiled.model, model_identity: compiled.identity, projection_identity: compiled.identity, inventory, evidence, observed_paths: observedPaths });
  const reds = graph.findings.filter((item) => item.level !== "partial").map((item) => `${item.code}: ${item.message}`);
  const familiesRows = compiled.model.families.map((family) => {
    const tests = inventory.tests.filter((item) => item.family_ids.includes(family.id)).map((item) => item.path);
    const artifacts = evidence.items.filter((item) => item.family_ids.includes(family.id)).map((item) => `${item.state}:${item.path}`);
    return `| ${family.meaning} | \`${family.id}\` | ${tests.map((item) => `\`${item}\``).join(", ") || "unresolved"} | ${artifacts.map((item) => `\`${item}\``).join(", ") || "unresolved"} |`;
  });
  const partials = graph.findings.filter((item) => item.level === "partial");
  const report = `# Validation Trace\n\nDeterministic structural closure from checked model \`${compiled.identity}\`. This proves relationships and artifact existence, not oracle fidelity or product behavior.\n\n- Required check: **${graph.check.name}**\n- Structural closure: **${graph.structurally_closed ? "green" : "RED"}**\n- Graph: \`${graph.identity.graph_identity}\`\n- Runtime identity: revision \`${graph.identity.product_revision}\`, environment \`${graph.identity.environment}\`\n\n| Protected meaning | Family | Tests | Evidence |\n| --- | --- | --- | --- |\n${familiesRows.join("\n")}\n${reds.length > 0 ? `\n## Red findings\n\n${reds.map((item) => `- ${item}`).join("\n")}\n` : ""}${partials.length > 0 ? `\n## Partial run evidence\n\n${partials.map((item) => `- ${item.message}`).join("\n")}\n` : ""}`;
  return { ok: graph.structurally_closed, reds, report, graph, model: compiled.model, inventory };
}
