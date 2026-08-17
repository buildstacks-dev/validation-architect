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
| CF-FOLLOW | Deterministic follow-up detector | 1 | state | E1 |
| CF-LIVE | Live certification EVIDENCE:incomplete:evidence/live.json | 3 | live | E1 |
`;

const backlog = `## Wave 0

HB-LAYER LANDED
HB-CROSS LANDED
HB-FOLLOW LANDED
HB-HIST LANDED
HB-EMPTY LANDED

**HB-CROSS — Test and evidence detector.** CF-FAST, CF-LIVE.

**HB-LAYER — Composite layer detector.** CF-COMPOSITE. It also cites CF-FAST after that family was already owned.

**HB-FOLLOW — Deterministic follow-up detector.** CF-FOLLOW.

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
        id: "J-1",
        kind: "journey",
        title: "First migrated run",
        meaning: "A reviewed legacy corpus completes its first canonical compile",
        owner: "OWN-1",
        source_ids: ["SRC-1"],
      },
      {
        id: "CON-1",
        kind: "contract",
        title: "Migration contract",
        meaning: "Reviewed legacy meaning survives canonical placement",
        owner: "OWN-1",
        source_ids: ["SRC-1"],
        acceptance_criteria: ["Every legacy identity has an explicit migration disposition"],
        error_criteria: ["An unreviewed legacy identity is refused with a typed migration error"],
      },
    ],
    policy: {
      default: "blocking",
      inheritance: "tighten-only",
      smoke_journey_ids: ["J-1"],
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
        structure_ids: ["CON-1", "J-1"],
        owner: "OWN-1",
        source_ids: ["SRC-1"],
        control: control("CF-FAST"),
        planned_tests: ["test/fast.test.ts"],
      },
      "CF-FOLLOW": {
        title: "Follow-up detector",
        meaning: "The deterministic follow-up runs after the composite detector",
        structure_ids: ["CON-1"],
        owner: "OWN-1",
        source_ids: ["SRC-1"],
        control: control("CF-FOLLOW"),
        planned_tests: ["test/follow.test.ts"],
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
      "HB-FOLLOW": {
        executor: "standing coding agent",
        acceptance_criteria: ["The follow-up detector runs after the composite detector"],
        depends_on: ["HB-LAYER"],
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
        { legacy_id: "CF-FOLLOW", output_ids: ["CF-FOLLOW"] },
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
          legacy_id: "HB-FOLLOW",
          disposition: "actionable",
          legacy_family_ids: ["CF-FOLLOW"],
          owned_legacy_family_ids: ["CF-FOLLOW"],
          output_ids: ["HB-FOLLOW"],
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
    expect(compiled.model?.tickets.find((ticket) => ticket.id === "HB-FOLLOW")?.depends_on).toEqual([
      "HB-LAYER",
    ]);
    expect(compiled.generated_views["harness-backlog.md"]).toContain("Depends on `HB-LAYER`.");
  });

  it("preserves distinct mechanical L1/L2 and statistical L6 oracle and risk reviews", () => {
    const value = review();
    const family = value.families["CF-COMPOSITE"];
    const ticket = value.ticket_reviews["HB-LAYER"];
    const layer = value.policy?.layers.find((candidate) => candidate.id === "L6");
    if (!family?.outputs || !ticket?.outputs || !layer) throw new Error("fixture split review missing");

    family.outputs[0]!.oracle = "deterministic process state";
    family.outputs[0]!.risk = "E2 hermetic integration drift";
    family.outputs[1]!.oracle = "exact contract refusal";
    family.outputs[1]!.risk = "E1 contract regression";
    family.outputs.push({
      id: "CF-COMPOSITE-L6",
      layer: "L6",
      lane: "release",
      owner: "OWN-1",
      structure_ids: ["CON-1"],
      source_ids: ["SRC-1"],
      oracle: "95% confidence interval excludes the outcome floor",
      risk: "E6 statistical outcome regression",
      ticket: "HB-LAYER-L6",
      control: control("CF-COMPOSITE-L6"),
      evidence: { state: "unobserved", path: "evidence/composite-l6.json" },
    });
    ticket.outputs.push({
      id: "HB-LAYER-L6",
      title: "Composite outcome acceptance at L6",
      owner: "OWN-1",
      executor: "authorized outcome reviewer",
      lane: "release",
      layer: "L6",
      acceptance_criteria: ["The statistical outcome detector rejects the seeded distribution shift"],
      family_ids: ["CF-COMPOSITE-L6"],
    });
    layer.status = "active";
    delete layer.reason;

    const migrated = migrate(
      { kind: "legacy-catalog", catalogMarkdown: catalog, backlogMarkdown: backlog, review: value },
      CORPUS_SCHEMA,
    );
    const compiled = compileValidationModel(modelFiles(migrated));
    expect(compiled.diagnostics).toEqual([]);
    expect(
      compiled.model?.families
        .filter((candidate) => candidate.id.startsWith("CF-COMPOSITE"))
        .map((candidate) => [candidate.id, candidate.layer, candidate.oracle, candidate.risk]),
    ).toEqual([
      ["CF-COMPOSITE", "L1", "exact contract refusal", "E1 contract regression"],
      ["CF-COMPOSITE-L2", "L2", "deterministic process state", "E2 hermetic integration drift"],
      [
        "CF-COMPOSITE-L6",
        "L6",
        "95% confidence interval excludes the outcome floor",
        "E6 statistical outcome regression",
      ],
    ]);
  });

  it("falls back exactly to the legacy family oracle and risk when an output omits them", () => {
    const migrated = migrate(
      { kind: "legacy-catalog", catalogMarkdown: catalog, backlogMarkdown: backlog, review: review() },
      CORPUS_SCHEMA,
    );
    const compiled = compileValidationModel(modelFiles(migrated));

    expect(
      compiled.model?.families
        .filter((candidate) => candidate.id.startsWith("CF-COMPOSITE"))
        .map((candidate) => [candidate.id, candidate.oracle, candidate.risk]),
    ).toEqual([
      ["CF-COMPOSITE", "state", "E1"],
      ["CF-COMPOSITE-L2", "state", "E1"],
    ]);
  });

  it("preserves explicit ticket dependencies and reviewed split statuses", () => {
    const value = review();
    const family = value.families["CF-COMPOSITE"];
    const ticket = value.ticket_reviews["HB-LAYER"];
    if (!family?.outputs || !ticket?.outputs) throw new Error("fixture split outputs missing");
    family.outputs.push({
      id: "CF-COMPOSITE-PENDING",
      layer: "L2",
      lane: "per-commit",
      owner: "OWN-1",
      structure_ids: ["CON-1"],
      source_ids: ["SRC-1"],
      ticket: "HB-LAYER-PENDING",
      control: control("CF-COMPOSITE-PENDING"),
      planned_tests: ["test/composite-pending.test.ts"],
    });
    ticket.outputs[0]!.status = "landed";
    ticket.outputs[0]!.depends_on = ["HB-CROSS"];
    ticket.outputs[1]!.status = "landed";
    ticket.outputs[1]!.depends_on = ["HB-CROSS"];
    ticket.outputs.push({
      id: "HB-LAYER-PENDING",
      title: "Pending composite follow-up",
      owner: "OWN-1",
      executor: "standing coding agent",
      lane: "per-commit",
      layer: "L2",
      acceptance_criteria: ["The pending detector rejects the seeded composition failure"],
      family_ids: ["CF-COMPOSITE-PENDING"],
      depends_on: ["HB-LAYER", "HB-LAYER-L2"],
    });

    const migrated = migrate(
      {
        kind: "legacy-catalog",
        catalogMarkdown: catalog,
        backlogMarkdown: backlog.replace("HB-LAYER LANDED", "HB-LAYER PENDING"),
        review: value,
      },
      CORPUS_SCHEMA,
    );
    const compiled = compileValidationModel(modelFiles(migrated));
    expect(compiled.accepted).toBe(true);
    expect(
      compiled.model?.tickets
        .filter((candidate) => candidate.id.startsWith("HB-LAYER"))
        .map((candidate) => [candidate.id, candidate.status, candidate.depends_on]),
    ).toEqual([
      ["HB-LAYER", "landed", ["HB-CROSS"]],
      ["HB-LAYER-L2", "landed", ["HB-CROSS"]],
      ["HB-LAYER-PENDING", "pending", ["HB-LAYER", "HB-LAYER-L2"]],
    ]);
    expect(compiled.generated_views["harness-backlog.md"]).toContain(
      "**HB-LAYER-PENDING — Pending composite follow-up** (pending;",
    );
    expect(compiled.generated_views["harness-backlog.md"]).toContain(
      "Depends on `HB-LAYER`, `HB-LAYER-L2`.",
    );
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

  it.each([
    ["oracle", ""],
    ["oracle", "   "],
    ["oracle", 42],
    ["oracle", null],
    ["risk", ""],
    ["risk", "   "],
    ["risk", 42],
    ["risk", null],
  ])("refuses malformed per-output %s review value %j", (field, invalidValue) => {
    const error = invalid((value) => {
      const output = value.families["CF-COMPOSITE"]?.outputs?.[0];
      if (!output) throw new Error("fixture output missing");
      Object.assign(output, { [field]: invalidValue });
    });
    expect(error.message).toMatch(new RegExp(`needs a non-empty reviewed ${field}`));
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

  it("refuses invalid split status and malformed or duplicate reviewed dependencies", () => {
    const invalidStatus = invalid((value) => {
      const output = value.ticket_reviews["HB-LAYER"]?.outputs?.[0];
      if (!output) throw new Error("fixture ticket output missing");
      Object.assign(output, { status: "done" });
    });
    expect(invalidStatus.message).toMatch(/canonical pending, landed, blocked, or parked status/);

    const compactStatus = invalid((value) => {
      const ticket = value.ticket_reviews["HB-FOLLOW"];
      if (!ticket) throw new Error("fixture compact ticket missing");
      Object.assign(ticket, { status: "pending" });
    });
    expect(compactStatus.message).toMatch(/cannot override status in the compact review/);

    const malformedDependencies = invalid((value) => {
      const ticket = value.ticket_reviews["HB-FOLLOW"];
      if (!ticket) throw new Error("fixture compact ticket missing");
      Object.assign(ticket, { depends_on: "HB-LAYER" });
    });
    expect(malformedDependencies.message).toMatch(/non-empty dependency ids/);

    const emptyDependency = invalid((value) => {
      const ticket = value.ticket_reviews["HB-FOLLOW"];
      if (!ticket) throw new Error("fixture compact ticket missing");
      ticket.depends_on = [""];
    });
    expect(emptyDependency.message).toMatch(/non-empty dependency ids/);

    const duplicateDependency = invalid((value) => {
      const ticket = value.ticket_reviews["HB-FOLLOW"];
      if (!ticket) throw new Error("fixture compact ticket missing");
      ticket.depends_on = ["HB-LAYER", "HB-LAYER"];
    });
    expect(duplicateDependency.message).toMatch(/duplicate dependency ids/);
  });

  it("leaves unknown, self-referential, and cyclic dependencies red in the canonical compiler", () => {
    const compileMutated = (mutator: (value: LegacyModelImportInput) => void) => {
      const value = review();
      mutator(value);
      const migrated = migrate(
        { kind: "legacy-catalog", catalogMarkdown: catalog, backlogMarkdown: backlog, review: value },
        CORPUS_SCHEMA,
      );
      return compileValidationModel(modelFiles(migrated));
    };

    const unknown = compileMutated((value) => {
      const ticket = value.ticket_reviews["HB-FOLLOW"];
      if (!ticket) throw new Error("fixture compact ticket missing");
      ticket.depends_on = ["HB-MISSING"];
    });
    expect(unknown.accepted).toBe(false);
    expect(unknown.diagnostics.map((item) => item.message).join("\n")).toMatch(/depends on missing ticket HB-MISSING/);

    const self = compileMutated((value) => {
      const ticket = value.ticket_reviews["HB-FOLLOW"];
      if (!ticket) throw new Error("fixture compact ticket missing");
      ticket.depends_on = ["HB-FOLLOW"];
    });
    expect(self.accepted).toBe(false);
    expect(self.diagnostics.map((item) => item.message).join("\n")).toMatch(/cannot depend on itself/);

    const cycle = compileMutated((value) => {
      const output = value.ticket_reviews["HB-LAYER"]?.outputs?.find(
        (candidate) => candidate.id === "HB-LAYER",
      );
      if (!output) throw new Error("fixture ticket output missing");
      output.depends_on = ["HB-FOLLOW"];
    });
    expect(cycle.accepted).toBe(false);
    expect(cycle.diagnostics.map((item) => item.message).join("\n")).toMatch(/dependency cycle/);
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
