import type { CoreVersionBundle } from "./versions.js";

export const MODEL_DIRECTORY = "model";

export const MODEL_FILES = [
  "project.yaml",
  "owners.yaml",
  "sources.yaml",
  "structures.yaml",
  "policy.yaml",
  "controls.yaml",
  "families.yaml",
  "backlog.yaml",
] as const;

export type ModelFilename = (typeof MODEL_FILES)[number];
export type ModelFileSet = Record<ModelFilename, string>;

export const MODEL_FILE_SCHEMAS: Readonly<Record<ModelFilename, string>> = Object.freeze({
  "project.yaml": "validation-architect/model/project/v1",
  "owners.yaml": "validation-architect/model/owners/v1",
  "sources.yaml": "validation-architect/model/sources/v1",
  "structures.yaml": "validation-architect/model/structures/v1",
  "policy.yaml": "validation-architect/model/policy/v1",
  "controls.yaml": "validation-architect/model/controls/v1",
  "families.yaml": "validation-architect/model/families/v1",
  "backlog.yaml": "validation-architect/model/backlog/v1",
});

export type SourceKind = "doc" | "rambling" | "simulated" | "proposed";
export type StructureKind =
  | "journey"
  | "invariant"
  | "boundary"
  | "contract"
  | "interface"
  | "llm-site"
  | "operation";
export type FamilyStatus = "implementable" | "pruned" | "blocked";
export type TicketStatus = "pending" | "landed" | "blocked" | "parked";
export type EvidenceState = "complete" | "incomplete" | "inconclusive" | "unobserved";
export type CriticalityTier = "C0" | "C1" | "C2" | "C3" | "C4";
export type ValidationLayerId = "L1" | "L2" | "L3" | "L4" | "L5" | "L6";

export interface ProductIdentity {
  id: string;
  name: string;
  revision: string;
  intended_use: string;
  criticality: CriticalityTier;
  criticality_reason: string;
}

export interface ModelOwner {
  id: string;
  name: string;
  responsibility: string;
}

export interface ModelSource {
  id: string;
  kind: SourceKind;
  path?: string;
  locator?: string;
  quote?: string;
}

export interface ProductStructure {
  id: string;
  kind: StructureKind;
  title: string;
  meaning: string;
  owner: string;
  source_ids: string[];
  acceptance_criteria?: string[];
  /** Typed error-path clauses; required non-empty for contract structures. */
  error_criteria?: string[];
  failure_modes?: string[];
  changed_paths?: string[];
  criticality?: CriticalityTier;
  criticality_reason?: string;
}

export interface ValidationLayer {
  id: ValidationLayerId;
  title: string;
  status: "active" | "declared-empty";
  reason?: string;
}

export interface ValidationLane {
  id: string;
  title: string;
  kind: "test" | "evidence";
  status: "active" | "declared-empty";
  requirement: "blocking" | "advisory";
  triggers: string[];
  command?: string;
  /** Wall-clock budget in whole seconds; required for every active test lane.
   * A breached budget is a defect against the harness, filed like any red. */
  max_duration_seconds?: number;
  authorization?: "none" | "per-run-human";
  reason?: string;
}

export interface PolicyException {
  id: string;
  kind: "waiver" | "provisional";
  target: string;
  owner: string;
  reason: string;
  expires: string;
  value?: string;
}

export interface CoexistencePolicy {
  posture: "parallel-greenfield";
  isolated_root: string;
  protected_paths: string[];
  incumbent_gates: "read_only";
  ci_integration: "additive_opt_in";
  cutover_requires: string[];
}

export interface ValidationPolicy {
  default: "blocking";
  inheritance: "tighten-only";
  /** Journey structures designated as the always-green, must-run-on-merge
   * smoke path; the validator requires at least one, each covered by an
   * implementable per-commit family. */
  smoke_journey_ids?: string[];
  layers: ValidationLayer[];
  lanes: ValidationLane[];
  exceptions: PolicyException[];
  coexistence?: CoexistencePolicy;
}

export interface NegativeControl {
  id: string;
  title: string;
  family_id: string;
  owner: string;
  expected_failure: string;
}

export interface EvidenceDeclaration {
  state: EvidenceState;
  path: string;
}

export interface ValidationFamily {
  id: string;
  title: string;
  meaning: string;
  structure_ids: string[];
  owner: string;
  source_ids: string[];
  lane: string;
  status: FamilyStatus;
  layer?: ValidationLayerId;
  oracle?: string;
  risk?: string;
  control_ids?: string[];
  /** Declared failure modes this family covers or prunes, as
   * "<structure-id>#<mode>" references into the structure's failure_modes. */
  covers_failure_modes?: string[];
  ticket?: string;
  planned_tests?: string[];
  evidence?: EvidenceDeclaration;
  blocked_by?: string;
  reason?: string;
  exclusions?: string[];
}

export interface BacklogTicket {
  id: string;
  title: string;
  wave: string;
  status: TicketStatus;
  owner: string;
  executor: string;
  lane: string;
  layer: ValidationLayerId;
  acceptance_criteria: string[];
  family_ids: string[];
  depends_on?: string[];
}

export interface CompiledDesignModel {
  schema: string;
  product: ProductIdentity;
  versions: CoreVersionBundle;
  owners: ModelOwner[];
  sources: ModelSource[];
  structures: ProductStructure[];
  policy: ValidationPolicy;
  controls: NegativeControl[];
  families: ValidationFamily[];
  tickets: BacklogTicket[];
}

/** Runtime repository facts never become part of design authority. */
export interface TestInventory {
  kind: "test-inventory";
  revision: string;
  environment: string;
  tests_root?: string;
  tests_root_present?: boolean;
  tests: Array<{
    id: string;
    path: string;
    family_ids: string[];
    /** Negative controls implemented by this test. */
    control_ids?: string[];
    /** Host-supplied command; core returns it but never executes it. */
    command?: string;
    /** Safety checks selected for every impact plan. */
    always_run?: boolean;
    /** Adapter-observed executable declarations; zero is fail-closed. */
    case_count?: number;
  }>;
}

export interface InventoryDiagnostic {
  code:
    | "INVENTORY_KIND_INVALID"
    | "INVENTORY_REVISION_MISMATCH"
    | "INVENTORY_ENTRY_INVALID"
    | "INVENTORY_ID_DUPLICATE"
    | "INVENTORY_PATH_UNSAFE"
    | "INVENTORY_FAMILY_UNKNOWN"
    | "INVENTORY_CONTROL_UNKNOWN"
    | "INVENTORY_CONTROL_FAMILY_MISMATCH"
    | "CONTROL_UNIMPLEMENTED";
  test_id?: string;
  family_id?: string;
  message: string;
  correction: string;
}

/** A derived join. Neither side is copied into or allowed to redefine the other. */
export interface DesignInventoryJoin {
  accepted: boolean;
  revision: string;
  diagnostics: InventoryDiagnostic[];
  links: Array<{
    family_id: string;
    test_ids: string[];
    test_paths: string[];
  }>;
  unimplemented_family_ids: string[];
  /** Declared controls of implementable test-lane families that no valid
   * inventory test implements, regardless of owner-ticket status. */
  unimplemented_control_ids: string[];
}

/** Run evidence is bound to one revision/environment and remains separate. */
export interface ValidationEvidenceSet {
  kind: "validation-evidence";
  revision: string;
  environment: string;
  items: Array<{
    id: string;
    family_ids: string[];
    state: EvidenceState;
    path: string;
    integrity: string;
    /** Structural artifacts prove linkage only; run evidence may support a lane result. */
    scope?: "structural" | "run";
  }>;
}

export interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

export interface CompilerDiagnostic {
  code: string;
  severity: "error" | "warning";
  concept: string;
  location: SourceLocation;
  message: string;
  correction: string;
}

export interface CompiledModelBundle {
  accepted: boolean;
  diagnostics: CompilerDiagnostic[];
  model?: CompiledDesignModel;
  canonical_model?: string;
  generated_views: Record<string, string>;
  identity?: string;
}
