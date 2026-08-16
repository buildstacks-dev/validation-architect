/**
 * The seven deterministic public entry points (VA-API-003, contract D3).
 * Every function is a pure function of the corpus plus repository facts read
 * through RepositoryPort: no filesystem, Git, network, process, provider, or
 * publication effect. Identical validated facts produce identical data.
 */

import { createHash } from "node:crypto";
import {
  importLegacyCatalog,
  type LegacyMigrationLedger,
  type LegacyModelImportInput,
} from "../legacy-model-import.js";
import type { CompilerDiagnostic } from "../model.js";
import {
  IMPACT_MAPPING_SCHEMA,
  planChangedImpact,
  type ChangedInput,
  type ExplainedImpactPlan,
  type ImpactMappingSet,
} from "../impact.js";
import {
  queryRelationshipGraph,
  relationshipPayloadIdentity,
  type RelationshipGraph,
  type RelationshipQuery,
} from "../relationship-graph.js";
import {
  explainRelationshipQuery,
  generateRelationshipViews,
  type RelationshipRoleView,
  type RelationshipViewRole,
} from "../relationship-views.js";
import {
  bootstrapFailureToValidationResult,
  startupRunToValidationResult,
  type BootstrapFailureEnvelope,
  type StartupConformanceRun,
} from "../capabilities.js";
import { relationshipTraceToValidationResult, type ResultMappingContext } from "../result-adapters.js";
import type { ValidationResultV1, ResultEvidenceReference } from "../validation-result.js";
import { invalidInput, invalidOutput, unsupportedSchemaMajor } from "./errors.js";
import type { RepositoryPort } from "./ports.js";
import {
  compileFromRepository,
  loadRepositoryFacts,
  DESIGN_ROOT,
  type RepositoryFacts,
  type RepositoryFactsOptions,
} from "./repository-facts.js";
import { CORPUS_SCHEMA, parseRepositoryYaml, validatePlan, validateResult } from "./schemas.js";
import {
  assertValid,
  isRecord,
  requireArray,
  requireEnum,
  requireRecord,
  requireSafePath,
  requireString,
  requireStringArray,
} from "./validate.js";

export const IMPACT_MAPPINGS_PATH = `${DESIGN_ROOT}/impact-mappings.yaml`;

// ── compile ──────────────────────────────────────────────────────────────────

export interface CompileOutput {
  revision: string;
  accepted: boolean;
  identity?: string;
  /** Source-located author findings; empty when accepted. */
  findings: CompilerDiagnostic[];
  /** Regenerated human views as data; the caller decides whether to write. */
  views: Record<string, string>;
}

/** Author-facing corpus validation and view regeneration. An invalid corpus
 * never yields an accepted bundle; nothing is written anywhere. */
export async function compile(repo: RepositoryPort, options: RepositoryFactsOptions = {}): Promise<CompileOutput> {
  const compiled = await compileFromRepository(repo, options);
  return {
    revision: compiled.revision,
    accepted: compiled.accepted,
    ...(compiled.identity ? { identity: compiled.identity } : {}),
    findings: compiled.diagnostics,
    views: compiled.views,
  };
}

// ── check ────────────────────────────────────────────────────────────────────

export interface CheckOptions extends RepositoryFactsOptions {
  /** Lane identity stamped into the gate result; defaults to the corpus's
   * first blocking test lane. */
  lane?: string;
}

function factsEvidence(facts: RepositoryFacts): ResultEvidenceReference[] {
  const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");
  // The compiled corpus itself is always integrity-bound evidence of the
  // check, so a broken trace still produces a valid fail-closed record.
  const corpus: ResultEvidenceReference[] = Object.entries(facts.modelFiles).map(([path, content]) => ({
    id: `EVIDENCE-CORPUS-${path.split("/").pop()}`,
    kind: "artifact" as const,
    reference: path,
    integrity: { algorithm: "sha256" as const, digest: sha256(content) },
  }));
  const observed: ResultEvidenceReference[] = facts.evidence.items.map((item) => ({
    id: item.id,
    kind: "artifact" as const,
    reference: item.path,
    integrity: { algorithm: "sha256" as const, digest: item.integrity },
  }));
  return [...corpus, ...observed];
}

function defaultLane(facts: RepositoryFacts, requested?: string): string {
  if (requested) return requested;
  const blocking = facts.model.policy.lanes.filter((item) => item.kind === "test" && item.requirement === "blocking");
  const lane = blocking.find((item) => item.triggers.includes("per-commit")) ?? blocking[0];
  if (!lane) throw invalidInput("The corpus declares no blocking test lane; pass options.lane explicitly.");
  return lane.id;
}

function gateContext(facts: RepositoryFacts, lane: string): ResultMappingContext {
  const owner = facts.model.owners[0];
  if (!owner) throw invalidInput("The corpus declares no owner; a gate result must name accountable ownership.");
  return {
    identity: {
      product_revision: facts.revision,
      lane,
      environment: facts.inventory.environment,
      versions: facts.model.versions,
    },
    structure_id: facts.model.product.id,
    root_id: "TRACE-ROOT",
    owner: owner.id,
    evidence: factsEvidence(facts),
  };
}

/**
 * The CI gate: is the corpus closed against the tests that actually exist?
 * Fail-closed — a corpus that does not compile, a broken trace, or incomplete
 * evidence is never green. Returns the public result record, not a boolean.
 */
export async function check(repo: RepositoryPort, options: CheckOptions = {}): Promise<ValidationResultV1> {
  const loaded = await loadRepositoryFacts(repo, options);
  if (loaded.failure) {
    throw invalidInput(
      `The corpus does not compile; the gate is non-green by construction. ${loaded.failure.problems.join(" | ")}`,
      { problems: loaded.failure.problems, revision: loaded.failure.revision },
    );
  }
  const facts = loaded.facts as RepositoryFacts;
  const lane = defaultLane(facts, options.lane);
  const result = relationshipTraceToValidationResult(facts.graph, gateContext(facts, lane));
  return validateResult(result);
}

// ── explain ──────────────────────────────────────────────────────────────────

export interface ExplainOutput {
  query: RelationshipQuery;
  /** Product meaning first, exact IDs second, unresolved hops explicit. */
  explanation: string;
  graph: RelationshipGraph;
}

export async function explain(
  repo: RepositoryPort,
  selector: string,
  options: RepositoryFactsOptions = {},
): Promise<ExplainOutput> {
  const problems: string[] = [];
  requireString(selector, "selector", problems);
  assertValid("explain input", problems);
  const loaded = await loadRepositoryFacts(repo, options);
  if (loaded.failure) {
    throw invalidInput(`The corpus does not compile: ${loaded.failure.problems.join(" | ")}`, {
      problems: loaded.failure.problems,
    });
  }
  const facts = loaded.facts as RepositoryFacts;
  const query = queryRelationshipGraph(facts.graph, selector);
  return { query, explanation: explainRelationshipQuery(query, facts.graph), graph: facts.graph };
}

// ── plan ─────────────────────────────────────────────────────────────────────

export interface PlanOptions extends RepositoryFactsOptions {
  lane?: string;
  /** Full required CI command; defaults to the blocking test lane's command,
   * which is a repository fact the core returns but never executes. */
  fullCiCommand?: string;
}

function loadMappings(content: string | null, facts: RepositoryFacts): ImpactMappingSet {
  if (content === null) {
    return {
      schema: IMPACT_MAPPING_SCHEMA,
      identity: "impact-mappings:none",
      product_revision: facts.revision,
      mappings: [],
    };
  }
  const raw = parseRepositoryYaml(content, IMPACT_MAPPINGS_PATH);
  const problems: string[] = [];
  if (!requireRecord(raw, "impactMappings", problems)) assertValid("impact mappings", problems);
  const mapping = raw as Record<string, unknown>;
  if (mapping.schema !== IMPACT_MAPPING_SCHEMA) {
    throw unsupportedSchemaMajor(String(mapping.schema), [IMPACT_MAPPING_SCHEMA]);
  }
  requireString(mapping.identity, "impactMappings.identity", problems);
  requireString(mapping.product_revision, "impactMappings.product_revision", problems);
  if (requireArray(mapping.mappings, "impactMappings.mappings", problems)) {
    mapping.mappings.forEach((item, index) => {
      const path = `impactMappings.mappings[${index}]`;
      if (!requireRecord(item, path, problems)) return;
      requireString(item.id, `${path}.id`, problems);
      if (item.path_pattern !== undefined) requireString(item.path_pattern, `${path}.path_pattern`, problems);
      if (item.symbol !== undefined) requireString(item.symbol, `${path}.symbol`, problems);
      if (item.path_pattern === undefined && item.symbol === undefined) {
        problems.push(`${path} must declare path_pattern or symbol`);
      }
      requireStringArray(item.structure_ids, `${path}.structure_ids`, problems);
      requireEnum(item.confidence, `${path}.confidence`, ["exact", "uncertain", "unknown"] as const, problems);
    });
  }
  assertValid("impact mappings", problems);
  return mapping as unknown as ImpactMappingSet;
}

function toChangedInputs(changed: readonly (string | ChangedInput)[]): ChangedInput[] {
  return changed.map((item, index) => {
    if (typeof item === "string") {
      const problems: string[] = [];
      requireSafePath(item, `changed[${index}]`, problems);
      assertValid("changed paths", problems);
      return { id: `CHG-${index + 1}`, path: item, kind: "content" as const };
    }
    const problems: string[] = [];
    const path = `changed[${index}]`;
    if (!requireRecord(item, path, problems)) {
      assertValid("changed inputs", problems);
    }
    const value = item as unknown as Record<string, unknown>;
    requireString(value.id, `${path}.id`, problems);
    requireEnum(value.kind, `${path}.kind`, ["content", "structural"] as const, problems);
    if (value.path !== undefined) requireSafePath(value.path, `${path}.path`, problems);
    if (value.symbol !== undefined) requireString(value.symbol, `${path}.symbol`, problems);
    if (value.path === undefined && value.symbol === undefined) {
      problems.push(`${path} must declare a path or symbol`);
    }
    assertValid("changed inputs", problems);
    return {
      id: value.id as string,
      kind: value.kind as ChangedInput["kind"],
      ...(value.path !== undefined ? { path: value.path as string } : {}),
      ...(value.symbol !== undefined ? { symbol: value.symbol as string } : {}),
    };
  });
}

/**
 * Explained plan for a changed-path set. `plan(repo, [])` is the supported
 * environment/full-suite question. Unknown or ambiguous mappings expand to the
 * full applicable suite; the full required CI remains authoritative.
 */
export async function plan(
  repo: RepositoryPort,
  changed: readonly (string | ChangedInput)[],
  options: PlanOptions = {},
): Promise<ExplainedImpactPlan> {
  if (!Array.isArray(changed)) throw invalidInput("changed must be an array of paths or ChangedInput objects");
  const loaded = await loadRepositoryFacts(repo, options);
  if (loaded.failure) {
    throw invalidInput(`The corpus does not compile: ${loaded.failure.problems.join(" | ")}`, {
      problems: loaded.failure.problems,
    });
  }
  const facts = loaded.facts as RepositoryFacts;
  const lane = defaultLane(facts, options.lane);
  const laneCommand = facts.model.policy.lanes.find((item) => item.id === lane)?.command;
  const fullCiCommand = options.fullCiCommand ?? laneCommand;
  if (!fullCiCommand) {
    throw invalidInput(
      `Lane ${lane} declares no command and options.fullCiCommand was not supplied; the plan cannot name its authoritative full run.`,
      { lane },
    );
  }
  const mappings = loadMappings(await repo.readFile(IMPACT_MAPPINGS_PATH), facts);
  return validatePlan(planChangedImpact({
    model: facts.model,
    graph: facts.graph,
    inventory: facts.inventory,
    mappings,
    changed_inputs: toChangedInputs(changed),
    lane,
    full_ci_command: fullCiCommand,
  }));
}

// ── ingest ───────────────────────────────────────────────────────────────────

export type IngestInput =
  | { kind: "validation-result"; value: unknown }
  | { kind: "relationship-trace"; graph: RelationshipGraph }
  | { kind: "startup-conformance"; run: StartupConformanceRun; successRootId: string }
  | { kind: "bootstrap-failure"; envelope: BootstrapFailureEnvelope };

const GRAPH_NODE_KINDS = ["owner", "source", "structure", "family", "control", "ticket", "test", "evidence"] as const;
const GRAPH_EDGE_TYPES = ["owns", "provenance", "protects", "implemented-by", "produces", "controlled-by", "delivered-by"] as const;
const GRAPH_FINDING_LEVELS = ["red", "unresolved", "partial"] as const;

function validateRelationshipGraphInput(value: unknown, path: string, problems: string[]): value is RelationshipGraph {
  if (!requireRecord(value, path, problems)) return false;
  if (value.schema !== "validation-architect/relationship-graph/v1") {
    problems.push(`${path}.schema must be validation-architect/relationship-graph/v1`);
  }
  if (!requireRecord(value.identity, `${path}.identity`, problems)) return false;
  const identity = value.identity;
  for (const key of ["model_identity", "product_revision", "environment", "inventory_identity", "evidence_identity", "graph_identity"]) {
    requireString(identity[key], `${path}.identity.${key}`, problems);
  }
  requireRecord(identity.versions, `${path}.identity.versions`, problems);

  const nodeIds = new Set<string>();
  let hasFamily = false;
  if (requireArray(value.nodes, `${path}.nodes`, problems)) {
    value.nodes.forEach((node, index) => {
      const nodePath = `${path}.nodes[${index}]`;
      if (!requireRecord(node, nodePath, problems)) return;
      if (requireString(node.id, `${nodePath}.id`, problems)) {
        if (nodeIds.has(node.id)) problems.push(`${nodePath}.id duplicates ${node.id}`);
        nodeIds.add(node.id);
      }
      if (requireEnum(node.kind, `${nodePath}.kind`, GRAPH_NODE_KINDS, problems) && node.kind === "family") {
        hasFamily = true;
      }
      requireString(node.meaning, `${nodePath}.meaning`, problems);
      if (node.path !== undefined) requireSafePath(node.path, `${nodePath}.path`, problems);
      if (node.owner_id !== undefined) requireString(node.owner_id, `${nodePath}.owner_id`, problems);
      if (node.state !== undefined) {
        requireEnum(node.state, `${nodePath}.state`, ["complete", "incomplete", "inconclusive", "unobserved"] as const, problems);
      }
      requireRecord(node.details, `${nodePath}.details`, problems);
    });
  }
  if (!hasFamily) problems.push(`${path}.nodes must include at least one validation family`);

  if (requireArray(value.edges, `${path}.edges`, problems)) {
    value.edges.forEach((edge, index) => {
      const edgePath = `${path}.edges[${index}]`;
      if (!requireRecord(edge, edgePath, problems)) return;
      const from = requireString(edge.from, `${edgePath}.from`, problems) ? edge.from : undefined;
      const to = requireString(edge.to, `${edgePath}.to`, problems) ? edge.to : undefined;
      requireEnum(edge.type, `${edgePath}.type`, GRAPH_EDGE_TYPES, problems);
      if (from && !nodeIds.has(from)) problems.push(`${edgePath}.from cites missing node ${from}`);
      if (to && !nodeIds.has(to)) problems.push(`${edgePath}.to cites missing node ${to}`);
    });
  }

  let hasBlockingFinding = false;
  let findingCount = 0;
  if (requireArray(value.findings, `${path}.findings`, problems)) {
    findingCount = value.findings.length;
    value.findings.forEach((finding, index) => {
      const findingPath = `${path}.findings[${index}]`;
      if (!requireRecord(finding, findingPath, problems)) return;
      requireString(finding.code, `${findingPath}.code`, problems);
      if (requireEnum(finding.level, `${findingPath}.level`, GRAPH_FINDING_LEVELS, problems)) {
        hasBlockingFinding ||= finding.level === "red" || finding.level === "unresolved";
      }
      requireString(finding.subject_id, `${findingPath}.subject_id`, problems);
      requireString(finding.message, `${findingPath}.message`, problems);
      requireString(finding.correction, `${findingPath}.correction`, problems);
    });
  }
  if (typeof value.structurally_closed !== "boolean" || value.structurally_closed === hasBlockingFinding) {
    problems.push(`${path}.structurally_closed must exactly reflect red/unresolved findings`);
  }
  if (typeof value.assurance_complete !== "boolean" || value.assurance_complete !== (findingCount === 0)) {
    problems.push(`${path}.assurance_complete must be true exactly when findings are empty`);
  }
  if (!requireRecord(value.check, `${path}.check`, problems)) return false;
  if (value.check.name !== "Validation Trace" || value.check.required_check_handoff !== true) {
    problems.push(`${path}.check must preserve the required Validation Trace handoff`);
  }

  const { graph_identity: _claimed, ...baseIdentity } = identity;
  const expectedIdentity = relationshipPayloadIdentity({
    ...baseIdentity,
    nodes: value.nodes,
    edges: value.edges,
    findings: value.findings,
  });
  if (identity.graph_identity !== expectedIdentity) {
    problems.push(`${path}.identity.graph_identity does not match the graph content`);
  }
  return problems.length === 0;
}

function validateContext(ctx: unknown): ResultMappingContext {
  const problems: string[] = [];
  if (!requireRecord(ctx, "ctx", problems)) assertValid("ingest context", problems);
  const record = ctx as Record<string, unknown>;
  if (!requireRecord(record.identity, "ctx.identity", problems)) assertValid("ingest context", problems);
  const identity = record.identity as Record<string, unknown>;
  requireString(identity.product_revision, "ctx.identity.product_revision", problems);
  requireString(identity.lane, "ctx.identity.lane", problems);
  requireString(identity.environment, "ctx.identity.environment", problems);
  if (requireRecord(identity.versions, "ctx.identity.versions", problems)) {
    for (const key of ["package", "method", "model", "compiler", "policy", "result", "golden_set"]) {
      requireString(identity.versions[key], `ctx.identity.versions.${key}`, problems);
    }
  }
  requireString(record.structure_id, "ctx.structure_id", problems);
  requireString(record.root_id, "ctx.root_id", problems);
  requireString(record.owner, "ctx.owner", problems);
  if (requireArray(record.evidence, "ctx.evidence", problems)) {
    const evidenceIds = new Set<string>();
    record.evidence.forEach((evidence, index) => {
      const evidencePath = `ctx.evidence[${index}]`;
      if (!requireRecord(evidence, evidencePath, problems)) return;
      if (requireString(evidence.id, `${evidencePath}.id`, problems)) {
        if (evidenceIds.has(evidence.id)) problems.push(`${evidencePath}.id duplicates ${evidence.id}`);
        evidenceIds.add(evidence.id);
      }
      requireEnum(evidence.kind, `${evidencePath}.kind`, ["artifact", "log", "probe", "result"] as const, problems);
      requireString(evidence.reference, `${evidencePath}.reference`, problems);
      if (requireRecord(evidence.integrity, `${evidencePath}.integrity`, problems)) {
        if (evidence.integrity.algorithm !== "sha256") problems.push(`${evidencePath}.integrity.algorithm must be sha256`);
        if (typeof evidence.integrity.digest !== "string" || !/^[a-f0-9]{64}$/.test(evidence.integrity.digest)) {
          problems.push(`${evidencePath}.integrity.digest must be a lowercase sha256 digest`);
        }
      }
    });
  }
  if (record.plan !== undefined) {
    if (requireRecord(record.plan, "ctx.plan", problems)) {
      for (const key of ["selected_scope", "expansions", "unresolved_mappings"]) {
        requireStringArray(record.plan[key], `ctx.plan.${key}`, problems);
      }
    }
  }
  assertValid("ingest context", problems);
  return ctx as ResultMappingContext;
}

function assertIdentityMatchesContext(result: ValidationResultV1, context: ResultMappingContext): void {
  if (relationshipPayloadIdentity(result.identity) !== relationshipPayloadIdentity(context.identity)) {
    throw invalidInput("ingested result identity does not match the supplied context identity", {
      expected: context.identity,
      actual: result.identity,
    });
  }
}

function validateStartupRun(run: unknown, problems: string[]): void {
  if (!requireRecord(run, "output.run", problems)) return;
  if (requireArray(run.capability_outcomes, "output.run.capability_outcomes", problems)) {
    run.capability_outcomes.forEach((outcome, index) => {
      const path = `output.run.capability_outcomes[${index}]`;
      if (!requireRecord(outcome, path, problems)) return;
      requireString(outcome.capability_id, `${path}.capability_id`, problems);
      if (requireEnum(outcome.status, `${path}.status`, ["available", "unavailable", "blocked"] as const, problems)) {
        if (outcome.status === "blocked") requireString(outcome.blocked_by, `${path}.blocked_by`, problems);
        else {
          requireString(outcome.summary, `${path}.summary`, problems);
          requireString(outcome.next_action, `${path}.next_action`, problems);
        }
      }
    });
  }
  if (requireArray(run.tests, "output.run.tests", problems)) {
    run.tests.forEach((test, index) => {
      const path = `output.run.tests[${index}]`;
      if (!requireRecord(test, path, problems)) return;
      requireString(test.id, `${path}.id`, problems);
      if (typeof test.started !== "boolean") problems.push(`${path}.started must be a boolean`);
      if (test.started === false) requireString(test.blocked_by, `${path}.blocked_by`, problems);
      if (test.started === true && test.blocked_by !== undefined) problems.push(`${path}.blocked_by is invalid for a started test`);
    });
  }
  requireStringArray(run.probe_starts, "output.run.probe_starts", problems);
  requireStringArray(run.test_starts, "output.run.test_starts", problems);
}

function validateBootstrapEnvelope(envelope: unknown, problems: string[]): void {
  if (!requireRecord(envelope, "output.envelope", problems)) return;
  requireEnum(envelope.stage, "output.envelope.stage", ["outer-launcher", "library-load", "test-framework-load"] as const, problems);
  requireString(envelope.code, "output.envelope.code", problems);
  requireString(envelope.message, "output.envelope.message", problems);
  requireString(envelope.next_action, "output.envelope.next_action", problems);
  requireStringArray(envelope.affected_case_ids, "output.envelope.affected_case_ids", problems);
  if (envelope.sensitive_values !== undefined) requireStringArray(envelope.sensitive_values, "output.envelope.sensitive_values", problems);
  if (envelope.details !== undefined) requireRecord(envelope.details, "output.envelope.details", problems);
}

/**
 * Normalize validated runner/prerequisite/trace evidence into the one public
 * result record. Raw output cannot create a pass by omission: every mapping
 * flows through the fail-closed result constructors and is re-validated.
 */
export function ingest(output: IngestInput, ctx: unknown): ValidationResultV1 {
  if (!isRecord(output) || typeof output.kind !== "string") {
    throw invalidInput('output must be a discriminated ingest input with a "kind"');
  }
  const context = validateContext(ctx);
  switch (output.kind) {
    case "validation-result": {
      const result = validateResult(output.value);
      assertIdentityMatchesContext(result, context);
      return result;
    }
    case "relationship-trace": {
      const problems: string[] = [];
      validateRelationshipGraphInput(output.graph, "output.graph", problems);
      if (isRecord(output.graph) && isRecord(output.graph.identity) && output.graph.identity.product_revision !== context.identity.product_revision) {
        problems.push("output.graph identity does not match ctx.identity.product_revision");
      }
      assertValid("relationship-trace ingest", problems);
      return validateResult(relationshipTraceToValidationResult(output.graph, context));
    }
    case "startup-conformance": {
      const problems: string[] = [];
      requireString(output.successRootId, "output.successRootId", problems);
      validateStartupRun(output.run, problems);
      assertValid("startup ingest", problems);
      const { root_id: _unusedRoot, ...rest } = context;
      return validateResult(
        startupRunToValidationResult(output.run, { ...rest, success_root_id: output.successRootId }),
      );
    }
    case "bootstrap-failure": {
      const problems: string[] = [];
      validateBootstrapEnvelope(output.envelope, problems);
      assertValid("bootstrap-failure ingest", problems);
      return validateResult(bootstrapFailureToValidationResult(output.envelope, context));
    }
    default:
      throw invalidInput(`Unknown ingest kind ${String((output as { kind: unknown }).kind)}`);
  }
}

// ── render ───────────────────────────────────────────────────────────────────

export interface RenderFacts {
  graph: RelationshipGraph;
  /** Structure, contract, family, test, evidence, or path selector. */
  selector: string;
  result?: ValidationResultV1;
  expansions?: readonly string[];
  unknowns?: readonly string[];
}

export const RENDER_VIEWS: readonly RelationshipViewRole[] = ["author", "architect", "reviewer", "operator"];

/**
 * Role prose generated from the same validated fact objects. Rendering adds
 * no new fact, status, or relationship: all four views project one graph and
 * one query identity.
 */
export function render(view: RelationshipViewRole, facts: RenderFacts): RelationshipRoleView {
  const problems: string[] = [];
  if (!RENDER_VIEWS.includes(view)) problems.push(`view must be one of [${RENDER_VIEWS.join(", ")}]`);
  if (!isRecord(facts)) problems.push("facts must be an object");
  else validateRelationshipGraphInput(facts.graph, "facts.graph", problems);
  if (typeof facts?.selector !== "string" || facts.selector.length === 0) {
    problems.push("facts.selector must name a structure, family, test, evidence item, or path");
  }
  if (facts?.result !== undefined) {
    const result = validateResult(facts.result);
    if (isRecord(facts.graph) && isRecord(facts.graph.identity)) {
      if (result.identity.product_revision !== facts.graph.identity.product_revision) {
        problems.push("facts.result revision must match facts.graph revision");
      }
      if (result.identity.environment !== facts.graph.identity.environment) {
        problems.push("facts.result environment must match facts.graph environment");
      }
    }
  }
  if (facts?.expansions !== undefined) requireStringArray(facts.expansions, "facts.expansions", problems);
  if (facts?.unknowns !== undefined) requireStringArray(facts.unknowns, "facts.unknowns", problems);
  assertValid("render input", problems);
  const query = queryRelationshipGraph(facts.graph, facts.selector);
  const views = generateRelationshipViews(facts.graph, query, {
    ...(facts.result ? { result: facts.result } : {}),
    ...(facts.expansions ? { author_expansions: facts.expansions } : {}),
    ...(facts.unknowns ? { author_unknowns: facts.unknowns } : {}),
  });
  const rendered = views[view];
  if (!rendered) throw invalidOutput(`View ${view} was not produced`);
  return rendered;
}

// ── migrate ──────────────────────────────────────────────────────────────────

export interface MigrateInput {
  kind: "legacy-catalog";
  catalogMarkdown: string;
  backlogMarkdown: string;
  /** The explicit human review; nothing is guessed from test code. */
  review: LegacyModelImportInput;
}

export interface MigrateOutput {
  to: typeof CORPUS_SCHEMA;
  /** New corpus files as unwritten data under validation-design/model/. */
  files: Array<{ path: string; content: string }>;
  evidence: {
    imported_family_ids: string[];
    review_evidence: string[];
    migration_ledger: LegacyMigrationLedger;
  };
}

/**
 * The deliberate, reviewable schema-major upgrade (VA-CORE-007). Ordinary
 * loads never mutate or upgrade; this function returns new data plus
 * migration evidence and never edits the source corpus.
 */
export function migrate(corpus: MigrateInput, to: string): MigrateOutput {
  if (to !== CORPUS_SCHEMA) throw unsupportedSchemaMajor(to, [CORPUS_SCHEMA]);
  if (!isRecord(corpus) || corpus.kind !== "legacy-catalog") {
    throw invalidInput('migrate supports the explicit "legacy-catalog" input; current-major corpora need no migration');
  }
  const problems: string[] = [];
  requireString(corpus.catalogMarkdown, "corpus.catalogMarkdown", problems);
  requireString(corpus.backlogMarkdown, "corpus.backlogMarkdown", problems);
  if (!isRecord(corpus.review)) problems.push("corpus.review must carry the explicit reviewed mapping");
  assertValid("migrate input", problems);
  let imported: ReturnType<typeof importLegacyCatalog>;
  try {
    imported = importLegacyCatalog(corpus.catalogMarkdown, corpus.backlogMarkdown, corpus.review);
  } catch (error) {
    throw invalidInput(`legacy corpus cannot be migrated: ${(error as Error).message}`);
  }
  return {
    to: CORPUS_SCHEMA,
    files: Object.entries(imported.files).map(([file, content]) => ({
      path: `${DESIGN_ROOT}/model/${file}`,
      content,
    })),
    evidence: {
      imported_family_ids: imported.imported_family_ids,
      review_evidence: imported.review_evidence,
      migration_ledger: imported.migration_ledger,
    },
  };
}
