import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { parseDocument, stringify } from "yaml";
import {
  MODEL_FILES,
  MODEL_FILE_SCHEMAS,
  type BacklogTicket,
  type CoexistencePolicy,
  type CompiledDesignModel,
  type CompiledModelBundle,
  type CompilerDiagnostic,
  type ModelFileSet,
  type ModelFilename,
  type ModelOwner,
  type ModelSource,
  type NegativeControl,
  type PolicyException,
  type ProductIdentity,
  type ProductStructure,
  type ValidationFamily,
  type ValidationLayer,
  type ValidationLane,
  type ValidationPolicy,
} from "./model.js";
import { GENERATED_MODEL_VIEWS, generateModelViews } from "./model-views.js";
import { validateModel } from "./model-validation.js";
import { CURRENT_CORE_VERSIONS, MODEL_SCHEMA, type CoreVersionBundle } from "./versions.js";

type Row = Record<string, unknown>;
type ParsedFiles = Record<ModelFilename, Row>;
export interface CompileModelOptions {
  existingViews?: Partial<Record<string, string>>;
  allowRegenerate?: boolean;
}
const record = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (row: Row, key: string): string | undefined =>
  typeof row[key] === "string" && row[key] !== "" ? (row[key] as string) : undefined;
const texts = (row: Row, key: string): string[] | undefined =>
  Array.isArray(row[key]) && (row[key] as unknown[]).every((item) => typeof item === "string")
    ? (row[key] as string[])
    : undefined;

function scalarLocation(file: string, source: string, value?: string, occurrence = 0): CompilerDiagnostic["location"] {
  if (!value) return { file: `validation-design/model/${file}`, line: 1, column: 1 };
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const expression = new RegExp(String.raw`^\s*-?\s*id\s*:\s*["']?${escaped}["']?\s*(?:#.*)?$`, "gm");
  const matches = [...source.matchAll(expression)];
  const match = matches[occurrence] ?? matches[0];
  if (match?.index === undefined) return { file: `validation-design/model/${file}`, line: 1, column: 1 };
  const before = source.slice(0, match.index);
  const line = before.split("\n").length;
  const lineStart = source.lastIndexOf("\n", match.index) + 1;
  const idColumn = source.slice(lineStart, match.index + match[0].length).indexOf(value);
  return { file: `validation-design/model/${file}`, line, column: Math.max(1, idColumn + 1) };
}

function safePath(path: string): boolean {
  const parts = path.replaceAll("\\", "/").split("/");
  return path.length > 0 && !isAbsolute(path) && !path.includes("\0") && !parts.includes("..");
}

function stable<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.id.localeCompare(b.id));
}

function parseFiles(
  files: Partial<Record<ModelFilename, string>>,
  diagnostics: CompilerDiagnostic[],
): ParsedFiles | undefined {
  const parsed = {} as ParsedFiles;
  for (const file of MODEL_FILES) {
    const source = files[file];
    if (source === undefined) {
      diagnostics.push({
        code: "MODEL_FILE_MISSING",
        severity: "error",
        concept: file,
        location: { file: `validation-design/model/${file}`, line: 1, column: 1 },
        message: `Required logical model file ${file} is missing.`,
        correction: `Create validation-design/model/${file} using schema ${MODEL_FILE_SCHEMAS[file]}.`,
      });
      continue;
    }
    const document = parseDocument(source, { prettyErrors: false });
    if (document.errors.length > 0) {
      const error = document.errors[0] as Error & { linePos?: Array<{ line: number; col: number }> };
      diagnostics.push({
        code: "MODEL_YAML_INVALID",
        severity: "error",
        concept: file,
        location: {
          file: `validation-design/model/${file}`,
          line: error.linePos?.[0]?.line ?? 1,
          column: error.linePos?.[0]?.col ?? 1,
        },
        message: `YAML could not be parsed: ${error.message}`,
        correction: "Fix the YAML syntax before compiling any generated view.",
      });
      continue;
    }
    let value: unknown;
    try {
      value = document.toJS({ maxAliasCount: 0 });
    } catch (error) {
      diagnostics.push({
        code: "MODEL_YAML_UNSAFE",
        severity: "error",
        concept: file,
        location: { file: `validation-design/model/${file}`, line: 1, column: 1 },
        message: `YAML aliases or expansion are not accepted: ${(error as Error).message}`,
        correction: "Replace aliases with explicit bounded values.",
      });
      continue;
    }
    if (!record(value)) {
      diagnostics.push({
        code: "MODEL_ROOT_INVALID",
        severity: "error",
        concept: file,
        location: { file: `validation-design/model/${file}`, line: 1, column: 1 },
        message: "Logical model files must contain a YAML mapping.",
        correction: `Make schema: ${MODEL_FILE_SCHEMAS[file]} the first mapping field.`,
      });
      continue;
    }
    if (value.schema !== MODEL_FILE_SCHEMAS[file]) {
      diagnostics.push({
        code: "MODEL_SCHEMA_UNSUPPORTED",
        severity: "error",
        concept: file,
        location: { file: `validation-design/model/${file}`, line: 1, column: 1 },
        message: `Schema ${String(value.schema ?? "(absent)")} is not supported for ${file}.`,
        correction: `Set schema to ${MODEL_FILE_SCHEMAS[file]}; use an explicit migration for older majors.`,
      });
    }
    parsed[file] = value;
  }
  return MODEL_FILES.every((file) => parsed[file] !== undefined) ? parsed : undefined;
}

function rows(
  parsed: ParsedFiles,
  files: Partial<Record<ModelFilename, string>>,
  diagnostics: CompilerDiagnostic[],
  file: ModelFilename,
  key: string,
): Row[] {
  const value = parsed[file][key];
  if (Array.isArray(value) && value.every(record)) return value;
  diagnostics.push({
    code: "MODEL_COLLECTION_INVALID",
    severity: "error",
    concept: key,
    location: scalarLocation(file, files[file] ?? ""),
    message: `${file} must define ${key} as a sequence of mappings.`,
    correction: `Add a ${key}: list with one mapping per declared concept.`,
  });
  return [];
}

function shapeError(
  diagnostics: CompilerDiagnostic[],
  files: Partial<Record<ModelFilename, string>>,
  file: ModelFilename,
  id: string,
  field: string,
  correction: string,
): void {
  diagnostics.push({
    code: "MODEL_FIELD_INVALID",
    severity: "error",
    concept: id,
    location: scalarLocation(file, files[file] ?? "", id),
    message: `${id} has a missing or invalid ${field}.`,
    correction,
  });
}

function rejectUnknownFields(
  diagnostics: CompilerDiagnostic[],
  files: Partial<Record<ModelFilename, string>>,
  file: ModelFilename,
  concept: string,
  row: Row,
  allowed: readonly string[],
): void {
  const supported = new Set(allowed);
  for (const field of Object.keys(row)) {
    if (supported.has(field)) continue;
    diagnostics.push({
      code: "MODEL_FIELD_UNKNOWN",
      severity: "error",
      concept,
      location: scalarLocation(file, files[file] ?? "", concept),
      message: `${concept} contains unknown field ${field}.`,
      correction: `Remove ${field} or migrate it into a field supported by ${MODEL_FILE_SCHEMAS[file]}.`,
    });
  }
}

function mapRows<T extends { id: string }>(
  sourceRows: Row[],
  diagnostics: CompilerDiagnostic[],
  files: Partial<Record<ModelFilename, string>>,
  file: ModelFilename,
  build: (row: Row, id: string) => T | undefined,
): T[] {
  const output: T[] = [];
  for (const row of sourceRows) {
    const id = text(row, "id");
    if (!id) {
      shapeError(diagnostics, files, file, "(entry)", "id", "Give every concept a stable non-empty id.");
      continue;
    }
    const built = build(row, id);
    if (built) output.push(built);
  }
  return output;
}

function duplicateDiagnostics(
  groups: Array<{ file: ModelFilename; items: Array<{ id: string }> }>,
  files: Partial<Record<ModelFilename, string>>,
  diagnostics: CompilerDiagnostic[],
): void {
  const global = new Map<string, { file: ModelFilename; occurrence: number }>();
  const perFile = new Map<string, number>();
  for (const group of groups) {
    for (const item of group.items) {
      const key = `${group.file}\0${item.id}`;
      const occurrence = perFile.get(key) ?? 0;
      perFile.set(key, occurrence + 1);
      const first = global.get(item.id);
      if (first) {
        diagnostics.push({
          code: "MODEL_ID_DUPLICATE",
          severity: "error",
          concept: item.id,
          location: scalarLocation(group.file, files[group.file] ?? "", item.id, occurrence),
          message: `${item.id} duplicates an existing model id from ${first.file}.`,
          correction: "Rename or remove the duplicate so every graph identity is globally unique.",
        });
      } else {
        global.set(item.id, { file: group.file, occurrence });
      }
    }
  }
}

function linkError(
  diagnostics: CompilerDiagnostic[],
  files: Partial<Record<ModelFilename, string>>,
  file: ModelFilename,
  concept: string,
  message: string,
  correction: string,
): void {
  diagnostics.push({
    code: "MODEL_LINK_BROKEN",
    severity: "error",
    concept,
    location: scalarLocation(file, files[file] ?? "", concept),
    message,
    correction,
  });
}


export function compileValidationModel(
  files: Partial<Record<ModelFilename, string>>,
  options: CompileModelOptions = {},
): CompiledModelBundle {
  const diagnostics: CompilerDiagnostic[] = [];
  const parsed = parseFiles(files, diagnostics);
  if (!parsed) return { accepted: false, diagnostics, generated_views: {} };

  const project = parsed["project.yaml"];
  rejectUnknownFields(diagnostics, files, "project.yaml", "project", project, ["schema", "product", "versions"]);
  const productRow = record(project.product) ? project.product : {};
  const versionsRow = record(project.versions) ? project.versions : {};
  rejectUnknownFields(diagnostics, files, "project.yaml", "product", productRow, ["id", "name", "revision", "intended_use", "criticality", "criticality_reason"]);
  rejectUnknownFields(diagnostics, files, "project.yaml", "versions", versionsRow, Object.keys(CURRENT_CORE_VERSIONS));
  const product: ProductIdentity = {
    id: text(productRow, "id") ?? "",
    name: text(productRow, "name") ?? "",
    revision: text(productRow, "revision") ?? "",
    intended_use: text(productRow, "intended_use") ?? "",
    criticality: text(productRow, "criticality") as ProductIdentity["criticality"],
    criticality_reason: text(productRow, "criticality_reason") ?? "",
  };
  for (const field of ["id", "name", "revision", "intended_use", "criticality_reason"] as const) if (!product[field]) shapeError(diagnostics, files, "project.yaml", "product", field, `Set product.${field} to an exact non-empty value.`);
  if (!["C0", "C1", "C2", "C3", "C4"].includes(product.criticality)) shapeError(diagnostics, files, "project.yaml", "product", "criticality", "Set product.criticality to the ratified C0, C1, C2, C3, or C4 tier.");
  const versions = Object.fromEntries(Object.keys(CURRENT_CORE_VERSIONS).map((key) => [key, text(versionsRow, key) ?? ""])) as unknown as CoreVersionBundle;
  for (const [key, expected] of Object.entries(CURRENT_CORE_VERSIONS)) if (versions[key as keyof CoreVersionBundle] !== expected) shapeError(diagnostics, files, "project.yaml", "versions", key, `Set versions.${key} to ${expected}; older versions require an explicit migration.`);

  const owners = mapRows<ModelOwner>(rows(parsed, files, diagnostics, "owners.yaml", "owners"), diagnostics, files, "owners.yaml", (row, id) => {
    rejectUnknownFields(diagnostics, files, "owners.yaml", id, row, ["id", "name", "responsibility"]);
    const name = text(row, "name"); const responsibility = text(row, "responsibility");
    if (!name || !responsibility) { shapeError(diagnostics, files, "owners.yaml", id, "name/responsibility", "Give every owner a name and responsibility."); return undefined; }
    return { id, name, responsibility };
  });
  const sources = mapRows<ModelSource>(rows(parsed, files, diagnostics, "sources.yaml", "sources"), diagnostics, files, "sources.yaml", (row, id) => {
    rejectUnknownFields(diagnostics, files, "sources.yaml", id, row, ["id", "kind", "path", "locator", "quote"]);
    const kind = text(row, "kind") as ModelSource["kind"] | undefined;
    if (!kind || !["doc", "rambling", "simulated", "proposed"].includes(kind)) { shapeError(diagnostics, files, "sources.yaml", id, "kind", "Use doc, rambling, simulated, or proposed."); return undefined; }
    return { id, kind, ...(text(row, "path") ? { path: text(row, "path") as string } : {}), ...(text(row, "locator") ? { locator: text(row, "locator") as string } : {}), ...(text(row, "quote") ? { quote: text(row, "quote") as string } : {}) };
  });
  const structures = mapRows<ProductStructure>(rows(parsed, files, diagnostics, "structures.yaml", "structures"), diagnostics, files, "structures.yaml", (row, id) => {
    rejectUnknownFields(diagnostics, files, "structures.yaml", id, row, ["id", "kind", "title", "meaning", "owner", "source_ids", "acceptance_criteria", "failure_modes", "changed_paths", "criticality", "criticality_reason"]);
    const kind = text(row, "kind") as ProductStructure["kind"] | undefined; const title = text(row, "title"); const meaning = text(row, "meaning"); const owner = text(row, "owner"); const sourceIds = texts(row, "source_ids");
    if (!kind || !["journey", "invariant", "boundary", "contract", "interface", "llm-site", "operation"].includes(kind) || !title || !meaning || !owner || !sourceIds?.length) { shapeError(diagnostics, files, "structures.yaml", id, "kind/title/meaning/owner/source_ids", "Declare complete structure meaning, ownership, and provenance."); return undefined; }
    const criticality = text(row, "criticality") as ProductStructure["criticality"] | undefined;
    if (criticality && !["C0", "C1", "C2", "C3", "C4"].includes(criticality)) shapeError(diagnostics, files, "structures.yaml", id, "criticality", "Use a C0-C4 component override or omit it to inherit the product tier.");
    return { id, kind, title, meaning, owner, source_ids: sourceIds, ...(texts(row, "acceptance_criteria") ? { acceptance_criteria: texts(row, "acceptance_criteria") as string[] } : {}), ...(texts(row, "failure_modes") ? { failure_modes: texts(row, "failure_modes") as string[] } : {}), ...(texts(row, "changed_paths") ? { changed_paths: texts(row, "changed_paths") as string[] } : {}), ...(criticality && ["C0", "C1", "C2", "C3", "C4"].includes(criticality) ? { criticality } : {}), ...(text(row, "criticality_reason") ? { criticality_reason: text(row, "criticality_reason") as string } : {}) };
  });
  const layerRows = rows(parsed, files, diagnostics, "policy.yaml", "layers");
  const laneRows = rows(parsed, files, diagnostics, "policy.yaml", "lanes");
  const exceptionRows = rows(parsed, files, diagnostics, "policy.yaml", "exceptions");
  rejectUnknownFields(diagnostics, files, "policy.yaml", "policy", parsed["policy.yaml"], ["schema", "default", "inheritance", "layers", "lanes", "exceptions", "coexistence"]);
  const layers = mapRows<ValidationLayer>(layerRows, diagnostics, files, "policy.yaml", (row, id) => {
    rejectUnknownFields(diagnostics, files, "policy.yaml", id, row, ["id", "title", "status", "reason"]);
    const title = text(row, "title"); const status = text(row, "status") as ValidationLayer["status"] | undefined;
    if (!title || !["L1", "L2", "L3", "L4", "L5", "L6"].includes(id) || !["active", "declared-empty"].includes(status ?? "")) { shapeError(diagnostics, files, "policy.yaml", id, "id/title/status", "Declare each canonical L1-L6 layer as active or declared-empty."); return undefined; }
    return { id: id as ValidationLayer["id"], title, status: status as ValidationLayer["status"], ...(text(row, "reason") ? { reason: text(row, "reason") as string } : {}) };
  });
  const lanes = mapRows<ValidationLane>(laneRows, diagnostics, files, "policy.yaml", (row, id) => {
    rejectUnknownFields(diagnostics, files, "policy.yaml", id, row, ["id", "title", "kind", "status", "requirement", "triggers", "command", "authorization", "reason"]);
    const title = text(row, "title"); const kind = text(row, "kind") as ValidationLane["kind"] | undefined; const status = text(row, "status") as ValidationLane["status"] | undefined; const requirement = text(row, "requirement") as ValidationLane["requirement"] | undefined; const triggers = texts(row, "triggers"); const authorization = text(row, "authorization") as ValidationLane["authorization"] | undefined;
    if (!title || !["test", "evidence"].includes(kind ?? "") || !["active", "declared-empty"].includes(status ?? "") || !["blocking", "advisory"].includes(requirement ?? "") || !triggers || (authorization && !["none", "per-run-human"].includes(authorization))) { shapeError(diagnostics, files, "policy.yaml", id, "title/kind/status/requirement/triggers/authorization", "Declare a typed lane, fail-closed requirement, trigger list, and recognized authorization."); return undefined; }
    return { id, title, kind: kind as ValidationLane["kind"], status: status as ValidationLane["status"], requirement: requirement as ValidationLane["requirement"], triggers, ...(text(row, "command") ? { command: text(row, "command") as string } : {}), ...(authorization ? { authorization } : {}), ...(text(row, "reason") ? { reason: text(row, "reason") as string } : {}) };
  });
  const exceptions = mapRows<PolicyException>(exceptionRows, diagnostics, files, "policy.yaml", (row, id) => {
    rejectUnknownFields(diagnostics, files, "policy.yaml", id, row, ["id", "kind", "target", "owner", "reason", "expires", "value"]);
    const kind = text(row, "kind") as PolicyException["kind"] | undefined; const target = text(row, "target"); const owner = text(row, "owner"); const reason = text(row, "reason"); const expires = text(row, "expires");
    if (!["waiver", "provisional"].includes(kind ?? "") || !target || !owner || !reason || !expires) { shapeError(diagnostics, files, "policy.yaml", id, "kind/target/owner/reason/expires", "Declare every exception with a target, owner, reason, and ISO expiry date."); return undefined; }
    return { id, kind: kind as PolicyException["kind"], target, owner, reason, expires, ...(text(row, "value") ? { value: text(row, "value") as string } : {}) };
  });
  const coexistenceRow = record(parsed["policy.yaml"].coexistence) ? parsed["policy.yaml"].coexistence : undefined;
  let coexistence: CoexistencePolicy | undefined;
  if (coexistenceRow) {
    rejectUnknownFields(diagnostics, files, "policy.yaml", "coexistence", coexistenceRow, ["posture", "isolated_root", "protected_paths", "incumbent_gates", "ci_integration", "cutover_requires"]);
    const isolatedRoot = text(coexistenceRow, "isolated_root"); const protectedPaths = texts(coexistenceRow, "protected_paths"); const cutoverRequires = texts(coexistenceRow, "cutover_requires");
    if (coexistenceRow.posture !== "parallel-greenfield" || !isolatedRoot || !protectedPaths?.length || coexistenceRow.incumbent_gates !== "read_only" || coexistenceRow.ci_integration !== "additive_opt_in" || !cutoverRequires?.length) shapeError(diagnostics, files, "policy.yaml", "coexistence", "posture/paths/gates/CI/cutover", "Declare the isolated root, protected paths, read-only incumbent gates, additive opt-in CI, and cutover evidence.");
    else coexistence = { posture: "parallel-greenfield", isolated_root: isolatedRoot, protected_paths: protectedPaths, incumbent_gates: "read_only", ci_integration: "additive_opt_in", cutover_requires: cutoverRequires };
  }
  const policy: ValidationPolicy = { default: "blocking", inheritance: "tighten-only", layers, lanes, exceptions, ...(coexistence ? { coexistence } : {}) };
  if (parsed["policy.yaml"].default !== "blocking") shapeError(diagnostics, files, "policy.yaml", "policy", "default", "Set default: blocking; unknown gates fail closed.");
  if (parsed["policy.yaml"].inheritance !== "tighten-only") shapeError(diagnostics, files, "policy.yaml", "policy", "inheritance", "Set inheritance: tighten-only; descendants may not loosen requirements.");
  const controls = mapRows<NegativeControl>(rows(parsed, files, diagnostics, "controls.yaml", "controls"), diagnostics, files, "controls.yaml", (row, id) => {
    rejectUnknownFields(diagnostics, files, "controls.yaml", id, row, ["id", "title", "family_id", "owner", "expected_failure"]);
    const title = text(row, "title"); const familyId = text(row, "family_id"); const owner = text(row, "owner"); const expected = text(row, "expected_failure");
    if (!title || !familyId || !owner || !expected) { shapeError(diagnostics, files, "controls.yaml", id, "title/family_id/owner/expected_failure", "Describe how this control proves the detector can turn red."); return undefined; }
    return { id, title, family_id: familyId, owner, expected_failure: expected };
  });
  const families = mapRows<ValidationFamily>(rows(parsed, files, diagnostics, "families.yaml", "families"), diagnostics, files, "families.yaml", (row, id) => {
    rejectUnknownFields(diagnostics, files, "families.yaml", id, row, ["id", "title", "meaning", "structure_ids", "owner", "source_ids", "lane", "status", "layer", "oracle", "risk", "control_ids", "ticket", "planned_tests", "evidence", "blocked_by", "reason", "exclusions"]);
    const title = text(row, "title"); const meaning = text(row, "meaning"); const structureIds = texts(row, "structure_ids"); const owner = text(row, "owner"); const sourceIds = texts(row, "source_ids"); const lane = text(row, "lane"); const status = text(row, "status") as ValidationFamily["status"] | undefined; const ticket = text(row, "ticket"); const layer = text(row, "layer") as ValidationFamily["layer"] | undefined;
    if (!title || !meaning || !structureIds?.length || !owner || !sourceIds?.length || !lane || !["implementable", "pruned", "blocked"].includes(status ?? "")) { shapeError(diagnostics, files, "families.yaml", id, "title/meaning/structure_ids/owner/source_ids/lane/status", "Declare complete family meaning, links, owner, lane, and status."); return undefined; }
    if (layer && !["L1", "L2", "L3", "L4", "L5", "L6"].includes(layer)) shapeError(diagnostics, files, "families.yaml", id, "layer", "Place the family at canonical layer L1, L2, L3, L4, L5, or L6.");
    const evidenceRow = record(row.evidence) ? row.evidence : undefined; if (evidenceRow) rejectUnknownFields(diagnostics, files, "families.yaml", id, evidenceRow, ["state", "path"]); const evidenceState = evidenceRow ? text(evidenceRow, "state") as NonNullable<ValidationFamily["evidence"]>["state"] | undefined : undefined; const evidencePath = evidenceRow ? text(evidenceRow, "path") : undefined;
    return { id, title, meaning, structure_ids: structureIds, owner, source_ids: sourceIds, lane, status: status as ValidationFamily["status"], ...(ticket ? { ticket } : {}), ...(layer && ["L1", "L2", "L3", "L4", "L5", "L6"].includes(layer) ? { layer } : {}), ...(text(row, "oracle") ? { oracle: text(row, "oracle") as string } : {}), ...(text(row, "risk") ? { risk: text(row, "risk") as string } : {}), ...(texts(row, "control_ids") ? { control_ids: texts(row, "control_ids") as string[] } : {}), ...(texts(row, "planned_tests") ? { planned_tests: texts(row, "planned_tests") as string[] } : {}), ...(evidenceState && evidencePath && ["complete", "incomplete", "inconclusive", "unobserved"].includes(evidenceState) ? { evidence: { state: evidenceState, path: evidencePath } } : {}), ...(text(row, "blocked_by") ? { blocked_by: text(row, "blocked_by") as string } : {}), ...(text(row, "reason") ? { reason: text(row, "reason") as string } : {}), ...(texts(row, "exclusions") ? { exclusions: texts(row, "exclusions") as string[] } : {}) };
  });
  const tickets = mapRows<BacklogTicket>(rows(parsed, files, diagnostics, "backlog.yaml", "tickets"), diagnostics, files, "backlog.yaml", (row, id) => {
    rejectUnknownFields(diagnostics, files, "backlog.yaml", id, row, ["id", "title", "wave", "status", "owner", "executor", "lane", "layer", "acceptance_criteria", "family_ids", "depends_on"]);
    const title = text(row, "title"); const wave = text(row, "wave"); const status = text(row, "status") as BacklogTicket["status"] | undefined; const owner = text(row, "owner"); const executor = text(row, "executor"); const lane = text(row, "lane"); const layer = text(row, "layer") as BacklogTicket["layer"] | undefined; const acceptanceCriteria = texts(row, "acceptance_criteria"); const familyIds = texts(row, "family_ids"); const dependsOn = texts(row, "depends_on");
    if (!title || !wave || !["pending", "landed", "blocked", "parked"].includes(status ?? "") || !owner || !executor || !lane || !layer || !["L1", "L2", "L3", "L4", "L5", "L6"].includes(layer) || !acceptanceCriteria?.length || !familyIds?.length) { shapeError(diagnostics, files, "backlog.yaml", id, "title/wave/status/owner/executor/lane/layer/acceptance_criteria/family_ids", "Declare actionable work with an executor, one layer/lane, acceptance criteria, and owned families."); return undefined; }
    if (row.depends_on !== undefined && (!dependsOn || !dependsOn.every((dependency) => dependency.trim().length > 0))) shapeError(diagnostics, files, "backlog.yaml", id, "depends_on", "Use an array of non-empty canonical ticket IDs.");
    return { id, title, wave, status: status as BacklogTicket["status"], owner, executor, lane, layer, acceptance_criteria: acceptanceCriteria, family_ids: familyIds, ...(dependsOn ? { depends_on: dependsOn } : {}) };
  });

  for (const [file, key] of [["owners.yaml", "owners"], ["sources.yaml", "sources"], ["structures.yaml", "structures"], ["controls.yaml", "controls"], ["families.yaml", "families"], ["backlog.yaml", "tickets"]] as const) {
    rejectUnknownFields(diagnostics, files, file, file, parsed[file], ["schema", key]);
  }
  duplicateDiagnostics([{ file: "owners.yaml", items: owners }, { file: "sources.yaml", items: sources }, { file: "structures.yaml", items: structures }, { file: "policy.yaml", items: layers }, { file: "policy.yaml", items: lanes }, { file: "policy.yaml", items: exceptions }, { file: "controls.yaml", items: controls }, { file: "families.yaml", items: families }, { file: "backlog.yaml", items: tickets }], files, diagnostics);
  const model: CompiledDesignModel = { schema: MODEL_SCHEMA, product, versions, owners: stable(owners), sources: stable(sources), structures: stable(structures), policy: { ...policy, layers: stable(layers), lanes: stable(lanes), exceptions: stable(exceptions) }, controls: stable(controls), families: stable(families), tickets: stable(tickets) };
  validateModel(model, {
    diagnostics,
    safePath,
    shapeError: (file, id, field, correction) => shapeError(diagnostics, files, file, id, field, correction),
    linkError: (file, concept, message, correction) => linkError(diagnostics, files, file, concept, message, correction),
  });
  if (diagnostics.some((item) => item.severity === "error")) return { accepted: false, diagnostics, generated_views: {} };

  const canonicalModel = stringify(model, { lineWidth: 0, sortMapEntries: true });
  const generatedViews = generateModelViews(model);
  const identityHash = createHash("sha256").update(canonicalModel);
  for (const file of GENERATED_MODEL_VIEWS) identityHash.update(file).update("\0").update(generatedViews[file]);
  const identity = identityHash.digest("hex");
  if (options.existingViews) {
    for (const file of GENERATED_MODEL_VIEWS) if (options.existingViews[file] !== generatedViews[file]) diagnostics.push({ code: "GENERATED_VIEW_STALE", severity: options.allowRegenerate ? "warning" : "error", concept: file, location: { file: `validation-design/${file}`, line: 1, column: 1 }, message: `${file} is missing or differs semantically from model identity ${identity}.`, correction: "Regenerate this non-authoritative view from the checked YAML model." });
  }
  return { accepted: !diagnostics.some((item) => item.severity === "error"), diagnostics, model, canonical_model: canonicalModel, generated_views: generatedViews, identity };
}

export type { ModelFileSet };
