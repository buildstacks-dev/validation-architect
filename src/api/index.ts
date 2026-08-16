/**
 * The supported public surface of the core package (VA-API-002 + VA-API-003).
 * Importing this module performs no effect: no file, socket, subprocess,
 * credential, or provider SDK is touched. The nine entry points are the seven
 * deterministic functions below plus provider-neutral `design`/`resume`.
 */

// The three injected ports and turn contracts (D2).
export type {
  RepositoryPort,
  TurnPort,
  TurnRequest,
  TurnResult,
  TurnLimits,
  TurnMetadata,
  TurnUsageReport,
  ExecutionIdentity,
  Seat,
  SeatRef,
  IndependenceDimension,
  IndependenceRequirement,
  SessionRequest,
  JsonSchema,
} from "./ports.js";
export {
  SEATS,
  INDEPENDENCE_DIMENSIONS,
  TURN_RESULT_STATUSES,
  validateTurnRequest,
  validateTurnResult,
  validateSeatRef,
  validateExecutionIdentity,
} from "./ports.js";

// Campaign contracts: envelope, checkpoint, provenance, bundle (D2/D7).
export type {
  CampaignStorePort,
  CampaignEnvelope,
  CampaignCheckpoint,
  EnvelopeSeat,
  EnvelopeTransition,
  TurnReceipt,
  Provenance,
  ProfileTier,
  ProfileAssessment,
  PublicAuditVerdict,
  AuditFindingRecord,
  BundleAudit,
  DesignBundle,
  DesignOutcome,
  IncompleteReason,
} from "./campaign-contracts.js";
export {
  PROFILE_TIERS,
  validateEnvelope,
  validateCheckpoint,
  validateProvenance,
  validateDesignBundle,
} from "./campaign-contracts.js";

// Published schema families (D8) and runtime validators.
export {
  PUBLISHED_SCHEMA_IDS,
  CORPUS_SCHEMA,
  CASE_CATALOG_SCHEMA,
  RESULT_SCHEMA,
  PLAN_SCHEMA,
  DESIGN_RUN_SCHEMA,
  PROVENANCE_SCHEMA,
  validateCorpus,
  validateCaseCatalog,
  canonicalCaseCatalog,
  validateResult,
  parseResult,
  canonicalResult,
  validatePlan,
  canonicalPlan,
  validateDesignRunEnvelope,
  validateDesignRunCheckpoint,
  parseDesignRunCheckpoint,
  canonicalCheckpoint,
  validateProvenanceRecord,
  canonicalProvenance,
  canonicalJson,
  schemaAssetFile,
  assertSupportedSchema,
} from "./schemas.js";

// Typed failure taxonomy with stable discriminants.
export { PublicContractError, isPublicContractError, type PublicErrorCode } from "./errors.js";

// Conformance fakes for host development and offline tests.
export { FakeRepositoryPort, ScriptedTurnPort, InMemoryCampaignStore, okTurn, type ScriptedTurn } from "./conformance.js";

// The seven deterministic entry points (D3).
export {
  compile,
  check,
  explain,
  plan,
  ingest,
  render,
  migrate,
  RENDER_VIEWS,
  IMPACT_MAPPINGS_PATH,
  type CompileOutput,
  type CheckOptions,
  type ExplainOutput,
  type PlanOptions,
  type IngestInput,
  type RenderFacts,
  type MigrateInput,
  type MigrateOutput,
} from "./entry-points.js";
export { DESIGN_ROOT, SPEC_SUFFIXES, type RepositoryFactsOptions } from "./repository-facts.js";

// Provider-neutral campaign orchestration (D2/D7): the eighth and ninth
// entry points. Turns are spent only through the host's injected TurnPort.
export {
  design,
  resume,
  buildEnvelope,
  DESIGNER_OUTPUT_SCHEMA,
  STAKEHOLDER_OUTPUT_SCHEMA,
  AUDITOR_OUTPUT_SCHEMA,
  READER_OUTPUT_SCHEMA,
  type DesignRequest,
  type DesignPorts,
} from "./campaign-engine.js";

// Re-exported public data contracts whose meaning is owned by Core issues.
export type { ValidationResultV1, ResultEvidenceReference, ResultIdentity, ResultPlan } from "../validation-result.js";
export { isGreenValidationResult } from "../validation-result.js";
export type { ExplainedImpactPlan, ChangedInput, ImpactCommand, ImpactMappingSet } from "../impact.js";
export type { RelationshipGraph, RelationshipQuery } from "../relationship-graph.js";
export type { RelationshipRoleView, RelationshipViewRole } from "../relationship-views.js";
export type { CaseCatalogManifest } from "../catalog.js";
export type { CompiledDesignModel, TestInventory } from "../model.js";
export type {
  LegacyFamilyMigrationEntry,
  LegacyFamilyOutputReview,
  LegacyFamilyReview,
  LegacyMigrationLane,
  LegacyMigrationLedger,
  LegacyModelImportInput,
  LegacyTicketMigrationEntry,
  LegacyTicketOutputReview,
  LegacyTicketReview,
} from "../legacy-model-import.js";
export type { ResultMappingContext } from "../result-adapters.js";
export type { CanonicalCompilerReport, CompilerReportRecord } from "../compiler-report.js";
