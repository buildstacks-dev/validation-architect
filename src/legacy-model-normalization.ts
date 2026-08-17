import type { CaseCatalogManifest, CatalogFamily, CatalogTicket } from "./catalog.js";
import type {
  BacklogTicket,
  EvidenceDeclaration,
  NegativeControl,
  TicketStatus,
  ValidationFamily,
  ValidationLayerId,
} from "./model.js";
import type {
  LegacyFamilyMigrationEntry,
  LegacyFamilyReview,
  LegacyMigrationLane,
  LegacyMigrationLedger,
  LegacyModelImportInput,
  LegacyTicketMigrationEntry,
  LegacyTicketOutputReview,
} from "./legacy-model-contracts.js";

const LAYERS: readonly ValidationLayerId[] = ["L1", "L2", "L3", "L4", "L5", "L6"];
const TICKET_STATUSES: readonly TicketStatus[] = ["pending", "landed", "blocked", "parked"];
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const isLayer = (value: unknown): value is ValidationLayerId =>
  typeof value === "string" && LAYERS.includes(value as ValidationLayerId);
const isLane = (value: unknown): value is LegacyMigrationLane => nonEmpty(value);
type LaneKind = "test" | "evidence";

interface ResolvedFamilyPlacement {
  id: string;
  layer?: ValidationLayerId;
  lane: LegacyMigrationLane;
  owner: string;
  structure_ids: string[];
  source_ids: string[];
  oracle?: string;
  risk?: string;
  ticket?: string;
  control?: Omit<NegativeControl, "family_id">;
  planned_tests?: string[];
  evidence?: EvidenceDeclaration;
}

export interface NormalizedLegacyModel {
  families: ValidationFamily[];
  controls: NegativeControl[];
  tickets: BacklogTicket[];
  migration_ledger: LegacyMigrationLedger;
}

function reviewedLaneKinds(input: LegacyModelImportInput): ReadonlyMap<string, LaneKind> {
  if (input.policy) return new Map(input.policy.lanes.map((lane) => [lane.id, lane.kind]));
  return new Map<string, LaneKind>([
    ["inner-loop", "test"],
    ["per-commit", "test"],
    ["triggered", "evidence"],
  ]);
}

function reviewedLayer(value: string | undefined, familyId: string): ValidationLayerId | undefined {
  if (!value) return undefined;
  const normalized = value.startsWith("L") ? value : `L${value}`;
  if (!isLayer(normalized)) {
    throw new Error(
      `legacy family ${familyId} has ambiguous layer ${value}; supply families.${familyId}.outputs with explicit canonical L1-L6 placement`,
    );
  }
  return normalized;
}

function canonicalPlacement(legacy: CatalogFamily, reviewed: LegacyFamilyReview): ResolvedFamilyPlacement {
  const layer = reviewedLayer(legacy.layers, legacy.id);
  return {
    id: legacy.id,
    ...(layer ? { layer } : {}),
    lane: legacy.evidence_path ? "triggered" : "per-commit",
    owner: reviewed.owner,
    structure_ids: [...reviewed.structure_ids],
    source_ids: [...reviewed.source_ids],
    ...(legacy.ticket ? { ticket: legacy.ticket } : {}),
    ...(reviewed.control ? { control: reviewed.control } : {}),
    ...(reviewed.planned_tests ? { planned_tests: reviewed.planned_tests } : {}),
    ...(legacy.evidence_path && legacy.evidence_state
      ? { evidence: { path: legacy.evidence_path, state: legacy.evidence_state } }
      : {}),
  };
}

function reviewedPlacements(
  legacy: CatalogFamily,
  reviewed: LegacyFamilyReview,
  laneKinds: ReadonlyMap<string, LaneKind>,
): ResolvedFamilyPlacement[] {
  if (reviewed.outputs === undefined) return [canonicalPlacement(legacy, reviewed)];
  if (!Array.isArray(reviewed.outputs) || reviewed.outputs.length === 0) {
    throw new Error(`legacy family ${legacy.id} outputs must contain at least one explicit reviewed placement`);
  }
  if (reviewed.control || reviewed.planned_tests) {
    throw new Error(
      `legacy family ${legacy.id} mixes canonical control/planned_tests with outputs; put implementation and control data on each output`,
    );
  }
  if (reviewed.outputs.filter((output) => output.id === legacy.id).length !== 1) {
    throw new Error(`legacy family ${legacy.id} outputs must retain the legacy id exactly once`);
  }
  const placements = reviewed.outputs.map((output): ResolvedFamilyPlacement => {
    if (!nonEmpty(output.id)) throw new Error(`legacy family ${legacy.id} has an output without an id`);
    if (!isLayer(output.layer)) {
      throw new Error(`legacy family ${legacy.id} output ${output.id} needs one canonical L1-L6 layer`);
    }
    if (!isLane(output.lane)) {
      throw new Error(`legacy family ${legacy.id} output ${output.id} needs an exact reviewed lane id`);
    }
    for (const field of ["oracle", "risk"] as const) {
      if (output[field] !== undefined && !nonEmpty(output[field])) {
        throw new Error(`legacy family ${legacy.id} output ${output.id} needs a non-empty reviewed ${field}`);
      }
    }
    if (
      !nonEmpty(output.owner) ||
      !Array.isArray(output.structure_ids) ||
      output.structure_ids.length === 0 ||
      !output.structure_ids.every(nonEmpty) ||
      !Array.isArray(output.source_ids) ||
      output.source_ids.length === 0 ||
      !output.source_ids.every(nonEmpty)
    ) {
      throw new Error(
        `legacy family ${legacy.id} output ${output.id} needs exact reviewed ownership, structures, and provenance`,
      );
    }
    const laneKind = laneKinds.get(output.lane);
    if (!laneKind) {
      throw new Error(
        `legacy family ${legacy.id} output ${output.id} cites lane ${output.lane} absent from the reviewed target policy`,
      );
    }
    if (output.ticket !== undefined && !nonEmpty(output.ticket)) {
      throw new Error(`legacy family ${legacy.id} output ${output.id} has an empty ticket id`);
    }
    if (laneKind === "test" && output.evidence) {
      throw new Error(`legacy family ${legacy.id} output ${output.id} puts evidence on test lane ${output.lane}`);
    }
    if (laneKind === "evidence" && output.planned_tests) {
      throw new Error(
        `legacy family ${legacy.id} output ${output.id} puts planned_tests on evidence lane ${output.lane}`,
      );
    }
    return {
      id: output.id,
      layer: output.layer,
      lane: output.lane,
      owner: output.owner,
      structure_ids: [...output.structure_ids],
      source_ids: [...output.source_ids],
      ...(output.oracle !== undefined ? { oracle: output.oracle } : {}),
      ...(output.risk !== undefined ? { risk: output.risk } : {}),
      ...(output.ticket ? { ticket: output.ticket } : {}),
      ...(output.control ? { control: output.control } : {}),
      ...(output.planned_tests ? { planned_tests: output.planned_tests } : {}),
      ...(output.evidence ? { evidence: output.evidence } : {}),
    };
  });
  if (legacy.evidence_path && legacy.evidence_state) {
    const retained = placements.some((placement) => {
      const evidence = placement.evidence;
      if (!evidence) return false;
      return evidence.path === legacy.evidence_path && evidence.state === legacy.evidence_state;
    });
    if (!retained) {
      throw new Error(
        `legacy family ${legacy.id} outputs do not retain evidence ${legacy.evidence_state}:${legacy.evidence_path}`,
      );
    }
  }
  return placements;
}

function buildFamily(
  legacy: CatalogFamily,
  reviewed: LegacyFamilyReview,
  placement: ResolvedFamilyPlacement,
  laneKinds: ReadonlyMap<string, LaneKind>,
): ValidationFamily {
  const laneKind = laneKinds.get(placement.lane);
  if (!laneKind) {
    throw new Error(
      `legacy family ${legacy.id} output ${placement.id} cites lane ${placement.lane} absent from the reviewed target policy`,
    );
  }
  if (legacy.status === "implementable") {
    if (!placement.layer) {
      throw new Error(`legacy implementable family ${legacy.id} output ${placement.id} needs one canonical L1-L6 layer`);
    }
    if (!placement.ticket) {
      throw new Error(`legacy implementable family ${legacy.id} output ${placement.id} needs a reviewed ticket`);
    }
    if (!placement.control) {
      throw new Error(`legacy implementable family ${legacy.id} output ${placement.id} needs a reviewed negative control`);
    }
    if (laneKind === "test" && !placement.planned_tests?.length) {
      throw new Error(`legacy test family ${legacy.id} output ${placement.id} needs reviewed planned_tests`);
    }
    if (laneKind === "evidence" && !placement.evidence) {
      throw new Error(`legacy evidence family ${legacy.id} output ${placement.id} needs reviewed evidence`);
    }
  }
  if (legacy.ticket && !placement.ticket) {
    throw new Error(`legacy family ${legacy.id} output ${placement.id} drops owning ticket ${legacy.ticket}`);
  }
  const oracle = placement.oracle ?? legacy.oracle;
  const risk = placement.risk ?? legacy.risk;
  return {
    id: placement.id,
    title: reviewed.title,
    meaning: reviewed.meaning,
    structure_ids: [...placement.structure_ids],
    owner: placement.owner,
    source_ids: [...placement.source_ids],
    lane: placement.lane,
    status: legacy.status,
    ...(placement.layer ? { layer: placement.layer } : {}),
    ...(oracle !== undefined ? { oracle } : {}),
    ...(risk !== undefined ? { risk } : {}),
    ...(placement.control ? { control_ids: [placement.control.id] } : {}),
    ...(placement.ticket ? { ticket: placement.ticket } : {}),
    ...(placement.planned_tests ? { planned_tests: [...placement.planned_tests] } : {}),
    ...(placement.evidence ? { evidence: { ...placement.evidence } } : {}),
    ...(legacy.blocked_by ? { blocked_by: legacy.blocked_by } : {}),
    ...(legacy.reason ? { reason: legacy.reason } : {}),
    ...(reviewed.exclusions ? { exclusions: [...reviewed.exclusions] } : {}),
  };
}

function validateReviewKeys(
  kind: "family" | "ticket",
  expected: readonly string[],
  actual: Record<string, unknown>,
): void {
  const expectedIds = new Set(expected);
  const extras = Object.keys(actual).filter((id) => !expectedIds.has(id)).sort();
  if (extras.length > 0) throw new Error(`legacy ${kind} review contains unknown ids: ${extras.join(", ")}`);
}

function sameIds(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== new Set(actual).size || actual.length !== expected.length) return false;
  const expectedIds = new Set(expected);
  return actual.every((id) => expectedIds.has(id));
}

function addReviewedTicket(
  legacy: CatalogTicket,
  output: LegacyTicketOutputReview,
  families: ReadonlyMap<string, ValidationFamily>,
  laneKinds: ReadonlyMap<string, LaneKind>,
  ticketIds: Set<string>,
  tickets: BacklogTicket[],
): void {
  if (!nonEmpty(output.id)) throw new Error(`legacy ticket ${legacy.id} has an output without an id`);
  if (ticketIds.has(output.id)) throw new Error(`legacy ticket output id ${output.id} is duplicated`);
  if (!nonEmpty(output.title) || !nonEmpty(output.owner) || !nonEmpty(output.executor)) {
    throw new Error(`legacy ticket ${legacy.id} output ${output.id} needs a title, owner, and executor`);
  }
  if (!isLayer(output.layer) || !isLane(output.lane) || !laneKinds.has(output.lane)) {
    throw new Error(`legacy ticket ${legacy.id} output ${output.id} needs one canonical L1-L6 layer and lane`);
  }
  if (output.status !== undefined && !TICKET_STATUSES.includes(output.status)) {
    throw new Error(
      `legacy ticket ${legacy.id} output ${output.id} needs a canonical pending, landed, blocked, or parked status`,
    );
  }
  if (!Array.isArray(output.acceptance_criteria) || output.acceptance_criteria.length === 0) {
    throw new Error(`legacy ticket ${legacy.id} output ${output.id} needs acceptance criteria`);
  }
  if (!Array.isArray(output.family_ids) || output.family_ids.length === 0) {
    throw new Error(`legacy ticket ${legacy.id} output ${output.id} needs owned families`);
  }
  if (
    output.depends_on !== undefined &&
    (!Array.isArray(output.depends_on) || !output.depends_on.every(nonEmpty))
  ) {
    throw new Error(`legacy ticket ${legacy.id} output ${output.id} needs non-empty dependency ids`);
  }
  if (output.depends_on && new Set(output.depends_on).size !== output.depends_on.length) {
    throw new Error(`legacy ticket ${legacy.id} output ${output.id} has duplicate dependency ids`);
  }
  for (const id of output.family_ids) {
    const family = families.get(id);
    if (!family) throw new Error(`legacy ticket ${legacy.id} output ${output.id} cites unknown family ${id}`);
    if (family.ticket !== output.id) {
      throw new Error(
        `legacy ticket ${legacy.id} output ${output.id} claims ${id}, but that family points to ${family.ticket ?? "no ticket"}`,
      );
    }
    if (family.layer !== output.layer || family.lane !== output.lane) {
      throw new Error(`legacy ticket ${legacy.id} output ${output.id} crosses the reviewed layer or lane at ${id}`);
    }
    if (family.owner !== output.owner) {
      throw new Error(`legacy ticket ${legacy.id} output ${output.id} owner differs from family ${id}`);
    }
  }
  ticketIds.add(output.id);
  tickets.push({
    id: output.id,
    title: output.title,
    wave: legacy.wave,
    status: output.status ?? legacy.status,
    owner: output.owner,
    executor: output.executor,
    lane: output.lane,
    layer: output.layer,
    acceptance_criteria: [...output.acceptance_criteria],
    family_ids: [...output.family_ids],
    ...(output.depends_on ? { depends_on: [...output.depends_on] } : {}),
  });
}

export function normalizeLegacyManifest(
  manifest: CaseCatalogManifest,
  input: LegacyModelImportInput,
): NormalizedLegacyModel {
  validateReviewKeys("family", manifest.families.map((family) => family.id), input.families);
  validateReviewKeys("ticket", manifest.tickets.map((ticket) => ticket.id), input.ticket_reviews);
  const families: ValidationFamily[] = [];
  const controls: NegativeControl[] = [];
  const familyOutputs = new Map<string, ValidationFamily[]>();
  const familyIds = new Set<string>();
  const controlIds = new Set<string>();
  const familyLedger: LegacyFamilyMigrationEntry[] = [];
  const laneKinds = reviewedLaneKinds(input);

  for (const legacy of manifest.families) {
    const reviewed = input.families[legacy.id];
    if (!reviewed) throw new Error(`legacy family ${legacy.id} has no explicit reviewed mapping`);
    const outputs = reviewedPlacements(legacy, reviewed, laneKinds).map((placement) => {
      if (familyIds.has(placement.id)) throw new Error(`legacy family output id ${placement.id} is duplicated`);
      familyIds.add(placement.id);
      const family = buildFamily(legacy, reviewed, placement, laneKinds);
      if (placement.control) {
        if (!nonEmpty(placement.control.id)) {
          throw new Error(`legacy family ${legacy.id} output ${placement.id} has a negative control without an id`);
        }
        if (controlIds.has(placement.control.id)) {
          throw new Error(`legacy negative control id ${placement.control.id} is duplicated`);
        }
        controlIds.add(placement.control.id);
        controls.push({ ...placement.control, family_id: placement.id });
      }
      families.push(family);
      return family;
    });
    familyOutputs.set(legacy.id, outputs);
    familyLedger.push({ legacy_id: legacy.id, output_ids: outputs.map((family) => family.id).sort() });
  }

  const familyById = new Map(families.map((family) => [family.id, family]));
  const legacyFamilyById = new Map(manifest.families.map((family) => [family.id, family]));
  const tickets: BacklogTicket[] = [];
  const ticketIds = new Set<string>();
  const ticketLedger: LegacyTicketMigrationEntry[] = [];

  for (const legacy of manifest.tickets) {
    const reviewed = input.ticket_reviews[legacy.id];
    if (!reviewed) throw new Error(`legacy ticket ${legacy.id} has no explicit reviewed mapping`);
    if (Object.prototype.hasOwnProperty.call(reviewed, "status")) {
      throw new Error(
        `legacy ticket ${legacy.id} cannot override status in the compact review; put reviewed status on each explicit output`,
      );
    }
    const ownedLegacyFamilyIds = legacy.families.filter((id) => legacyFamilyById.get(id)?.ticket === legacy.id);
    const expectedFamilies = ownedLegacyFamilyIds.flatMap((id) => familyOutputs.get(id) ?? []);
    const expectedIds = expectedFamilies.map((family) => family.id);
    const ledgerBase = {
      legacy_id: legacy.id,
      legacy_family_ids: [...legacy.families].sort(),
      owned_legacy_family_ids: [...ownedLegacyFamilyIds].sort(),
    };
    if (ownedLegacyFamilyIds.length === 0) {
      if (!nonEmpty(reviewed.historical?.reason)) {
        throw new Error(
          `legacy ticket ${legacy.id} owns no families and needs an explicit historical disposition and reason`,
        );
      }
      if (
        reviewed.outputs !== undefined ||
        reviewed.executor ||
        reviewed.acceptance_criteria !== undefined ||
        reviewed.depends_on !== undefined
      ) {
        throw new Error(`legacy ticket ${legacy.id} owns no families and cannot emit actionable ticket outputs`);
      }
      ticketLedger.push({
        ...ledgerBase,
        disposition: "historical",
        output_ids: [],
        reason: reviewed.historical.reason,
      });
      continue;
    }
    if (reviewed.historical) {
      throw new Error(`legacy actionable ticket ${legacy.id} cannot be dispositioned as historical`);
    }
    if (reviewed.outputs !== undefined) {
      if (!Array.isArray(reviewed.outputs) || reviewed.outputs.length === 0) {
        throw new Error(`legacy ticket ${legacy.id} outputs must contain at least one explicit reviewed split`);
      }
      if (reviewed.executor || reviewed.acceptance_criteria !== undefined || reviewed.depends_on !== undefined) {
        throw new Error(
          `legacy ticket ${legacy.id} mixes the compact review form with explicit outputs; use exactly one form`,
        );
      }
      if (reviewed.outputs.filter((output) => output.id === legacy.id).length !== 1) {
        throw new Error(`legacy ticket ${legacy.id} outputs must retain the legacy id exactly once`);
      }
      const actualIds = reviewed.outputs.flatMap((output) => output.family_ids);
      if (!sameIds(actualIds, expectedIds)) {
        throw new Error(`legacy ticket ${legacy.id} outputs must account for every reviewed family output exactly once`);
      }
      for (const output of reviewed.outputs) {
        addReviewedTicket(legacy, output, familyById, laneKinds, ticketIds, tickets);
      }
      ticketLedger.push({
        ...ledgerBase,
        disposition: "actionable",
        output_ids: reviewed.outputs.map((output) => output.id).sort(),
      });
      continue;
    }
    const familyOwners = [...new Set(expectedFamilies.map((family) => family.owner))];
    const owner = familyOwners[0];
    if (!owner || familyOwners.length !== 1) {
      throw new Error(`legacy ticket ${legacy.id} spans multiple reviewed owners; supply explicit ticket outputs`);
    }
    if (!reviewed.executor || !reviewed.acceptance_criteria?.length) {
      throw new Error(`legacy ticket ${legacy.id} needs a reviewed executor and acceptance criteria`);
    }
    const lanes = [...new Set(expectedFamilies.map((family) => family.lane))];
    const layers = [...new Set(expectedFamilies.map((family) => family.layer).filter(isLayer))];
    const lane = lanes[0];
    const layer = layers[0];
    if (lanes.length !== 1 || layers.length !== 1 || !isLane(lane) || !layer) {
      throw new Error(`legacy ticket ${legacy.id} crosses a layer or lane; supply explicit ticket outputs`);
    }
    const output: LegacyTicketOutputReview = {
      id: legacy.id,
      title: legacy.name ?? legacy.id,
      owner,
      executor: reviewed.executor,
      lane,
      layer,
      acceptance_criteria: reviewed.acceptance_criteria,
      family_ids: expectedIds,
      ...(reviewed.depends_on !== undefined ? { depends_on: reviewed.depends_on } : {}),
    };
    addReviewedTicket(legacy, output, familyById, laneKinds, ticketIds, tickets);
    ticketLedger.push({ ...ledgerBase, disposition: "actionable", output_ids: [legacy.id] });
  }

  return {
    families,
    controls,
    tickets,
    migration_ledger: {
      families: familyLedger.sort((left, right) => left.legacy_id.localeCompare(right.legacy_id)),
      tickets: ticketLedger.sort((left, right) => left.legacy_id.localeCompare(right.legacy_id)),
    },
  };
}
