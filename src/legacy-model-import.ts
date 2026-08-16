import { stringify } from "yaml";
import { generateManifest } from "./catalog.js";
import type {
  LegacyModelImportInput,
  LegacyModelImportResult,
} from "./legacy-model-contracts.js";
import { normalizeLegacyManifest } from "./legacy-model-normalization.js";
import {
  MODEL_FILE_SCHEMAS,
  type ModelFileSet,
  type ValidationFamily,
  type ValidationLayerId,
  type ValidationPolicy,
} from "./model.js";
import { CURRENT_CORE_VERSIONS } from "./versions.js";

export type {
  LegacyFamilyMigrationEntry,
  LegacyFamilyOutputReview,
  LegacyFamilyReview,
  LegacyMigrationLane,
  LegacyMigrationLedger,
  LegacyModelImportInput,
  LegacyModelImportResult,
  LegacyTicketMigrationEntry,
  LegacyTicketOutputReview,
  LegacyTicketReview,
} from "./legacy-model-contracts.js";

const asYaml = (value: unknown): string => stringify(value, { lineWidth: 0 });

function clonePolicy(policy: ValidationPolicy): ValidationPolicy {
  return {
    default: policy.default,
    inheritance: policy.inheritance,
    layers: policy.layers.map((layer) => ({ ...layer })),
    lanes: policy.lanes.map((lane) => ({ ...lane, triggers: [...lane.triggers] })),
    exceptions: policy.exceptions.map((exception) => ({ ...exception })),
    ...(policy.coexistence
      ? {
          coexistence: {
            ...policy.coexistence,
            protected_paths: [...policy.coexistence.protected_paths],
            cutover_requires: [...policy.coexistence.cutover_requires],
          },
        }
      : {}),
  };
}

function canonicalFallbackPolicy(
  families: readonly ValidationFamily[],
  innerLoopCommand: string,
): ValidationPolicy {
  const activeLayers = new Set(
    families
      .map((family) => family.layer)
      .filter((layer): layer is ValidationLayerId => layer !== undefined),
  );
  const layerTitles = [
    "Invariant and contract",
    "Hermetic system",
    "Live sandbox",
    "Eval qualification",
    "Ops hardening",
    "Outcome acceptance",
  ];
  const triggeredActive = families.some((family) => family.lane === "triggered");
  return {
    default: "blocking",
    inheritance: "tighten-only",
    layers: layerTitles.map((title, index) => {
      const id = `L${index + 1}` as ValidationLayerId;
      return activeLayers.has(id)
        ? { id, title, status: "active" }
        : {
            id,
            title,
            status: "declared-empty",
            reason: "The reviewed legacy corpus has no family at this layer.",
          };
    }),
    lanes: [
      {
        id: "inner-loop",
        title: "Reviewed legacy inner loop",
        kind: "test",
        status: "active",
        requirement: "blocking",
        triggers: ["before-push"],
        command: innerLoopCommand,
      },
      {
        id: "per-commit",
        title: "Reviewed legacy tests",
        kind: "test",
        status: "active",
        requirement: "blocking",
        triggers: ["per-commit"],
        command: innerLoopCommand,
      },
      {
        id: "triggered",
        title: "Reviewed legacy non-test evidence",
        kind: "evidence",
        status: triggeredActive ? "active" : "declared-empty",
        requirement: "blocking",
        triggers: triggeredActive ? ["explicit-authorization"] : [],
        authorization: "per-run-human",
        ...(!triggeredActive
          ? { reason: "The reviewed legacy corpus declares no non-test evidence family." }
          : {}),
      },
      {
        id: "release",
        title: "Release evidence",
        kind: "evidence",
        status: "declared-empty",
        requirement: "blocking",
        triggers: [],
        reason: "The reviewed legacy corpus declares no separate release lane.",
      },
      {
        id: "scheduled",
        title: "Scheduled evidence",
        kind: "evidence",
        status: "declared-empty",
        requirement: "blocking",
        triggers: [],
        reason: "The reviewed legacy corpus declares no scheduled lane.",
      },
    ],
    exceptions: [],
  };
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
  const normalized = normalizeLegacyManifest(generated.manifest, input);
  const policy = input.policy
    ? clonePolicy(input.policy)
    : canonicalFallbackPolicy(normalized.families, input.inner_loop_command);
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
    "policy.yaml": asYaml({ schema: MODEL_FILE_SCHEMAS["policy.yaml"], ...policy }),
    "controls.yaml": asYaml({ schema: MODEL_FILE_SCHEMAS["controls.yaml"], controls: normalized.controls }),
    "families.yaml": asYaml({ schema: MODEL_FILE_SCHEMAS["families.yaml"], families: normalized.families }),
    "backlog.yaml": asYaml({ schema: MODEL_FILE_SCHEMAS["backlog.yaml"], tickets: normalized.tickets }),
  };
  return {
    files,
    imported_family_ids: normalized.families.map((family) => family.id).sort(),
    review_evidence: [
      "Legacy Markdown was read only as an explicit import input; it is not retained as machine authority.",
      "Every imported family received caller-reviewed meaning, ownership, provenance, structure, canonical placement, implementation, and negative-control data.",
      "Every legacy family and ticket is accounted for in the deterministic migration ledger; non-owning citations remain evidence and no-owner tickets are not emitted as actionable work.",
    ],
    migration_ledger: normalized.migration_ledger,
  };
}
