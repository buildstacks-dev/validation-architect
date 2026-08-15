import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { compileValidationModel } from "../src/model-compiler.js";
import { GENERATED_MODEL_VIEWS } from "../src/model-views.js";
import { MODEL_FILE_SCHEMAS, type ModelFileSet } from "../src/model.js";
import { runModelTrace } from "../src/model-trace.js";
import { modelToFidelityManifest, runFidelityAudit } from "../src/fidelity.js";
import { graphFixture } from "./core-graph-fixture.js";

const yaml = (value: unknown): string => stringify(value, { lineWidth: 0 });

function createTarget(shape: "tests" | "mixed"): string {
  const target = mkdtempSync(join(tmpdir(), `vda-model-trace-${shape}-`));
  const fixture = graphFixture();
  if (shape === "mixed") {
    const family = fixture.model.families.find((item) => item.id === "CF-RETRY")!;
    family.lane = "triggered";
    delete family.planned_tests;
    family.evidence = { state: "complete", path: "artifacts/retry-record.json" };
    const ticket = fixture.model.tickets.find((item) => item.id === "HB-RETRY")!;
    ticket.lane = "triggered";
  }
  const files: ModelFileSet = {
    "project.yaml": yaml({ schema: MODEL_FILE_SCHEMAS["project.yaml"], product: fixture.model.product, versions: fixture.model.versions }),
    "owners.yaml": yaml({ schema: MODEL_FILE_SCHEMAS["owners.yaml"], owners: fixture.model.owners }),
    "sources.yaml": yaml({ schema: MODEL_FILE_SCHEMAS["sources.yaml"], sources: fixture.model.sources }),
    "structures.yaml": yaml({ schema: MODEL_FILE_SCHEMAS["structures.yaml"], structures: fixture.model.structures }),
    "policy.yaml": yaml({ schema: MODEL_FILE_SCHEMAS["policy.yaml"], ...fixture.model.policy }),
    "controls.yaml": yaml({ schema: MODEL_FILE_SCHEMAS["controls.yaml"], controls: fixture.model.controls }),
    "families.yaml": yaml({ schema: MODEL_FILE_SCHEMAS["families.yaml"], families: fixture.model.families }),
    "backlog.yaml": yaml({ schema: MODEL_FILE_SCHEMAS["backlog.yaml"], tickets: fixture.model.tickets }),
  };
  const compiled = compileValidationModel(files);
  expect(compiled.accepted, compiled.diagnostics.map((item) => item.message).join("\n")).toBe(true);
  const modelRoot = join(target, "validation-design", "model");
  mkdirSync(modelRoot, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(modelRoot, name), content);
  for (const view of GENERATED_MODEL_VIEWS) writeFileSync(join(target, "validation-design", view), compiled.generated_views[view]!);
  mkdirSync(join(target, "docs"), { recursive: true });
  writeFileSync(join(target, "docs", "contracts.md"), "# Tenant contract\n");
  writeFileSync(join(target, "docs", "retries.md"), "# Retry contract\n");
  mkdirSync(join(target, "tests"), { recursive: true });
  writeFileSync(join(target, "tests", "tenant.test.ts"), "// CF-TENANT (HB-TENANT; tenant contract)\ntest('tenant', () => {});\n");
  if (shape === "tests") writeFileSync(join(target, "tests", "retry.test.ts"), "// CF-RETRY (HB-RETRY; retry invariant)\ntest('retry', () => {});\n");
  else {
    mkdirSync(join(target, "artifacts"), { recursive: true });
    writeFileSync(join(target, "artifacts", "retry-record.json"), "{}\n");
  }
  return target;
}

describe("checked-model Validation Trace host adapter", () => {
  it("closes two product-agnostic offline shapes without claiming fidelity", () => {
    for (const shape of ["tests", "mixed"] as const) {
      const result = runModelTrace(createTarget(shape), { modelPath: "validation-design/model", testsRoot: "tests", environment: "offline-fixture" });
      expect(result.ok, result.reds.join("\n")).toBe(true);
      expect(result.graph?.structurally_closed).toBe(true);
      expect(result.report).toContain("This proves relationships and artifact existence, not oracle fidelity or product behavior");
      expect(result.report).toContain("Required check: **Validation Trace**");
    }
  });

  it("fails closed on generated drift and absent test roots", () => {
    const stale = createTarget("tests");
    writeFileSync(join(stale, "validation-design", "case-catalog.md"), "# stale\n");
    expect(runModelTrace(stale, { modelPath: "validation-design/model" }).reds.join("\n")).toMatch(/differs semantically|stale/i);

    const absent = createTarget("tests");
    const result = runModelTrace(absent, { modelPath: "validation-design/model", testsRoot: "missing-tests" });
    expect(result.ok).toBe(false);
    expect(result.reds.join("\n")).toContain("TESTS_ROOT_ABSENT");
  });

  it("keeps the deprecated binary as a thin shim over the core check path", () => {
    const shim = readFileSync(join(process.cwd(), "src", "trace-cli.ts"), "utf8");
    expect(shim).toContain('coreMain(["check", ...argv])');
    expect(shim).not.toContain("runModelTrace");
  });

  it("projects current model facts for fidelity scope and refuses trace-red before a provider call", async () => {
    const manifest = modelToFidelityManifest(graphFixture().model);
    expect(manifest).toMatchObject({
      schema: "validation-architect/fidelity-scope-adapter/v1",
      families: expect.arrayContaining([expect.objectContaining({ id: "CF-TENANT", ticket: "HB-TENANT", status: "implementable" })]),
      tickets: expect.arrayContaining([expect.objectContaining({ id: "HB-TENANT", status: "landed" })]),
    });
    const target = createTarget("tests");
    writeFileSync(join(target, "validation-design", "planned-trace.md"), "# stale\n");
    let providerCalls = 0;
    const result = await runFidelityAudit({ run: async () => { providerCalls++; return "unreachable"; } }, target);
    expect(result.status).toBe("refused-closure");
    expect(result.reds.join(" ")).toMatch(/differs semantically|stale/i);
    expect(providerCalls).toBe(0);
  });
});
