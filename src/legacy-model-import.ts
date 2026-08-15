import { stringify } from "yaml";
import { generateManifest } from "./catalog.js";
import {
  MODEL_FILE_SCHEMAS,
  type ModelFileSet,
  type ModelOwner,
  type ModelSource,
  type NegativeControl,
  type ProductIdentity,
  type ProductStructure,
} from "./model.js";
import { CURRENT_CORE_VERSIONS } from "./versions.js";

export interface LegacyFamilyReview {
  title: string;
  meaning: string;
  structure_ids: string[];
  owner: string;
  source_ids: string[];
  control?: Omit<NegativeControl, "family_id">;
  planned_tests?: string[];
  exclusions?: string[];
}

export interface LegacyModelImportInput {
  product: ProductIdentity;
  inner_loop_command: string;
  owners: ModelOwner[];
  sources: ModelSource[];
  structures: ProductStructure[];
  families: Record<string, LegacyFamilyReview>;
  ticket_reviews: Record<string, { executor: string; acceptance_criteria: string[] }>;
}

export interface LegacyModelImportResult {
  files: ModelFileSet;
  imported_family_ids: string[];
  review_evidence: string[];
}

const asYaml = (value: unknown): string => stringify(value, { lineWidth: 0 });

function reviewedLayer(value: string | undefined, familyId: string): `L${1 | 2 | 3 | 4 | 5 | 6}` | undefined {
  if (!value) return undefined;
  const normalized = value.startsWith("L") ? value : `L${value}`;
  if (!["L1", "L2", "L3", "L4", "L5", "L6"].includes(normalized)) {
    throw new Error(`legacy family ${familyId} has ambiguous layer ${value}; assign one canonical L1-L6 layer explicitly`);
  }
  return normalized as `L${1 | 2 | 3 | 4 | 5 | 6}`;
}

/**
 * Explicit clean-break import. Legacy Markdown supplies only facts it
 * actually encoded; the caller must review and provide meaning, ownership,
 * structures, provenance, controls, and planned implementation. Nothing is
 * guessed from test code or silently accepted as current authority.
 */
export function importLegacyCatalog(
  catalogMarkdown: string,
  backlogMarkdown: string,
  input: LegacyModelImportInput,
): LegacyModelImportResult {
  const generated = generateManifest(catalogMarkdown, backlogMarkdown, { product: input.product.id });
  if (generated.problems.length > 0) {
    throw new Error(`legacy catalog cannot be imported: ${generated.problems.join("; ")}`);
  }
  const families = generated.manifest.families.map((legacy) => {
    const reviewed = input.families[legacy.id];
    if (!reviewed) throw new Error(`legacy family ${legacy.id} has no explicit reviewed mapping`);
    if (legacy.status === "implementable" && !legacy.evidence_path && !reviewed.planned_tests?.length) {
      throw new Error(`legacy test family ${legacy.id} needs reviewed planned_tests`);
    }
    if (legacy.status === "implementable" && !reviewed.control) {
      throw new Error(`legacy implementable family ${legacy.id} needs a reviewed negative control`);
    }
    const layer = reviewedLayer(legacy.layers, legacy.id);
    return {
      id: legacy.id,
      title: reviewed.title,
      meaning: reviewed.meaning,
      structure_ids: reviewed.structure_ids,
      owner: reviewed.owner,
      source_ids: reviewed.source_ids,
      lane: legacy.evidence_path ? "triggered" : "per-commit",
      status: legacy.status,
      ...(layer ? { layer } : {}),
      ...(legacy.oracle ? { oracle: legacy.oracle } : {}),
      ...(legacy.risk ? { risk: legacy.risk } : {}),
      ...(reviewed.control ? { control_ids: [reviewed.control.id] } : {}),
      ...(legacy.ticket ? { ticket: legacy.ticket } : {}),
      ...(reviewed.planned_tests ? { planned_tests: reviewed.planned_tests } : {}),
      ...(legacy.evidence_path && legacy.evidence_state
        ? { evidence: { path: legacy.evidence_path, state: legacy.evidence_state } }
        : {}),
      ...(legacy.blocked_by ? { blocked_by: legacy.blocked_by } : {}),
      ...(legacy.reason ? { reason: legacy.reason } : {}),
      ...(reviewed.exclusions ? { exclusions: reviewed.exclusions } : {}),
    };
  });
  const controls = generated.manifest.families.flatMap((legacy) => {
    const reviewed = input.families[legacy.id];
    return reviewed?.control ? [{ ...reviewed.control, family_id: legacy.id }] : [];
  });
  const tickets = generated.manifest.tickets.map((legacy) => {
    const familyOwners = legacy.families.map((id) => input.families[id]?.owner).filter(Boolean) as string[];
    const owner = familyOwners[0];
    if (!owner) throw new Error(`legacy ticket ${legacy.id} has no reviewed family owner`);
    if (familyOwners.some((candidate) => candidate !== owner)) {
      throw new Error(`legacy ticket ${legacy.id} spans multiple reviewed owners; split or arbitrate it explicitly`);
    }
    const reviewed = input.ticket_reviews[legacy.id];
    if (!reviewed?.executor || !reviewed.acceptance_criteria.length) {
      throw new Error(`legacy ticket ${legacy.id} needs a reviewed executor and acceptance criteria`);
    }
    const ticketFamilies = legacy.families.map((id) => families.find((family) => family.id === id));
    const lanes = new Set(ticketFamilies.map((family) => family?.lane).filter(Boolean));
    const layers = new Set(ticketFamilies.map((family) => family?.layer).filter(Boolean));
    const lane = [...lanes][0];
    const layer = [...layers][0];
    if (lanes.size !== 1 || layers.size !== 1 || !lane || !layer) {
      throw new Error(`legacy ticket ${legacy.id} crosses a layer or lane; split it explicitly before import`);
    }
    return {
      id: legacy.id,
      title: legacy.name ?? legacy.id,
      wave: legacy.wave,
      status: legacy.status,
      owner,
      executor: reviewed.executor,
      lane,
      layer,
      acceptance_criteria: reviewed.acceptance_criteria,
      family_ids: legacy.families,
    };
  });
  const activeLayers = new Set<string>(
    families
      .map((family) => family.layer)
      .filter((layer): layer is Exclude<typeof layer, undefined> => layer !== undefined),
  );
  const layerTitles = [
    "Invariant and contract",
    "Hermetic system",
    "Live sandbox",
    "Eval qualification",
    "Ops hardening",
    "Outcome acceptance",
  ];
  const files: ModelFileSet = {
    "project.yaml": asYaml({
      schema: MODEL_FILE_SCHEMAS["project.yaml"],
      product: input.product,
      versions: CURRENT_CORE_VERSIONS,
    }),
    "owners.yaml": asYaml({ schema: MODEL_FILE_SCHEMAS["owners.yaml"], owners: input.owners }),
    "sources.yaml": asYaml({ schema: MODEL_FILE_SCHEMAS["sources.yaml"], sources: input.sources }),
    "structures.yaml": asYaml({
      schema: MODEL_FILE_SCHEMAS["structures.yaml"],
      structures: input.structures,
    }),
    "policy.yaml": asYaml({
      schema: MODEL_FILE_SCHEMAS["policy.yaml"],
      default: "blocking",
      inheritance: "tighten-only",
      layers: layerTitles.map((title, index) => {
        const id = `L${index + 1}`;
        return activeLayers.has(id)
          ? { id, title, status: "active" }
          : { id, title, status: "declared-empty", reason: "The reviewed legacy corpus has no family at this layer." };
      }),
      lanes: [
        { id: "inner-loop", title: "Reviewed legacy inner loop", kind: "test", status: "active", requirement: "blocking", triggers: ["before-push"], command: input.inner_loop_command },
        { id: "per-commit", title: "Reviewed legacy tests", kind: "test", status: "active", requirement: "blocking", triggers: ["per-commit"], command: input.inner_loop_command },
        {
          id: "triggered",
          title: "Reviewed legacy non-test evidence",
          kind: "evidence",
          status: families.some((family) => family.lane === "triggered") ? "active" : "declared-empty",
          requirement: "blocking",
          triggers: families.some((family) => family.lane === "triggered") ? ["explicit-authorization"] : [],
          authorization: "per-run-human",
          ...(!families.some((family) => family.lane === "triggered")
            ? { reason: "The reviewed legacy corpus declares no non-test evidence family." }
            : {}),
        },
        { id: "release", title: "Release evidence", kind: "evidence", status: "declared-empty", requirement: "blocking", triggers: [], reason: "The reviewed legacy corpus declares no separate release lane." },
        { id: "scheduled", title: "Scheduled evidence", kind: "evidence", status: "declared-empty", requirement: "blocking", triggers: [], reason: "The reviewed legacy corpus declares no scheduled lane." },
      ],
      exceptions: [],
    }),
    "controls.yaml": asYaml({ schema: MODEL_FILE_SCHEMAS["controls.yaml"], controls }),
    "families.yaml": asYaml({ schema: MODEL_FILE_SCHEMAS["families.yaml"], families }),
    "backlog.yaml": asYaml({ schema: MODEL_FILE_SCHEMAS["backlog.yaml"], tickets }),
  };
  return {
    files,
    imported_family_ids: families.map((family) => family.id).sort(),
    review_evidence: [
      "Legacy Markdown was read only as an explicit import input; it is not retained as machine authority.",
      "Every imported family received caller-reviewed meaning, ownership, provenance, structure, implementation, and negative-control data.",
    ],
  };
}
