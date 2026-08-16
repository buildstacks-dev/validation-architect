import { describe, expect, it } from "vitest";
import {
  CORPUS_SCHEMA,
  isPublicContractError,
  migrate,
  type LegacyModelImportInput,
  type MigrateOutput,
} from "../src/api/index.js";
import { compileValidationModel, type ModelFileSet } from "../src/model-compiler.js";
import { MODEL_FILES } from "../src/model.js";

const catalog = `## Contract matrix

| Cell | Family | Layer | Oracle | Risk |
| --- | --- | --- | --- | --- |
| CF-COMPOSITE | One legacy detector with two deterministic placements | 1/2 | state | E1 |
| CF-FAST | Deterministic refusal detector | 2 | refusal | E1 |
| CF-LIVE | Live certification EVIDENCE:incomplete:evidence/live.json | 3 | live | E1 |
`;

const backlog = `## Wave 0

HB-LAYER LANDED
HB-CROSS LANDED
HB-HIST LANDED
HB-EMPTY LANDED

**HB-CROSS — Test and evidence detector.** CF-FAST, CF-LIVE.

**HB-LAYER — Composite layer detector.** CF-COMPOSITE. It also cites CF-FAST after that family was already owned.

**HB-HIST — Historical follow-up record.** References CF-FAST after its owning ticket; this is migration history only.

**HB-EMPTY — Historical bootstrap record.** No family remains; this is migration history only.
`;

const control = (id: string) => ({
  id: `NC-${id}`,
  title: `${id} seeded violation`,
  owner: "OWN-1",
  expected_failure: "The reviewed detector turns red",
});

function review(): LegacyModelImportInput {
  return {
    product: {
      id: "migration-fixture",
      name: "Migration fixture",
      revision: "deadbeef",
      intended_use: "Exercise reviewed legacy normalization",
      criticality: "C1",
      criticality_reason: "Synthetic offline migration contract fixture",
    },
    inner_loop_command: "pnpm test",
    owners: [{ id: "OWN-1", name: "Validation owner", responsibility: "Own reviewed validation" }],
    sources: [{ id: "SRC-1", kind: "doc", path: "docs/PRODUCT.md" }],
    structures: [
      {
        id: "CON-1",
        kind: "contract",
        title: "Migration contract",
        meaning: "Reviewed legacy meaning survives canonical placement",
        owner: "OWN-1",
        source_ids: ["SRC-1"],
        acceptance_criteria: ["Every legacy identity has an explicit migration disposition"],
      },
    ],
    policy: {
      default: "blocking",
      inheritance: "tighten-only",
      layers: [
        { id: "L1", title: "Invariant and contract", status: "active" },
        { id: "L2", title: "Hermetic system", status: "active" },
        { id: "L3", title: "Live sandbox", status: "active" },
        { id: "L4", title: "Eval qualification", status: "declared-empty", reason: "No eval family" },
        { id: "L5", title: "Ops hardening", status: "declared-empty", reason: "C1 fixture" },
        { id: "L6", title: "Outcome acceptance", status: "declared-empty", reason: "No scored output" },
      ],
      lanes: [
        {
          id: "inner-loop",
          title: "Fast local checks",
          kind: "test",
          status: "active",
          requirement: "blocking",
          triggers: ["before-push"],
          command: "pnpm test -- --changed",
        },
        {
          id: "per-commit",
          title: "Required deterministic checks",
          kind: "test",
          status: "active",
          requirement: "blocking",
          triggers: ["per-commit"],
          command: "pnpm test",
        },
        {
          id: "triggered",
          title: "Other explicit evidence",
          kind: "evidence",
          status: "declared-empty",
          requirement: "blocking",
          triggers: [],
          reason: "No other triggered family",
        },
        {
          id: "release",
          title: "Release certification",
          kind: "evidence",
          status: "active",
          requirement: "blocking",
          triggers: ["release-qualification"],
          authorization: "per-run-human",
        },
        {
          id: "scheduled",
          title: "Recurring evidence",
          kind: "evidence",
          status: "declared-empty",
          requirement: "blocking",
          triggers: [],
          reason: "No scheduled family",
        },
      ],
      exceptions: [],
    },
    families: {
      "CF-COMPOSITE": {
        title: "Composite detector",
        meaning: "One legacy obligation has deterministic L1 and L2 detectors",
        structure_ids: ["CON-1"],
        owner: "OWN-1",
        source_ids: ["SRC-1"],
        outputs: [
          {
            id: "CF-COMPOSITE-L2",
            layer: "L2",
            lane: "per-commit",
            owner: "OWN-1",
            structure_ids: ["CON-1"],
            source_ids: ["SRC-1"],
            ticket: "HB-LAYER-L2",
            control: control("CF-COMPOSITE-L2"),
            planned_tests: ["test/composite-l2.test.ts"],
          },
          {
            id: "CF-COMPOSITE",
            layer: "L1",
            lane: "per-commit",
            owner: "OWN-1",
            structure_ids: ["CON-1"],
            source_ids: ["SRC-1"],
            ticket: "HB-LAYER",
            control: control("CF-COMPOSITE"),
            planned_tests: ["test/composite-l1.test.ts"],
          },
        ],
      },
      "CF-FAST": {
        title: "Fast detector",
        meaning: "The deterministic refusal remains at L2",
        structure_ids: ["CON-1"],
        owner: "OWN-1",
        source_ids: ["SRC-1"],
        control: control("CF-FAST"),
        planned_tests: ["test/fast.test.ts"],
      },
      "CF-LIVE": {
        title: "Live evidence",
        meaning: "The live certification remains incomplete and separately authorized",
        structure_ids: ["CON-1"],
        owner: "OWN-1",
        source_ids: ["SRC-1"],
        outputs: [
          {
            id: "CF-LIVE",
            layer: "L3",
            lane: "release",
            owner: "OWN-1",
            structure_ids: ["CON-1"],
            source_ids: ["SRC-1"],
            ticket: "HB-CROSS-L3",
            control: control("CF-LIVE"),
            evidence: { state: "incomplete", path: "evidence/live.json" },
          },
        ],
      },
    },
    ticket_reviews: {
      "HB-LAYER": {
        outputs: [
          {
            id: "HB-LAYER-L2",
            title: "Composite detector at L2",
            owner: "OWN-1",
            executor: "standing coding agent",
            lane: "per-commit",
            layer: "L2",
            acceptance_criteria: ["The L2 detector rejects the seeded composition failure"],
            family_ids: ["CF-COMPOSITE-L2"],
          },
          {
            id: "HB-LAYER",
            title: "Composite detector at L1",
            owner: "OWN-1",
            executor: "standing coding agent",
            lane: "per-commit",
            layer: "L1",
            acceptance_criteria: ["The L1 detector rejects the seeded contract failure"],
            family_ids: ["CF-COMPOSITE"],
          },
        ],
      },
      "HB-CROSS": {
        outputs: [
          {
            id: "HB-CROSS-L3",
            title: "Live certification evidence",
            owner: "OWN-1",
            executor: "authorized evidence reviewer",
            lane: "release",
            layer: "L3",
            acceptance_criteria: ["The incomplete live artifact remains explicit"],
            family_ids: ["CF-LIVE"],
          },
          {
            id: "HB-CROSS",
            title: "Deterministic refusal detector",
            owner: "OWN-1",
            executor: "standing coding agent",
            lane: "per-commit",
            layer: "L2",
            acceptance_criteria: ["The deterministic refusal detector turns red"],
            family_ids: ["CF-FAST"],
          },
        ],
      },
      "HB-HIST": {
        historical: { reason: "The follow-up cited an already-owned family and owns no actionable work." },
      },
      "HB-EMPTY": {
        historical: { reason: "The bootstrap work landed before family-level tracking existed." },
      },
    },
  };
}

function modelFiles(output: MigrateOutput): ModelFileSet {
  const byPath = new Map(output.files.map((file) => [file.path, file.content]));
  return Object.fromEntries(
    MODEL_FILES.map((file) => [file, byPath.get(`validation-design/model/${file}`) ?? ""]),
  ) as ModelFileSet;
}

function invalid(mutator: (value: LegacyModelImportInput) => void): Error {
  const value = review();
  mutator(value);
  let caught: unknown;
  try {
    migrate({ kind: "legacy-catalog", catalogMarkdown: catalog, backlogMarkdown: backlog, review: value }, CORPUS_SCHEMA);
  } catch (error) {
    caught = error;
  }
  expect(isPublicContractError(caught, "invalid_input")).toBe(true);
  if (!(caught instanceof Error)) throw new Error("expected a typed migration error");
  return caught;
}

describe("reviewed legacy migration expansion", () => {
  it("compiles composite placements, split tickets, and historical tickets with a deterministic ledger", () => {
    const first = migrate(
      { kind: "legacy-catalog", catalogMarkdown: catalog, backlogMarkdown: backlog, review: review() },
      CORPUS_SCHEMA,
    );
    const second = migrate(
      { kind: "legacy-catalog", catalogMarkdown: catalog, backlogMarkdown: backlog, review: review() },
      CORPUS_SCHEMA,
    );

    expect(second).toEqual(first);
    expect(first.evidence.migration_ledger).toEqual({
      families: [
        { legacy_id: "CF-COMPOSITE", output_ids: ["CF-COMPOSITE", "CF-COMPOSITE-L2"] },
        { legacy_id: "CF-FAST", output_ids: ["CF-FAST"] },
        { legacy_id: "CF-LIVE", output_ids: ["CF-LIVE"] },
      ],
      tickets: [
        {
          legacy_id: "HB-CROSS",
          disposition: "actionable",
          legacy_family_ids: ["CF-FAST", "CF-LIVE"],
          owned_legacy_family_ids: ["CF-FAST", "CF-LIVE"],
          output_ids: ["HB-CROSS", "HB-CROSS-L3"],
        },
        {
          legacy_id: "HB-EMPTY",
          disposition: "historical",
          legacy_family_ids: [],
          owned_legacy_family_ids: [],
          output_ids: [],
          reason: "The bootstrap work landed before family-level tracking existed.",
        },
        {
          legacy_id: "HB-HIST",
          disposition: "historical",
          legacy_family_ids: ["CF-FAST"],
          owned_legacy_family_ids: [],
          output_ids: [],
          reason: "The follow-up cited an already-owned family and owns no actionable work.",
        },
        {
          legacy_id: "HB-LAYER",
          disposition: "actionable",
          legacy_family_ids: ["CF-COMPOSITE", "CF-FAST"],
          owned_legacy_family_ids: ["CF-COMPOSITE"],
          output_ids: ["HB-LAYER", "HB-LAYER-L2"],
        },
      ],
    });
    const compiled = compileValidationModel(modelFiles(first));
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.accepted).toBe(true);
    expect(compiled.model?.tickets.map((ticket) => ticket.id)).not.toContain("HB-HIST");
    expect(compiled.model?.families.find((family) => family.id === "CF-LIVE")?.evidence).toEqual({
      state: "incomplete",
      path: "evidence/live.json",
    });
    expect(compiled.model?.policy.lanes.find((lane) => lane.id === "release")).toMatchObject({
      status: "active",
      triggers: ["release-qualification"],
      authorization: "per-run-human",
    });
  });

  it("refuses composite prose without explicit reviewed outputs", () => {
    const error = invalid((value) => {
      const family = value.families["CF-COMPOSITE"];
      if (!family) throw new Error("fixture family missing");
      delete family.outputs;
      family.control = control("CF-COMPOSITE");
      family.planned_tests = ["test/composite.test.ts"];
    });
    expect(error.message).toMatch(/families\.CF-COMPOSITE\.outputs/);
  });

  it("refuses duplicate family output identities", () => {
    const error = invalid((value) => {
      const family = value.families["CF-COMPOSITE"];
      if (!family?.outputs) throw new Error("fixture outputs missing");
      const output = family.outputs[0];
      if (!output) throw new Error("fixture output missing");
      output.id = "CF-COMPOSITE";
    });
    expect(error.message).toMatch(/retain the legacy id exactly once|duplicated/);
  });

  it("refuses an expanded family output without exact provenance links", () => {
    const error = invalid((value) => {
      const family = value.families["CF-COMPOSITE"];
      const output = family?.outputs?.[0];
      if (!output) throw new Error("fixture output missing");
      output.source_ids = [];
    });
    expect(error.message).toMatch(/needs exact reviewed ownership, structures, and provenance/);
  });

  it("refuses a ticket split that drops a reviewed family output", () => {
    const error = invalid((value) => {
      const ticket = value.ticket_reviews["HB-LAYER"];
      if (!ticket?.outputs) throw new Error("fixture ticket outputs missing");
      ticket.outputs = ticket.outputs.filter((output) => output.id === "HB-LAYER");
    });
    expect(error.message).toMatch(/account for every reviewed family output exactly once/);
  });

  it("refuses a ticket whose reviewed layer disagrees with its family", () => {
    const error = invalid((value) => {
      const ticket = value.ticket_reviews["HB-CROSS"];
      const output = ticket?.outputs?.find((candidate) => candidate.id === "HB-CROSS-L3");
      if (!output) throw new Error("fixture ticket output missing");
      output.layer = "L2";
    });
    expect(error.message).toMatch(/crosses the reviewed layer or lane/);
  });

  it("refuses mixed compact and explicit ticket review forms", () => {
    const error = invalid((value) => {
      const ticket = value.ticket_reviews["HB-LAYER"];
      if (!ticket) throw new Error("fixture ticket missing");
      ticket.executor = "ambiguous duplicate executor";
      ticket.acceptance_criteria = ["Ambiguous duplicate acceptance"];
    });
    expect(error.message).toMatch(/mixes the compact review form with explicit outputs/);
  });

  it("refuses a ticket with no owned families without a reviewed historical disposition", () => {
    const error = invalid((value) => {
      const ticket = value.ticket_reviews["HB-HIST"];
      if (!ticket) throw new Error("fixture historical ticket missing");
      delete ticket.historical;
    });
    expect(error.message).toMatch(/owns no families and needs an explicit historical disposition and reason/);
  });

  it("refuses unknown review identities instead of silently ignoring them", () => {
    const error = invalid((value) => {
      value.ticket_reviews["HB-NOT-IN-CORPUS"] = {
        historical: { reason: "Seeded stale review mapping" },
      };
    });
    expect(error.message).toMatch(/review contains unknown ids: HB-NOT-IN-CORPUS/);
  });
});
