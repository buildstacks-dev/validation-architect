import type {
  EvidenceDeclaration,
  ModelFileSet,
  ModelOwner,
  ModelSource,
  NegativeControl,
  ProductIdentity,
  ProductStructure,
  ValidationLayerId,
  ValidationPolicy,
} from "./model.js";

/** Exact lane id from the reviewed target policy. */
export type LegacyMigrationLane = string;

export interface LegacyFamilyOutputReview {
  /** Exact current-model identity. One output must retain the legacy id. */
  id: string;
  layer: ValidationLayerId;
  lane: LegacyMigrationLane;
  owner: string;
  structure_ids: string[];
  source_ids: string[];
  /** Exact reviewed actionable ticket identity, when the family owns work. */
  ticket?: string;
  control?: Omit<NegativeControl, "family_id">;
  planned_tests?: string[];
  evidence?: EvidenceDeclaration;
}

export interface LegacyFamilyReview {
  title: string;
  meaning: string;
  structure_ids: string[];
  owner: string;
  source_ids: string[];
  control?: Omit<NegativeControl, "family_id">;
  planned_tests?: string[];
  exclusions?: string[];
  /**
   * Explicit clean-break normalization for composite legacy placement. The
   * importer never parses composite layer prose into current-model meaning.
   * Shared meaning, ownership, provenance, structures, and exclusions remain
   * those reviewed above; placement, implementation, control, and ticket are
   * reviewed per output.
   */
  outputs?: LegacyFamilyOutputReview[];
}

export interface LegacyTicketOutputReview {
  /** Exact current-model identity. One output must retain the legacy id. */
  id: string;
  title: string;
  owner: string;
  executor: string;
  lane: LegacyMigrationLane;
  layer: ValidationLayerId;
  acceptance_criteria: string[];
  family_ids: string[];
}

export interface LegacyTicketReview {
  /** Existing one-ticket form for already-canonical legacy work. */
  executor?: string;
  acceptance_criteria?: string[];
  /** Explicit split for work that crosses a current-model layer or lane. */
  outputs?: LegacyTicketOutputReview[];
  /** Legacy tickets with no first-owned family are historical, not actionable. */
  historical?: { reason: string };
}

export interface LegacyModelImportInput {
  product: ProductIdentity;
  inner_loop_command: string;
  owners: ModelOwner[];
  sources: ModelSource[];
  structures: ProductStructure[];
  /** Complete reviewed target policy; omit only for the canonical legacy fallback. */
  policy?: ValidationPolicy;
  families: Record<string, LegacyFamilyReview>;
  ticket_reviews: Record<string, LegacyTicketReview>;
}

export interface LegacyFamilyMigrationEntry {
  legacy_id: string;
  output_ids: string[];
}

export interface LegacyTicketMigrationEntry {
  legacy_id: string;
  disposition: "actionable" | "historical";
  /** Every family citation parsed from the legacy ticket body. */
  legacy_family_ids: string[];
  /** The subset for which this was the legacy manifest's first owning ticket. */
  owned_legacy_family_ids: string[];
  output_ids: string[];
  reason?: string;
}

export interface LegacyMigrationLedger {
  families: LegacyFamilyMigrationEntry[];
  tickets: LegacyTicketMigrationEntry[];
}

export interface LegacyModelImportResult {
  files: ModelFileSet;
  imported_family_ids: string[];
  review_evidence: string[];
  migration_ledger: LegacyMigrationLedger;
}
