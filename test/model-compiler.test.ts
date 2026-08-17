import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import {
  MODEL_FILES,
  MODEL_FILE_SCHEMAS,
  type ModelFileSet,
} from "../src/model.js";
import { compileValidationModel } from "../src/model-compiler.js";
import { assertSeparateDomains, joinTestInventory } from "../src/model-inventory.js";
import { importLegacyCatalog } from "../src/legacy-model-import.js";
import { GENERATED_MODEL_VIEWS } from "../src/model-views.js";
import { createReaderBundle, removeReaderBundle } from "../src/reader-bundle.js";
import { CURRENT_CORE_VERSIONS } from "../src/versions.js";
import { compileWorkspaceModel } from "../src/workspace-compiler.js";

function yaml(value: unknown): string {
  return stringify(value, { lineWidth: 0 });
}

function validFiles(): ModelFileSet {
  return {
    "project.yaml": yaml({
      schema: MODEL_FILE_SCHEMAS["project.yaml"],
      product: {
        id: "fixture",
        name: "Compiler fixture",
        revision: "abc123",
        intended_use: "Local compiler validation",
        criticality: "C1",
        criticality_reason: "Disposable synthetic data with bounded consequences",
      },
      versions: CURRENT_CORE_VERSIONS,
    }),
    "owners.yaml": yaml({
      schema: MODEL_FILE_SCHEMAS["owners.yaml"],
      owners: [{ id: "OWN-1", name: "Runtime team", responsibility: "Protect the public contract" }],
    }),
    "sources.yaml": yaml({
      schema: MODEL_FILE_SCHEMAS["sources.yaml"],
      sources: [{ id: "SRC-1", kind: "doc", path: "docs/PRODUCT.md", locator: "Contract" }],
    }),
    "structures.yaml": yaml({
      schema: MODEL_FILE_SCHEMAS["structures.yaml"],
      structures: [
        {
          id: "CON-1",
          kind: "contract",
          title: "Tenant boundary",
          meaning: "An org|app lookup never crosses tenants",
          owner: "OWN-1",
          source_ids: ["SRC-1"],
          acceptance_criteria: [
            "Given an org and app ID, return only rows owned by that org",
            "Reject a foreign-tenant row without exposing its contents",
            "Repeating a rejected lookup does not mutate state",
          ],
          changed_paths: ["src/contracts/**"],
        },
      ],
    }),
    "policy.yaml": yaml({
      schema: MODEL_FILE_SCHEMAS["policy.yaml"],
      default: "blocking",
      inheritance: "tighten-only",
      layers: [
        { id: "L1", title: "Invariant and contract", status: "declared-empty", reason: "No L1 family in this focused fixture" },
        { id: "L2", title: "Hermetic system", status: "active" },
        { id: "L3", title: "Live sandbox", status: "declared-empty", reason: "No live target" },
        { id: "L4", title: "Eval qualification", status: "declared-empty", reason: "No model call site" },
        { id: "L5", title: "Ops hardening", status: "declared-empty", reason: "C1 local fixture" },
        { id: "L6", title: "Outcome acceptance", status: "declared-empty", reason: "No human-judged output" },
      ],
      lanes: [
        { id: "inner-loop", title: "Fast local", kind: "test", status: "active", requirement: "blocking", triggers: ["before-push"], command: "pnpm test -- tenant" },
        { id: "per-commit", title: "Hermetic process", kind: "test", status: "active", requirement: "blocking", triggers: ["per-commit"], command: "pnpm test" },
        { id: "triggered", title: "Triggered evidence", kind: "evidence", status: "declared-empty", requirement: "blocking", triggers: [], reason: "No triggered obligation" },
        { id: "release", title: "Release evidence", kind: "evidence", status: "declared-empty", requirement: "blocking", triggers: [], reason: "No release obligation" },
        { id: "scheduled", title: "Scheduled evidence", kind: "evidence", status: "declared-empty", requirement: "blocking", triggers: [], reason: "No scheduled obligation" },
      ],
      exceptions: [],
    }),
    "controls.yaml": yaml({
      schema: MODEL_FILE_SCHEMAS["controls.yaml"],
      controls: [
        {
          id: "NC-1",
          title: "Cross-tenant seed",
          family_id: "CF-1",
          owner: "OWN-1",
          expected_failure: "The detector fails when a foreign tenant row is returned",
        },
      ],
    }),
    "families.yaml": yaml({
      schema: MODEL_FILE_SCHEMAS["families.yaml"],
      families: [
        {
          id: "CF-1",
          title: "Tenant isolation",
          meaning: "An org|app lookup rejects foreign rows",
          structure_ids: ["CON-1"],
          owner: "OWN-1",
          source_ids: ["SRC-1"],
          lane: "per-commit",
          status: "implementable",
          layer: "L2",
          oracle: "state",
          risk: "E1",
          control_ids: ["NC-1"],
          ticket: "HB-1",
          planned_tests: ["tests/contracts/tenant.test.ts"],
          exclusions: ["Live cloud tenancy is covered by a separately authorized lane"],
        },
      ],
    }),
    "backlog.yaml": yaml({
      schema: MODEL_FILE_SCHEMAS["backlog.yaml"],
      tickets: [
        {
          id: "HB-1",
          title: "Land the tenant detector",
          wave: "0",
          status: "pending",
          owner: "OWN-1",
          executor: "standing coding agent",
          lane: "per-commit",
          layer: "L2",
          acceptance_criteria: [
            "The planned tenant detector and its negative control pass through the per-commit command",
          ],
          family_ids: ["CF-1"],
        },
      ],
    }),
  };
}

describe("validation model compiler", () => {
  it("compiles deterministically and renders machine-fact views from one authority", () => {
    const first = compileValidationModel(validFiles());
    const second = compileValidationModel(validFiles());
    expect(first.accepted).toBe(true);
    expect(second.canonical_model).toBe(first.canonical_model);
    expect(second.generated_views).toEqual(first.generated_views);
    expect(second.identity).toBe(first.identity);
    expect(Object.keys(first.generated_views).sort()).toEqual([...GENERATED_MODEL_VIEWS].sort());
    expect(first.generated_views["case-catalog.md"]).toContain("org\\|app");
    expect(first.generated_views["planned-trace.md"]).toContain("does not claim that tests exist");
  });

  it("projects fresh-human authorization into the owner execution-lane briefing", () => {
    const files = validFiles();
    const policy = compileValidationModel(files).model?.policy;
    if (!policy) throw new Error("fixture policy did not compile");
    const triggered = policy.lanes.find((lane) => lane.id === "triggered");
    if (!triggered) throw new Error("fixture is missing its triggered lane");
    triggered.authorization = "per-run-human";
    const compiled = compileValidationModel({
      ...files,
      "policy.yaml": yaml({ schema: MODEL_FILE_SCHEMAS["policy.yaml"], ...policy }),
    });
    expect(compiled.accepted).toBe(true);
    expect(compiled.generated_views["owner-briefing.md"]).toContain(
      "`triggered` Triggered evidence (evidence): blocking, declared-empty; triggers: —; authorization: per-run-human",
    );
  });

  it("gives fresh readers a complete, ordered, and escaped provenance registry", () => {
    const files = validFiles();
    const model = compileValidationModel(files).model;
    if (!model) throw new Error("fixture model did not compile");
    const sourceIds = ["SRC-Z-DOC"];
    const compiled = compileValidationModel({
      ...files,
      "sources.yaml": yaml({
        schema: MODEL_FILE_SCHEMAS["sources.yaml"],
        sources: [
          { id: "SRC-Z-DOC", kind: "doc", path: "docs/PRODUCT|DETAILS.md" },
          {
            id: "SRC-A-RAMBLING",
            kind: "rambling",
            path: "rambling.txt",
            quote: "Keep | tenant\nboundary literal",
          },
          { id: "SRC-N-SIMULATED", kind: "simulated", locator: "owner review | derived\njudgment" },
          { id: "SRC-M-PROPOSED", kind: "proposed", locator: "ratification package §4" },
        ],
      }),
      "structures.yaml": yaml({
        schema: MODEL_FILE_SCHEMAS["structures.yaml"],
        structures: model.structures.map((structure) => ({ ...structure, source_ids: sourceIds })),
      }),
      "families.yaml": yaml({
        schema: MODEL_FILE_SCHEMAS["families.yaml"],
        families: model.families.map((family) => ({ ...family, source_ids: sourceIds })),
      }),
    });
    expect(compiled.accepted).toBe(true);
    const trace = compiled.generated_views["planned-trace.md"];
    if (!trace) throw new Error("planned trace was not generated");
    const registry = trace
      .split("## Provenance registry\n\n")[1]
      ?.split("\n\n## Product structure routing")[0];
    if (!registry) throw new Error("provenance registry was not generated");

    expect(registry.match(/^\| SRC-/gm)).toHaveLength(4);
    expect(registry).toContain(
      "| SRC-A-RAMBLING | rambling | rambling.txt | — | Keep \\| tenant boundary literal |",
    );
    expect(registry).toContain("| SRC-M-PROPOSED | proposed | — | ratification package §4 | — |");
    expect(registry).toContain(
      "| SRC-N-SIMULATED | simulated | — | owner review \\| derived judgment | — |",
    );
    expect(registry).toContain("| SRC-Z-DOC | doc | docs/PRODUCT\\|DETAILS.md | — | — |");
    expect(registry.indexOf("SRC-A-RAMBLING")).toBeLessThan(registry.indexOf("SRC-M-PROPOSED"));
    expect(registry.indexOf("SRC-M-PROPOSED")).toBeLessThan(registry.indexOf("SRC-N-SIMULATED"));
    expect(registry.indexOf("SRC-N-SIMULATED")).toBeLessThan(registry.indexOf("SRC-Z-DOC"));
  });

  it("renders every structure criterion and failure mode without truncation", () => {
    const files = validFiles();
    const model = compileValidationModel(files).model;
    if (!model) throw new Error("fixture model did not compile");
    const contract = model.structures[0];
    if (!contract) throw new Error("fixture structure missing");
    const compiled = compileValidationModel({
      ...files,
      "structures.yaml": yaml({
        schema: MODEL_FILE_SCHEMAS["structures.yaml"],
        structures: [
          {
            ...contract,
            acceptance_criteria: [
              "First criterion | exact\ncontinuation",
              "Second criterion remains visible",
            ],
            failure_modes: [
              "Cross | boundary\nleak",
              "Crash-mid-step leaves partial state",
            ],
          },
          {
            id: "IF-EMPTY",
            kind: "interface",
            title: "Empty optional structure",
            meaning: "Optional lists are absent",
            owner: "OWN-1",
            source_ids: ["SRC-1"],
          },
        ],
      }),
    });
    expect(compiled.accepted).toBe(true);
    const trace = compiled.generated_views["planned-trace.md"];
    if (!trace) throw new Error("planned trace was not generated");
    const routing = trace
      .split("## Product structure routing\n\n")[1]
      ?.split("\n\n## Failure-mode coverage")[0];
    if (!routing) throw new Error("product structure routing was not generated");
    // Non-boundary modes stay visible (and may stay open) in the coverage table.
    expect(trace).toMatch(/## Failure-mode coverage[\s\S]*\| CON-1 \| contract \| Crash-mid-step leaves partial state \| \*\*OPEN\*\* \|/);

    expect(routing).toContain(
      "| Structure | Kind | Protected meaning | Acceptance criteria | Failure modes | Changed paths | Provenance | Owner |",
    );
    expect(routing).toContain(
      "| CON-1 | contract | An org\\|app lookup never crosses tenants | First criterion \\| exact continuation, Second criterion remains visible | Cross \\| boundary leak, Crash-mid-step leaves partial state | src/contracts/** | SRC-1 | OWN-1 |",
    );
    expect(routing).toContain(
      "| IF-EMPTY | interface | Optional lists are absent | — | — | — | SRC-1 | OWN-1 |",
    );
    expect(routing.match(/^\| (?:CON|IF)-/gm)).toHaveLength(2);
  });

  it("rejects duplicate ids with exact source location and a correction", () => {
    const files = validFiles();
    const family = yaml({
      schema: MODEL_FILE_SCHEMAS["families.yaml"],
      families: [
        ...(compileValidationModel(files).model?.families ?? []),
        ...(compileValidationModel(files).model?.families ?? []),
      ],
    });
    const result = compileValidationModel({ ...files, "families.yaml": family });
    const duplicate = result.diagnostics.find((diagnostic) => diagnostic.code === "MODEL_ID_DUPLICATE");
    expect(result.accepted).toBe(false);
    expect(duplicate).toMatchObject({ concept: "CF-1", location: { file: "validation-design/model/families.yaml" } });
    expect(duplicate?.location.line).toBeGreaterThan(2);
    expect(duplicate?.correction).toMatch(/Rename or remove/);
  });

  it("rejects broken owners, provenance, controls, statuses, and unsafe paths", () => {
    const files = validFiles();
    const model = compileValidationModel(files).model!;
    const brokenFamilies = structuredClone(model.families);
    Object.assign(brokenFamilies[0]!, {
      owner: "OWN-MISSING",
      source_ids: ["SRC-MISSING"],
      control_ids: ["NC-MISSING"],
      planned_tests: ["../escape.test.ts"],
    });
    const result = compileValidationModel({
      ...files,
      "families.yaml": yaml({ schema: MODEL_FILE_SCHEMAS["families.yaml"], families: brokenFamilies }),
    });
    expect(result.accepted).toBe(false);
    expect(result.diagnostics.map((item) => item.message).join("\n")).toMatch(/missing owner OWN-MISSING/);
    expect(result.diagnostics.map((item) => item.message).join("\n")).toMatch(/missing provenance SRC-MISSING/);
    expect(result.diagnostics.map((item) => item.message).join("\n")).toMatch(/missing negative control NC-MISSING/);
    expect(result.diagnostics.map((item) => item.message).join("\n")).toMatch(/unsafe planned test path/);
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.location.file).toMatch(/^validation-design\/model\//);
      expect(diagnostic.location.line).toBeGreaterThan(0);
      expect(diagnostic.location.column).toBeGreaterThan(0);
      expect(diagnostic.concept.length).toBeGreaterThan(0);
      expect(diagnostic.correction.length).toBeGreaterThan(10);
    }

    const invalidStatus = yaml({
      schema: MODEL_FILE_SCHEMAS["families.yaml"],
      families: [{ ...model.families[0], status: "done" }],
    });
    expect(compileValidationModel({ ...files, "families.yaml": invalidStatus }).accepted).toBe(false);
  });

  it("cannot accept empty required scope or a missing logical file", () => {
    const files = validFiles();
    const empty = compileValidationModel({
      ...files,
      "families.yaml": yaml({ schema: MODEL_FILE_SCHEMAS["families.yaml"], families: [] }),
    });
    expect(empty.accepted).toBe(false);
    expect(empty.diagnostics.some((item) => item.code === "MODEL_REQUIRED_SCOPE_EMPTY")).toBe(true);
    const partial: Partial<ModelFileSet> = { ...files };
    delete partial["controls.yaml"];
    expect(compileValidationModel(partial).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MODEL_FILE_MISSING", concept: "controls.yaml" })]),
    );
  });

  it("keeps criticality, all layers, executable lanes, exceptions, and coexistence fail-closed", () => {
    const files = validFiles();
    const compiled = compileValidationModel(files).model!;
    const policy = structuredClone(compiled.policy);
    policy.layers = policy.layers.filter((layer) => layer.id !== "L6");
    const innerLoop = policy.lanes.find((lane) => lane.id === "inner-loop")!;
    delete innerLoop.command;
    policy.exceptions = [
      {
        id: "EX-1",
        kind: "provisional",
        target: "CON-1.timeout",
        owner: "OWN-MISSING",
        reason: "Temporary reviewed value",
        expires: "someday",
      },
    ];
    policy.coexistence = {
      posture: "parallel-greenfield",
      isolated_root: "../escape",
      protected_paths: ["incumbent-tests"],
      incumbent_gates: "read_only",
      ci_integration: "additive_opt_in",
      cutover_requires: ["equivalence_evidence", "rollback_plan", "human_ratification"],
    };
    const result = compileValidationModel({
      ...files,
      "project.yaml": files["project.yaml"].replace("criticality: C1", "criticality: C2"),
      "policy.yaml": yaml({ schema: MODEL_FILE_SCHEMAS["policy.yaml"], ...policy }),
    });
    const messages = result.diagnostics.map((item) => `${item.message} ${item.correction}`).join("\n");
    expect(result.accepted).toBe(false);
    expect(messages).toMatch(/validation layer L6 is undeclared/);
    expect(messages).toMatch(/inner-loop.*missing or invalid command/i);
    expect(messages).toMatch(/missing owner OWN-MISSING/);
    expect(messages).toMatch(/missing or invalid expires/);
    expect(messages).toMatch(/provisional exception must state the testable temporary value/i);
    expect(messages).toMatch(/C2-C4 products require an active L5/);
    expect(messages).toMatch(/Coexistence path \.\.\/escape is unsafe/);
  });

  it("detects semantic generated-view drift even when a lossy pipe transform agrees with itself", () => {
    const compiled = compileValidationModel(validFiles());
    const corrupted = Object.fromEntries(
      Object.entries(compiled.generated_views).map(([file, content]) => [file, content.replace("org\\|app", "org")]),
    );
    const drift = compileValidationModel(validFiles(), { existingViews: corrupted });
    expect(drift.accepted).toBe(false);
    expect(drift.diagnostics.some((item) => item.code === "GENERATED_VIEW_STALE")).toBe(true);

    const extraFact = {
      ...compiled.generated_views,
      "case-catalog.md": `${compiled.generated_views["case-catalog.md"]}\n| CF-INVENTED | not in model |\n`,
    };
    expect(compileValidationModel(validFiles(), { existingViews: extraFact }).accepted).toBe(false);
  });

  it("keeps design, inventory, and evidence identities distinct", () => {
    const model = compileValidationModel(validFiles()).model!;
    expect(() => assertSeparateDomains(model, model)).toThrow(/cannot impersonate/);
    expect(() =>
      assertSeparateDomains(model, { kind: "test-inventory", revision: "abc123", environment: "local", tests: [] }),
    ).not.toThrow();
    expect(() =>
      assertSeparateDomains(model, { kind: "validation-evidence", revision: "abc123", environment: "ci", items: [] }),
    ).not.toThrow();
  });

  it("joins adapter inventory without making observed tests authoritative", () => {
    const model = compileValidationModel(validFiles()).model!;
    const joined = joinTestInventory(model, {
      kind: "test-inventory",
      revision: "abc123",
      environment: "local",
      tests: [{ id: "T-1", path: "tests/contracts/tenant.test.ts", family_ids: ["CF-1"] }],
    });
    expect(joined).toMatchObject({ accepted: true, unimplemented_family_ids: [] });
    expect(joined.links).toEqual([
      {
        family_id: "CF-1",
        test_ids: ["T-1"],
        test_paths: ["tests/contracts/tenant.test.ts"],
      },
    ]);
    expect(model.families[0]?.planned_tests).toEqual(["tests/contracts/tenant.test.ts"]);

    const rejected = joinTestInventory(model, {
      kind: "test-inventory",
      revision: "other",
      environment: "local",
      tests: [{ id: "T-2", path: "../escape.test.ts", family_ids: ["CF-INVENTED"] }],
    });
    expect(rejected.accepted).toBe(false);
    expect(rejected.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "INVENTORY_REVISION_MISMATCH",
        "INVENTORY_PATH_UNSAFE",
        "INVENTORY_FAMILY_UNKNOWN",
      ]),
    );
    expect(model.families.some((family) => family.id === "CF-INVENTED")).toBe(false);
  });

  const boundaryFiles = (families: Array<Record<string, unknown>>): ModelFileSet => {
    const files = validFiles();
    const model = compileValidationModel(files).model!;
    return {
      ...files,
      "structures.yaml": yaml({
        schema: MODEL_FILE_SCHEMAS["structures.yaml"],
        structures: [
          ...model.structures,
          {
            id: "B-1",
            kind: "boundary",
            title: "Store boundary",
            meaning: "The record store can fail independently of this process",
            owner: "OWN-1",
            source_ids: ["SRC-1"],
            failure_modes: ["timeout", "partial success"],
          },
        ],
      }),
      "families.yaml": yaml({
        schema: MODEL_FILE_SCHEMAS["families.yaml"],
        families: [...model.families.map((family) => ({ ...family })), ...families],
      }),
    };
  };

  it("fails closed when a boundary failure mode has no covering family and no named prune", () => {
    const rejected = compileValidationModel(boundaryFiles([]));
    expect(rejected.accepted).toBe(false);
    const uncovered = rejected.diagnostics.filter((item) => item.code === "MODEL_FAILURE_MODE_UNCOVERED");
    expect(uncovered.map((item) => item.message).join(" ")).toContain("timeout");
    expect(uncovered.map((item) => item.message).join(" ")).toContain("partial success");
    // The diagnostic lands at the boundary's own source location.
    expect(uncovered[0]?.concept).toBe("B-1");
    expect(uncovered[0]?.location.file).toBe("validation-design/model/structures.yaml");
    expect(uncovered[0]?.location.line).toBeGreaterThan(1);
  });

  it("accepts the same boundary once a family covers its modes, and renders the coverage", () => {
    const files = boundaryFiles([
      {
        id: "CF-B1",
        title: "Store failure modes",
        meaning: "Store timeouts and partial writes are detected",
        structure_ids: ["B-1"],
        owner: "OWN-1",
        source_ids: ["SRC-1"],
        lane: "per-commit",
        status: "implementable",
        layer: "L2",
        oracle: "state",
        risk: "E1",
        control_ids: ["NC-B1"],
        ticket: "HB-B1",
        planned_tests: ["tests/store.test.ts"],
        covers_failure_modes: ["B-1#timeout", "B-1#partial success"],
      },
    ]);
    files["controls.yaml"] = yaml({
      schema: MODEL_FILE_SCHEMAS["controls.yaml"],
      controls: [
        ...(compileValidationModel(validFiles()).model!.controls),
        { id: "NC-B1", title: "Seeded store fault", family_id: "CF-B1", owner: "OWN-1", expected_failure: "The detector fails when a seeded store fault goes unnoticed" },
      ],
    });
    files["backlog.yaml"] = yaml({
      schema: MODEL_FILE_SCHEMAS["backlog.yaml"],
      tickets: [
        ...(compileValidationModel(validFiles()).model!.tickets),
        { id: "HB-B1", title: "Land store failure-mode detectors", wave: "0", status: "pending", owner: "OWN-1", executor: "standing coding agent", lane: "per-commit", layer: "L2", acceptance_criteria: ["Store failure-mode detectors and control pass"], family_ids: ["CF-B1"] },
      ],
    });
    const compiled = compileValidationModel(files);
    expect(compiled.accepted, compiled.diagnostics.map((item) => item.message).join("\n")).toBe(true);
    expect(compiled.generated_views["case-catalog.md"]).toContain("B-1#timeout");
    expect(compiled.generated_views["planned-trace.md"]).toMatch(/Failure-mode coverage[\s\S]*B-1[\s\S]*timeout[\s\S]*CF-B1/);
  });

  it("accepts a named prune as failure-mode coverage", () => {
    const compiled = compileValidationModel(
      boundaryFiles([
        {
          id: "CF-B1-PRUNE",
          title: "Store failure modes pruned",
          meaning: "Store fault detection is deliberately out of scope",
          structure_ids: ["B-1"],
          owner: "OWN-1",
          source_ids: ["SRC-1"],
          lane: "per-commit",
          layer: "L2",
          status: "pruned",
          reason: "The store is a managed service; its fault behavior is covered by the vendor contract",
          covers_failure_modes: ["B-1#timeout", "B-1#partial success"],
        },
      ]),
    );
    expect(compiled.accepted, compiled.diagnostics.map((item) => item.message).join("\n")).toBe(true);
    expect(compiled.generated_views["planned-trace.md"]).toMatch(/B-1[\s\S]*timeout[\s\S]*CF-B1-PRUNE \(pruned\)/);
  });

  it("rejects dangling failure-mode references", () => {
    const dangling = compileValidationModel(
      boundaryFiles([
        {
          id: "CF-B1-PRUNE",
          title: "Store failure modes pruned",
          meaning: "Prune with broken references",
          structure_ids: ["B-1"],
          owner: "OWN-1",
          source_ids: ["SRC-1"],
          lane: "per-commit",
          layer: "L2",
          status: "pruned",
          reason: "Cited modes are wrong on purpose",
          covers_failure_modes: ["B-1#retry", "B-MISSING#timeout", "no-hash", "B-1#timeout", "B-1#partial success"],
        },
      ]),
    );
    expect(dangling.accepted).toBe(false);
    const messages = dangling.diagnostics.map((item) => item.message).join("\n");
    expect(messages).toContain("B-1#retry");
    expect(messages).toContain("B-MISSING#timeout");
    expect(messages).toContain("no-hash");
  });

  it("fails closed when a landed family's declared control is implemented by no inventory test", () => {
    const files = validFiles();
    files["backlog.yaml"] = files["backlog.yaml"].replace("status: pending", "status: landed");
    const model = compileValidationModel(files).model!;
    // Negative control for the closure rule: the spec is implemented, the
    // declared negative control NC-1 is cited by no test at all.
    const joined = joinTestInventory(model, {
      kind: "test-inventory",
      revision: "abc123",
      environment: "local",
      tests: [{ id: "T-1", path: "tests/contracts/tenant.test.ts", family_ids: ["CF-1"] }],
    });
    expect(joined.accepted).toBe(false);
    expect(joined.unimplemented_control_ids).toEqual(["NC-1"]);
    const diagnostic = joined.diagnostics.find((item) => item.code === "CONTROL_UNIMPLEMENTED");
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.family_id).toBe("CF-1");
    expect(diagnostic?.message).toContain("NC-1");

    const implemented = joinTestInventory(model, {
      kind: "test-inventory",
      revision: "abc123",
      environment: "local",
      tests: [{ id: "T-1", path: "tests/contracts/tenant.test.ts", family_ids: ["CF-1"], control_ids: ["NC-1"] }],
    });
    expect(implemented.accepted).toBe(true);
    expect(implemented.unimplemented_control_ids).toEqual([]);
  });

  it("keeps an unimplemented control visible data, never red, while the owner ticket is pending", () => {
    const model = compileValidationModel(validFiles()).model!;
    const joined = joinTestInventory(model, {
      kind: "test-inventory",
      revision: "abc123",
      environment: "local",
      tests: [{ id: "T-1", path: "tests/contracts/tenant.test.ts", family_ids: ["CF-1"] }],
    });
    expect(joined.accepted).toBe(true);
    expect(joined.diagnostics).toEqual([]);
    expect(joined.unimplemented_control_ids).toEqual(["NC-1"]);
  });

  it("still rejects a test citing a control without implementing its family", () => {
    const files = validFiles();
    files["backlog.yaml"] = files["backlog.yaml"].replace("status: pending", "status: landed");
    const model = compileValidationModel(files).model!;
    const joined = joinTestInventory(model, {
      kind: "test-inventory",
      revision: "abc123",
      environment: "local",
      tests: [{ id: "T-1", path: "tests/contracts/other.test.ts", family_ids: ["CF-OTHER"], control_ids: ["NC-1"] }],
    });
    expect(joined.accepted).toBe(false);
    expect(joined.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["INVENTORY_FAMILY_UNKNOWN", "INVENTORY_CONTROL_FAMILY_MISMATCH"]),
    );
  });

  it("changes identity only for semantic model changes, not unrelated prose", () => {
    const workspace = mkdtempSync(join(tmpdir(), "vda-model-identity-"));
    const modelDir = join(workspace, "validation-design", "model");
    mkdirSync(modelDir, { recursive: true });
    const files = validFiles();
    for (const file of MODEL_FILES) writeFileSync(join(modelDir, file), files[file]);
    const initial = compileWorkspaceModel(workspace, { regenerate: true });
    writeFileSync(join(workspace, "validation-design", "ratification-rationale.md"), "Human rationale only.\n");
    const proseOnly = compileWorkspaceModel(workspace, { regenerate: false });
    expect(proseOnly.identity).toBe(initial.identity);

    writeFileSync(
      join(modelDir, "families.yaml"),
      files["families.yaml"].replace("rejects foreign rows", "rejects all foreign tenant rows"),
    );
    const changed = compileWorkspaceModel(workspace, { regenerate: true });
    expect(changed.identity).not.toBe(initial.identity);
  });

  it("fails before generated output for unknown schemas and partial input sets", () => {
    const unknown = validFiles();
    unknown["project.yaml"] = unknown["project.yaml"].replace(
      MODEL_FILE_SCHEMAS["project.yaml"],
      "validation-architect/model/project/v0",
    );
    const unsupported = compileValidationModel(unknown);
    expect(unsupported.accepted).toBe(false);
    expect(unsupported.generated_views).toEqual({});
    expect(unsupported.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MODEL_SCHEMA_UNSUPPORTED" })]),
    );

    const workspace = mkdtempSync(join(tmpdir(), "vda-model-partial-"));
    const modelDir = join(workspace, "validation-design", "model");
    mkdirSync(modelDir, { recursive: true });
    const partial = validFiles();
    for (const file of MODEL_FILES.filter((file) => file !== "controls.yaml")) {
      writeFileSync(join(modelDir, file), partial[file]);
    }
    const result = compileWorkspaceModel(workspace, { regenerate: true });
    expect(result.accepted).toBe(false);
    for (const file of GENERATED_MODEL_VIEWS) {
      expect(() => readFileSync(join(workspace, "validation-design", file), "utf8")).toThrow();
    }
  });

  it("reports unreadable workspace input without throwing or generating views", () => {
    const workspace = mkdtempSync(join(tmpdir(), "vda-model-unreadable-"));
    const modelDir = join(workspace, "validation-design", "model");
    mkdirSync(modelDir, { recursive: true });
    const files = validFiles();
    for (const file of MODEL_FILES.filter((file) => file !== "controls.yaml")) {
      writeFileSync(join(modelDir, file), files[file]);
    }
    mkdirSync(join(modelDir, "controls.yaml"));

    const result = compileWorkspaceModel(workspace, { regenerate: true });
    expect(result.accepted).toBe(false);
    expect(result.generated_views).toEqual({});
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "MODEL_FILE_UNREADABLE",
          concept: "controls.yaml",
          location: { file: "validation-design/model/controls.yaml", line: 1, column: 1 },
        }),
      ]),
    );
    expect(result.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "MODEL_FILE_MISSING", concept: "controls.yaml" }),
      ]),
    );
    for (const file of GENERATED_MODEL_VIEWS) {
      expect(() => readFileSync(join(workspace, "validation-design", file), "utf8")).toThrow();
    }
  });

  it("rejects duplicate YAML keys and unknown fields instead of ignoring drift", () => {
    const duplicateKey = validFiles();
    duplicateKey["project.yaml"] += "schema: validation-architect/model/project/v1\n";
    expect(compileValidationModel(duplicateKey).diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MODEL_YAML_INVALID" })]),
    );

    const unknownField = validFiles();
    unknownField["owners.yaml"] = unknownField["owners.yaml"].replace(
      "responsibility: Protect the public contract",
      "responsibility: Protect the public contract\n    responibility: typo must not disappear",
    );
    expect(compileValidationModel(unknownField).diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "MODEL_FIELD_UNKNOWN", concept: "OWN-1" }),
      ]),
    );
  });

  it("rejects evidence substitution on an ordinary test lane", () => {
    const files = validFiles();
    const family = compileValidationModel(files).model!.families[0]!;
    const result = compileValidationModel({
      ...files,
      "families.yaml": yaml({
        schema: MODEL_FILE_SCHEMAS["families.yaml"],
        families: [
          {
            ...family,
            planned_tests: undefined,
            evidence: { state: "complete", path: "evidence/not-a-test.json" },
          },
        ],
      }),
    });
    expect(result.accepted).toBe(false);
    expect(result.diagnostics.map((item) => item.correction).join("\n")).toMatch(
      /Test lanes require one or more planned repository-relative test paths/,
    );
  });

  it("regenerates stale workspace views atomically and then checks clean", () => {
    const workspace = mkdtempSync(join(tmpdir(), "vda-model-"));
    const modelDir = join(workspace, "validation-design", "model");
    mkdirSync(modelDir, { recursive: true });
    const files = validFiles();
    for (const file of MODEL_FILES) writeFileSync(join(modelDir, file), files[file]);
    writeFileSync(join(workspace, "validation-design", "case-catalog.md"), "stale\n");
    const regenerated = compileWorkspaceModel(workspace, { regenerate: true });
    expect(regenerated.accepted).toBe(true);
    expect(regenerated.diagnostics.some((item) => item.code === "GENERATED_VIEW_STALE")).toBe(true);
    expect(readFileSync(join(workspace, "validation-design", "case-catalog.md"), "utf8")).toBe(
      regenerated.generated_views["case-catalog.md"],
    );
    expect(compileWorkspaceModel(workspace, { regenerate: false }).accepted).toBe(true);
  });

  it("gives fresh readers only generated artifacts bound to one identity", () => {
    const workspace = mkdtempSync(join(tmpdir(), "vda-reader-bundle-"));
    const modelDir = join(workspace, "validation-design", "model");
    mkdirSync(modelDir, { recursive: true });
    const files = validFiles();
    for (const file of MODEL_FILES) writeFileSync(join(modelDir, file), files[file]);
    writeFileSync(join(workspace, "validation-design", "system-map.md"), "authored and intentionally hidden\n");
    const compiled = compileWorkspaceModel(workspace, { regenerate: true });
    const bundle = createReaderBundle(workspace);
    try {
      expect(readdirSync(bundle.root).sort()).toEqual([...bundle.files].sort());
      expect(readdirSync(bundle.root)).not.toContain("system-map.md");
      expect(readdirSync(bundle.root)).not.toContain("model");
      expect(JSON.parse(readFileSync(join(bundle.root, "bundle-identity.json"), "utf8"))).toMatchObject({
        schema: "validation-architect/reader-bundle/v1",
        model_identity: compiled.identity,
      });
      expect(JSON.parse(readFileSync(join(bundle.root, "compiler-report.json"), "utf8"))).toMatchObject({
        accepted: true,
        model_identity: compiled.identity,
      });
    } finally {
      removeReaderBundle(bundle);
    }
  });

  it("imports legacy status and non-test evidence only through an explicit reviewed mapping", () => {
    const catalog = `## Contract matrix

| Cell | Family | Layer | Oracle | Risk |
| --- | --- | --- | --- | --- |
| CF-TEST | Tenant detector | 2 | state | E1 |
| CF-EVID | Certification EVIDENCE:incomplete:evidence/cert.json | 4 | artifact | E1 |
`;
    const backlog = `## Wave 0

HB-001 LANDED
HB-002 LANDED

**HB-001 — Tenant validation** CF-TEST.

**HB-002 — Certification review** CF-EVID.
`;
    const control = (id: string) => ({
      id: `NC-${id}`,
      title: `${id} mutation`,
      owner: "OWN-1",
      expected_failure: "The reviewed detector turns red",
    });
    const imported = importLegacyCatalog(catalog, backlog, {
      product: {
        id: "legacy",
        name: "Legacy fixture",
        revision: "deadbeef",
        intended_use: "Reviewed legacy migration fixture",
        criticality: "C1",
        criticality_reason: "Synthetic local migration evidence",
      },
      inner_loop_command: "pnpm test -- --changed",
      owners: [{ id: "OWN-1", name: "Runtime", responsibility: "Own validation" }],
      sources: [{ id: "SRC-1", kind: "doc", path: "docs/PRODUCT.md", locator: "Tenant rule" }],
      structures: [
        {
          id: "CON-1",
          kind: "contract",
          title: "Tenant contract",
          meaning: "Tenant data is isolated",
          owner: "OWN-1",
          source_ids: ["SRC-1"],
          acceptance_criteria: ["Foreign tenant data is never returned"],
        },
      ],
      ticket_reviews: {
        "HB-001": {
          executor: "standing coding agent",
          acceptance_criteria: ["The reviewed legacy tenant detector is implemented at its declared layer and lane"],
        },
        "HB-002": {
          executor: "authorized evidence reviewer",
          acceptance_criteria: ["The reviewed certification evidence is collected at its declared layer and lane"],
        },
      },
      families: {
        "CF-TEST": {
          title: "Tenant detector",
          meaning: "Cross-tenant data is rejected",
          structure_ids: ["CON-1"],
          owner: "OWN-1",
          source_ids: ["SRC-1"],
          control: control("TEST"),
          planned_tests: ["tests/tenant.test.ts"],
        },
        "CF-EVID": {
          title: "Certification evidence",
          meaning: "Certification records the tenant review",
          structure_ids: ["CON-1"],
          owner: "OWN-1",
          source_ids: ["SRC-1"],
          control: control("EVID"),
        },
      },
    });
    const compiled = compileValidationModel(imported.files);
    expect(compiled.accepted).toBe(true);
    expect(compiled.model?.tickets[0]?.status).toBe("landed");
    expect(compiled.model?.families.find((family) => family.id === "CF-EVID")?.evidence).toEqual({
      state: "incomplete",
      path: "evidence/cert.json",
    });
    expect(imported.review_evidence.join(" ")).toMatch(/not retained as machine authority/);
  });
});
