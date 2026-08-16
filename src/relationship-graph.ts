import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type {
  CompiledDesignModel,
  EvidenceState,
  TestInventory,
  ValidationEvidenceSet,
} from "./model.js";
import { joinTestInventory } from "./model-inventory.js";

export const VALIDATION_TRACE_CHECK = "Validation Trace";
const SECRET_PATTERN = /(?:AKIA[A-Z0-9]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{12,}|(?:token|secret|password|authorization)=(?!\[REDACTED\])\S+)/i;

export type RelationshipKind =
  | "owner"
  | "source"
  | "structure"
  | "family"
  | "control"
  | "ticket"
  | "test"
  | "evidence";

export interface RelationshipNode {
  id: string;
  kind: RelationshipKind;
  meaning: string;
  path?: string;
  owner_id?: string;
  state?: EvidenceState;
  details: Record<string, unknown>;
}

export type RelationshipType =
  | "owns"
  | "provenance"
  | "protects"
  | "implemented-by"
  | "produces"
  | "controlled-by"
  | "delivered-by";

export interface RelationshipEdge {
  from: string;
  to: string;
  type: RelationshipType;
}

export type TraceFindingLevel = "red" | "unresolved" | "partial";

export interface TraceFinding {
  code: string;
  level: TraceFindingLevel;
  subject_id: string;
  message: string;
  correction: string;
}

export interface RelationshipGraphIdentity {
  model_identity: string;
  product_revision: string;
  environment: string;
  inventory_identity: string;
  evidence_identity: string;
  graph_identity: string;
  versions: CompiledDesignModel["versions"];
}

export interface RelationshipGraph {
  schema: "validation-architect/relationship-graph/v1";
  identity: RelationshipGraphIdentity;
  nodes: RelationshipNode[];
  edges: RelationshipEdge[];
  findings: TraceFinding[];
  structurally_closed: boolean;
  assurance_complete: boolean;
  check: { name: typeof VALIDATION_TRACE_CHECK; required_check_handoff: true };
}

export interface RelationshipGraphInput {
  model: CompiledDesignModel;
  model_identity: string;
  inventory: TestInventory;
  evidence: ValidationEvidenceSet;
  /** Exact revision observed by RepositoryPort. When supplied, graph identity
   * is bound to this revision even if the checked corpus is stale. */
  repository_revision?: string;
  /** Repository-convention findings derived from the same immutable read. */
  repository_findings?: readonly TraceFinding[];
  /** Repository-adapter observation used only for existence checks. */
  observed_paths?: readonly string[];
  /** Identity read from generated projection metadata. */
  projection_identity?: string;
}

function canonical(value: unknown): string {
  const sort = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sort(child)]));
    }
    return item;
  };
  return JSON.stringify(sort(value));
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/** Stable identity helper for adapter-supplied inventory/evidence payloads. */
export function relationshipPayloadIdentity(value: unknown): string {
  return hash(value);
}

function safePath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && !path.includes("\0") && !path.replaceAll("\\", "/").split("/").includes("..");
}

function redact(value: unknown): unknown {
  if (typeof value === "string") return SECRET_PATTERN.test(value) ? "[REDACTED]" : value;
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
  return value;
}

function node(nodes: RelationshipNode[], value: RelationshipNode): void {
  if (!nodes.some((candidate) => candidate.id === value.id)) nodes.push(redact(value) as RelationshipNode);
}

function edge(edges: RelationshipEdge[], from: string, to: string, type: RelationshipType): void {
  if (!edges.some((item) => item.from === from && item.to === to && item.type === type)) edges.push({ from, to, type });
}

function finding(findings: TraceFinding[], value: TraceFinding): void {
  const safe = redact(value) as TraceFinding;
  if (!findings.some((item) => item.code === safe.code && item.subject_id === safe.subject_id && item.message === safe.message)) findings.push(safe);
}

function evidenceIntegrityValid(value: string): boolean {
  return /^(?:sha256:)?[a-f0-9]{64}$/.test(value);
}

export function buildRelationshipGraph(input: RelationshipGraphInput): RelationshipGraph {
  const { model, inventory, evidence } = input;
  const nodes: RelationshipNode[] = [];
  const edges: RelationshipEdge[] = [];
  const findings: TraceFinding[] = [];
  const owners = new Set(model.owners.map((item) => item.id));
  const sources = new Set(model.sources.map((item) => item.id));
  const families = new Map(model.families.map((item) => [item.id, item]));
  const controls = new Map(model.controls.map((item) => [item.id, item]));
  const observed = input.observed_paths ? new Set(input.observed_paths) : undefined;
  const checkedRevision = input.repository_revision ?? model.product.revision;

  for (const repositoryFinding of input.repository_findings ?? []) finding(findings, repositoryFinding);

  if (SECRET_PATTERN.test(JSON.stringify(model))) finding(findings, { code: "MODEL_SECRET_UNSAFE", level: "red", subject_id: model.product.id, message: "The checked model contains text shaped like a credential or secret.", correction: "Remove secret values; cite only safe repository references." });

  if (model.product.revision !== checkedRevision) finding(findings, { code: "MODEL_REVISION_STALE", level: "red", subject_id: model.product.id, message: `Design revision ${model.product.revision} does not match checked repository revision ${checkedRevision}.`, correction: "Regenerate and review the design corpus at the exact repository revision." });
  if (inventory.revision !== checkedRevision) finding(findings, { code: "INVENTORY_IDENTITY_MISMATCH", level: "red", subject_id: inventory.revision, message: `Inventory revision ${inventory.revision} does not match checked repository revision ${checkedRevision}.`, correction: "Regenerate inventory at the exact checked revision." });
  if (inventory.tests_root_present === false || (inventory.tests_root !== undefined && !safePath(inventory.tests_root))) finding(findings, { code: "TESTS_ROOT_ABSENT", level: "red", subject_id: inventory.tests_root ?? "tests-root", message: "The repository adapter did not observe a safe tests root.", correction: "Restore the declared tests root and regenerate inventory; absence is never green." });
  if (evidence.revision !== checkedRevision || evidence.environment !== inventory.environment) finding(findings, { code: "EVIDENCE_IDENTITY_MISMATCH", level: "red", subject_id: evidence.revision, message: "Evidence revision/environment does not match the graph inventory identity.", correction: "Collect evidence at the exact inventory revision and environment." });
  if (input.projection_identity !== undefined && input.projection_identity !== input.model_identity) finding(findings, { code: "GENERATED_VIEW_STALE", level: "red", subject_id: input.projection_identity, message: "Generated projections are not bound to this model identity.", correction: "Regenerate every projection from the current checked model." });

  for (const owner of model.owners) node(nodes, { id: owner.id, kind: "owner", meaning: owner.responsibility, details: { name: owner.name } });
  for (const source of model.sources) {
    node(nodes, { id: source.id, kind: "source", meaning: source.quote ?? source.locator ?? source.path ?? source.id, ...(source.path ? { path: source.path } : {}), details: { kind: source.kind, locator: source.locator } });
    if (source.path && observed && !observed.has(source.path)) finding(findings, { code: "SOURCE_LINK_BROKEN", level: "red", subject_id: source.id, message: `Provenance path ${source.path} was not observed.`, correction: "Restore the source or update the reviewed provenance link." });
  }
  for (const structure of model.structures) {
    node(nodes, { id: structure.id, kind: "structure", meaning: structure.meaning, owner_id: structure.owner, details: { kind: structure.kind, title: structure.title, changed_paths: structure.changed_paths ?? [], acceptance_criteria: structure.acceptance_criteria ?? [], failure_modes: structure.failure_modes ?? [] } });
    if (owners.has(structure.owner)) edge(edges, structure.owner, structure.id, "owns");
    else finding(findings, { code: "OWNER_MISSING", level: "red", subject_id: structure.id, message: `${structure.id} has missing owner ${structure.owner}.`, correction: "Declare the owning product role and recompile." });
    for (const sourceId of structure.source_ids) {
      if (sources.has(sourceId)) edge(edges, sourceId, structure.id, "provenance");
      else finding(findings, { code: "SOURCE_LINK_BROKEN", level: "red", subject_id: structure.id, message: `${structure.id} cites missing source ${sourceId}.`, correction: "Restore or correct the reviewed source link." });
    }
  }

  const joined = joinTestInventory(model, inventory);
  for (const diagnostic of joined.diagnostics) finding(findings, { code: diagnostic.code === "INVENTORY_FAMILY_UNKNOWN" ? "ORPHAN_TEST" : diagnostic.code, level: "red", subject_id: diagnostic.test_id ?? diagnostic.family_id ?? "inventory", message: diagnostic.message, correction: diagnostic.correction });
  for (const family of model.families) {
    node(nodes, { id: family.id, kind: "family", meaning: family.meaning, owner_id: family.owner, ...(family.evidence ? { path: family.evidence.path, state: family.evidence.state } : {}), details: { title: family.title, lane: family.lane, layer: family.layer, oracle: family.oracle, risk: family.risk, status: family.status, exclusions: family.exclusions ?? [], planned_tests: family.planned_tests ?? [] } });
    if (owners.has(family.owner)) edge(edges, family.owner, family.id, "owns");
    else finding(findings, { code: "OWNER_MISSING", level: "red", subject_id: family.id, message: `${family.id} has missing owner ${family.owner}.`, correction: "Assign a declared owner." });
    for (const structureId of family.structure_ids) {
      if (model.structures.some((item) => item.id === structureId)) edge(edges, structureId, family.id, "protects");
      else finding(findings, { code: "STRUCTURE_LINK_BROKEN", level: "red", subject_id: family.id, message: `${family.id} cites missing structure ${structureId}.`, correction: "Restore or correct the reviewed structure relationship." });
    }
    for (const sourceId of family.source_ids) {
      if (sources.has(sourceId)) edge(edges, sourceId, family.id, "provenance");
      else finding(findings, { code: "SOURCE_LINK_BROKEN", level: "red", subject_id: family.id, message: `${family.id} cites missing source ${sourceId}.`, correction: "Restore or correct the reviewed source relationship." });
    }
    for (const controlId of family.control_ids ?? []) {
      const control = controls.get(controlId);
      if (!control || control.family_id !== family.id) finding(findings, { code: "NEGATIVE_CONTROL_LINK_BROKEN", level: "red", subject_id: family.id, message: `${family.id} has missing or inconsistent negative control ${controlId}.`, correction: "Restore the bidirectional family/control relationship." });
      else edge(edges, family.id, controlId, "controlled-by");
    }
    if (family.status === "implementable" && !family.control_ids?.length) finding(findings, { code: "NEGATIVE_CONTROL_LINK_BROKEN", level: "red", subject_id: family.id, message: `${family.id} has no paired negative control.`, correction: "Declare and implement a distinguishing negative control." });
    if (family.ticket) edge(edges, family.id, family.ticket, "delivered-by");
  }
  for (const control of model.controls) node(nodes, { id: control.id, kind: "control", meaning: control.expected_failure, owner_id: control.owner, details: { title: control.title, family_id: control.family_id } });
  for (const ticket of model.tickets) node(nodes, { id: ticket.id, kind: "ticket", meaning: ticket.title, owner_id: ticket.owner, details: { status: ticket.status, wave: ticket.wave, lane: ticket.lane, layer: ticket.layer, acceptance_criteria: ticket.acceptance_criteria } });

  for (const test of inventory.tests) {
    if (!safePath(test.path)) continue;
    if (test.command && (test.command.includes("\0") || SECRET_PATTERN.test(test.command))) finding(findings, { code: "COMMAND_UNSAFE", level: "red", subject_id: test.id, message: `Inventory command for ${test.id} is unsafe and was redacted.`, correction: "Supply a non-secret command as adapter data; core never executes it." });
    node(nodes, { id: test.id, kind: "test", meaning: `Executable detector at ${test.path}`, path: test.path, details: { command: test.command, always_run: test.always_run ?? false, control_ids: test.control_ids ?? [] } });
    for (const familyId of test.family_ids) if (families.has(familyId)) edge(edges, familyId, test.id, "implemented-by");
    for (const controlId of test.control_ids ?? []) if (controls.has(controlId)) edge(edges, controlId, test.id, "implemented-by");
  }
  for (const item of evidence.items) {
    if (!safePath(item.path) || !evidenceIntegrityValid(item.integrity)) finding(findings, { code: "EVIDENCE_ARTIFACT_INVALID", level: "red", subject_id: item.id, message: `Evidence ${item.id} has an unsafe path or invalid sha256 integrity.`, correction: "Emit a safe repository-relative reference with an exact sha256 digest." });
    node(nodes, { id: item.id, kind: "evidence", meaning: `${item.state} ${item.scope ?? "run"} evidence at ${item.path}`, path: item.path, state: item.state, details: { integrity: item.integrity, environment: evidence.environment, scope: item.scope ?? "run" } });
    for (const familyId of item.family_ids) {
      if (!families.has(familyId)) finding(findings, { code: "EVIDENCE_FAMILY_UNKNOWN", level: "red", subject_id: item.id, message: `${item.id} cites unknown family ${familyId}.`, correction: "Correct the adapter evidence mapping." });
      else {
        const tests = inventory.tests.filter((test) => test.family_ids.includes(familyId));
        if (tests.length === 0) edge(edges, familyId, item.id, "produces");
        else for (const test of tests) edge(edges, test.id, item.id, "produces");
      }
    }
    if (item.state !== "complete") finding(findings, { code: "EVIDENCE_PARTIAL", level: "partial", subject_id: item.id, message: `${item.id} remains ${item.state}; artifact existence is structural closure only.`, correction: "Collect complete evidence before reporting product green." });
    if (item.scope === "structural") finding(findings, { code: "STRUCTURAL_EVIDENCE_ONLY", level: "partial", subject_id: item.id, message: `${item.id} proves linkage/existence only, not execution or product behavior.`, correction: "Keep the trace check separate and collect run evidence before product green." });
  }

  for (const family of model.families.filter((item) => item.status === "implementable")) {
    const tests = inventory.tests.filter((test) => test.family_ids.includes(family.id));
    const actualEvidence = evidence.items.filter((item) => item.family_ids.includes(family.id));
    const ticketStatus = model.tickets.find((ticket) => ticket.id === family.ticket)?.status;
    const nonLanded = ticketStatus === "pending" || ticketStatus === "blocked" || ticketStatus === "parked";
    const implementationAbsent = tests.length === 0 && actualEvidence.length === 0;
    if (implementationAbsent && nonLanded) finding(findings, { code: "IMPLEMENTATION_PENDING", level: "partial", subject_id: family.id, message: `${family.id} has no observed implementation while its owner ticket ${family.ticket} is ${ticketStatus}.`, correction: "Land the declared implementation before marking the owner ticket landed or reporting product green." });
    if (implementationAbsent && !nonLanded) finding(findings, { code: "IMPLEMENTATION_MISSING", level: "red", subject_id: family.id, message: `${family.id} has no observed test or evidence implementation.`, correction: "Implement the declared detector/evidence or change the reviewed family status." });
    if (actualEvidence.length === 0 && !(implementationAbsent && nonLanded)) finding(findings, { code: "EVIDENCE_ARTIFACT_MISSING", level: "red", subject_id: family.id, message: `${family.id} has no revision-bound evidence artifact.`, correction: "Collect and integrity-bind evidence for the exact graph identity." });
    if (family.evidence && !actualEvidence.some((item) => item.path === family.evidence?.path) && !(implementationAbsent && nonLanded)) finding(findings, { code: "EVIDENCE_ARTIFACT_MISSING", level: "red", subject_id: family.id, message: `${family.id} declares ${family.evidence.path}, but matching evidence was not observed.`, correction: "Collect the declared artifact at the exact graph identity." });
    for (const planned of family.planned_tests ?? []) if (!nonLanded && !tests.some((test) => test.path === planned)) finding(findings, { code: "PLANNED_IMPLEMENTATION_DRIFT", level: "red", subject_id: family.id, message: `${family.id} planned test ${planned} was not observed.`, correction: "Land the planned test or revise the reviewed model and recompile." });
    const landed = ticketStatus === "landed";
    if (landed && tests.length === 0 && actualEvidence.length === 0) finding(findings, { code: "LANDED_STATUS_FALSE", level: "red", subject_id: family.ticket ?? family.id, message: `${family.ticket} is landed but ${family.id} has no implementation.`, correction: "Land the implementation or restore an honest ticket status." });
  }

  nodes.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.type.localeCompare(b.type));
  findings.sort((a, b) => a.level.localeCompare(b.level) || a.code.localeCompare(b.code) || a.subject_id.localeCompare(b.subject_id));
  const baseIdentity = { model_identity: input.model_identity, product_revision: checkedRevision, environment: inventory.environment, inventory_identity: relationshipPayloadIdentity(inventory), evidence_identity: relationshipPayloadIdentity(evidence), versions: structuredClone(model.versions) };
  const graph_identity = hash({ ...baseIdentity, nodes, edges, findings });
  return {
    schema: "validation-architect/relationship-graph/v1",
    identity: { ...baseIdentity, graph_identity },
    nodes,
    edges,
    findings,
    structurally_closed: !findings.some((item) => item.level === "red" || item.level === "unresolved"),
    assurance_complete: findings.length === 0,
    check: { name: VALIDATION_TRACE_CHECK, required_check_handoff: true },
  };
}

export interface RelationshipQuery {
  selector: string;
  matched_by: "id" | "path";
  roots: string[];
  nodes: RelationshipNode[];
  edges: RelationshipEdge[];
  unresolved: TraceFinding[];
}

/** Bidirectional traversal with bounded visited-node expansion. */
export function queryRelationshipGraph(graph: RelationshipGraph, selector: string): RelationshipQuery {
  const safeSelector = SECRET_PATTERN.test(selector) ? "[REDACTED]" : selector;
  const roots = safeSelector === "[REDACTED]" ? [] : graph.nodes.filter((item) => item.id === selector || item.path === selector).map((item) => item.id);
  const matchedBy = graph.nodes.some((item) => item.id === selector) ? "id" : "path";
  const visited = new Set(roots);
  const queue = [...roots];
  const leafKinds = new Set<RelationshipKind>(["owner", "source", "control", "ticket"]);
  const kindById = new Map(graph.nodes.map((item) => [item.id, item.kind]));
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (!roots.includes(current) && leafKinds.has(kindById.get(current) as RelationshipKind)) continue;
    for (const link of graph.edges) {
      const adjacent = link.from === current ? link.to : link.to === current ? link.from : undefined;
      if (adjacent && !visited.has(adjacent)) { visited.add(adjacent); queue.push(adjacent); }
    }
  }
  const unresolved = roots.length === 0
    ? [{ code: "QUERY_UNRESOLVED", level: "unresolved" as const, subject_id: safeSelector, message: `No graph identity or exact path matches ${safeSelector}.`, correction: "Use an exact stable id/path or repair the adapter mapping." }]
    : graph.findings.filter((item) => visited.has(item.subject_id));
  return {
    selector: safeSelector,
    matched_by: matchedBy,
    roots: roots.sort(),
    nodes: graph.nodes.filter((item) => visited.has(item.id)),
    edges: graph.edges.filter((item) => visited.has(item.from) && visited.has(item.to)),
    unresolved,
  };
}
