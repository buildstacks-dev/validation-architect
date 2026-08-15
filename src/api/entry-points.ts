/**
 * The seven deterministic public entry points (VA-API-003, contract D3).
 * Every function is a pure function of the corpus plus repository facts read
 * through RepositoryPort: no filesystem, Git, network, process, provider, or
 * publication effect. Identical validated facts produce identical data.
 */

import { createHash } from "node:crypto";
import { importLegacyCatalog, type LegacyModelImportInput } from "../legacy-model-import.js";
import type { CompilerDiagnostic } from "../model.js";
import {
  IMPACT_MAPPING_SCHEMA,
  planChangedImpact,
  type ChangedInput,
  type ExplainedImpactPlan,
  type ImpactMappingSet,
} from "../impact.js";
import { queryRelationshipGraph, type RelationshipGraph, type RelationshipQuery } from "../relationship-graph.js";
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
import { CORPUS_SCHEMA, parseRepositoryYaml, validateResult } from "./schemas.js";
import { assertValid, isRecord, requireRecord, requireSafePath, requireString } from "./validate.js";

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
      product_revision: facts.model.product.revision,
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
      product_revision: facts.model.product.revision,
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
    return item;
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
  return planChangedImpact({
    model: facts.model,
    graph: facts.graph,
    inventory: facts.inventory,
    mappings,
    changed_inputs: toChangedInputs(changed),
    lane,
    full_ci_command: fullCiCommand,
  });
}

// ── ingest ───────────────────────────────────────────────────────────────────

export type IngestInput =
  | { kind: "validation-result"; value: unknown }
  | { kind: "relationship-trace"; graph: RelationshipGraph }
  | { kind: "startup-conformance"; run: StartupConformanceRun; successRootId: string }
  | { kind: "bootstrap-failure"; envelope: BootstrapFailureEnvelope };

function validateContext(ctx: unknown): ResultMappingContext {
  const problems: string[] = [];
  if (!requireRecord(ctx, "ctx", problems)) assertValid("ingest context", problems);
  const record = ctx as Record<string, unknown>;
  if (!requireRecord(record.identity, "ctx.identity", problems)) assertValid("ingest context", problems);
  const identity = record.identity as Record<string, unknown>;
  requireString(identity.product_revision, "ctx.identity.product_revision", problems);
  requireString(identity.lane, "ctx.identity.lane", problems);
  requireString(identity.environment, "ctx.identity.environment", problems);
  if (!isRecord(identity.versions)) problems.push("ctx.identity.versions must be the version bundle");
  requireString(record.structure_id, "ctx.structure_id", problems);
  requireString(record.root_id, "ctx.root_id", problems);
  requireString(record.owner, "ctx.owner", problems);
  if (!Array.isArray(record.evidence)) problems.push("ctx.evidence must be an array of evidence references");
  assertValid("ingest context", problems);
  return ctx as ResultMappingContext;
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
    case "validation-result":
      return validateResult(output.value);
    case "relationship-trace": {
      if (!isRecord(output.graph) || !isRecord(output.graph.identity)) {
        throw invalidInput("relationship-trace ingest requires the graph produced by check/explain");
      }
      return validateResult(relationshipTraceToValidationResult(output.graph as RelationshipGraph, context));
    }
    case "startup-conformance": {
      const problems: string[] = [];
      requireString(output.successRootId, "output.successRootId", problems);
      if (!isRecord(output.run) || !Array.isArray((output.run as Record<string, unknown>).capability_outcomes)) {
        problems.push("output.run must be a StartupConformanceRun");
      }
      assertValid("startup ingest", problems);
      const { root_id: _unusedRoot, ...rest } = context;
      return validateResult(
        startupRunToValidationResult(output.run, { ...rest, success_root_id: output.successRootId }),
      );
    }
    case "bootstrap-failure": {
      if (!isRecord(output.envelope) || typeof output.envelope.message !== "string") {
        problemsForBootstrap();
      }
      return validateResult(bootstrapFailureToValidationResult(output.envelope, context));
    }
    default:
      throw invalidInput(`Unknown ingest kind ${String((output as { kind: unknown }).kind)}`);
  }
}

function problemsForBootstrap(): never {
  throw invalidInput("bootstrap-failure ingest requires a BootstrapFailureEnvelope with stage/code/message");
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
  if (!isRecord(facts) || !isRecord(facts.graph) || !isRecord((facts.graph as { identity?: unknown }).identity)) {
    problems.push("facts.graph must be a relationship graph from check/explain");
  }
  if (typeof facts?.selector !== "string" || facts.selector.length === 0) {
    problems.push("facts.selector must name a structure, family, test, evidence item, or path");
  }
  if (facts?.result !== undefined) validateResult(facts.result);
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
  evidence: { imported_family_ids: string[]; review_evidence: string[] };
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
    },
  };
}
