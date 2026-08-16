import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeRepositoryPort } from "../src/api/conformance.js";
import { compile } from "../src/api/entry-points.js";
import { MODEL_FILES } from "../src/model.js";
import { GENERATED_MODEL_VIEWS } from "../src/model-views.js";
import { COMPILER_VERSION, CURRENT_CORE_VERSIONS } from "../src/versions.js";
import { compileWorkspaceModel } from "../src/workspace-compiler.js";
import { writeValidModel } from "./model-corpus-fixture.js";

const EXPECTED_MODEL_FILES = [
  "project.yaml",
  "owners.yaml",
  "sources.yaml",
  "structures.yaml",
  "policy.yaml",
  "controls.yaml",
  "families.yaml",
  "backlog.yaml",
] as const;
const EXPECTED_MARKDOWN_VIEWS = [
  "case-catalog.md",
  "harness-backlog.md",
  "owner-briefing.md",
  "owner-backlog.md",
  "planned-trace.md",
] as const;

const workspaces: string[] = [];
afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "va-compiler-report-"));
  workspaces.push(root);
  mkdirSync(root, { recursive: true });
  writeValidModel(root);
  return root;
}

function modelFiles(root: string): Record<string, string> {
  return Object.fromEntries(
    EXPECTED_MODEL_FILES.map((file) => [
      `validation-design/model/${file}`,
      readFileSync(join(root, "validation-design", "model", file), "utf8"),
    ]),
  );
}

function independentlyFingerprint(files: Readonly<Record<string, string>>): string {
  const hash = createHash("sha256");
  for (const file of EXPECTED_MODEL_FILES) {
    hash.update(file).update("\0");
    hash.update(files[`validation-design/model/${file}`] ?? "<missing>").update("\0");
  }
  return hash.digest("hex");
}

describe("canonical compiler/v1 report", () => {
  it("fixes the report input and generated surface at eight ordered YAML files and five Markdown views", () => {
    expect(MODEL_FILES).toEqual(EXPECTED_MODEL_FILES);
    expect(GENERATED_MODEL_VIEWS).toEqual(EXPECTED_MARKDOWN_VIEWS);
  });

  it("returns the complete valid record and exact canonical bytes from the public API", async () => {
    const root = workspace();
    const files = modelFiles(root);
    const output = await compile(new FakeRepositoryPort({ revision: "abc123", files }));

    expect(output.report.record).toEqual({
      schema: COMPILER_VERSION,
      accepted: true,
      source_fingerprint: independentlyFingerprint(files),
      model_identity: output.identity,
      versions: CURRENT_CORE_VERSIONS,
      generated_views: [...EXPECTED_MARKDOWN_VIEWS].sort(),
      diagnostics: [],
    });
    expect(output.report.content).toBe(`${JSON.stringify(output.report.record, null, 2)}\n`);
    expect(Object.keys(output.views).sort()).toEqual([...EXPECTED_MARKDOWN_VIEWS].sort());
  });

  it("returns source-located errors and null accepted identity fields for invalid input", async () => {
    const root = workspace();
    const files = modelFiles(root);
    delete files["validation-design/model/families.yaml"];
    const output = await compile(new FakeRepositoryPort({ revision: "abc123", files }));

    expect(output.accepted).toBe(false);
    expect(output.report.record).toMatchObject({
      schema: COMPILER_VERSION,
      accepted: false,
      source_fingerprint: independentlyFingerprint(files),
      model_identity: null,
      versions: null,
      generated_views: [],
    });
    expect(output.report.record.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "MODEL_FILE_MISSING",
          location: { file: "validation-design/model/families.yaml", line: 1, column: 1 },
        }),
      ]),
    );
    expect(output.report.record.diagnostics.every((diagnostic) => diagnostic.severity === "error")).toBe(true);
    expect(output.report.content).toBe(`${JSON.stringify(output.report.record, null, 2)}\n`);
  });

  it("uses byte-identical public and workspace reports for identical valid and invalid model bytes", async () => {
    const root = workspace();
    const validFiles = modelFiles(root);
    const publicValid = await compile(new FakeRepositoryPort({ revision: "abc123", files: validFiles }));
    const workspaceValid = compileWorkspaceModel(root, { regenerate: true });
    expect(workspaceValid.report.content).toBe(publicValid.report.content);
    expect(readFileSync(workspaceValid.report_path, "utf8")).toBe(publicValid.report.content);

    unlinkSync(join(root, "validation-design", "model", "families.yaml"));
    const invalidFiles = { ...validFiles };
    delete invalidFiles["validation-design/model/families.yaml"];
    const publicInvalid = await compile(new FakeRepositoryPort({ revision: "abc123", files: invalidFiles }));
    const workspaceInvalid = compileWorkspaceModel(root, { regenerate: true });
    expect(workspaceInvalid.report.content).toBe(publicInvalid.report.content);
    expect(readFileSync(workspaceInvalid.report_path, "utf8")).toBe(publicInvalid.report.content);
  });

  it("binds exact bytes and explicit missing markers in the eight-file order", async () => {
    const root = workspace();
    const files = modelFiles(root);
    const baseline = await compile(new FakeRepositoryPort({ revision: "abc123", files }));
    const changed = { ...files, "validation-design/model/owners.yaml": `${files["validation-design/model/owners.yaml"]}# byte\n` };
    const missing = { ...files };
    delete missing["validation-design/model/owners.yaml"];

    const changedReport = await compile(new FakeRepositoryPort({ revision: "abc123", files: changed }));
    const missingReport = await compile(new FakeRepositoryPort({ revision: "abc123", files: missing }));
    expect(baseline.report.record.source_fingerprint).toBe(independentlyFingerprint(files));
    expect(changedReport.report.record.source_fingerprint).toBe(independentlyFingerprint(changed));
    expect(missingReport.report.record.source_fingerprint).toBe(independentlyFingerprint(missing));
    expect(new Set([
      baseline.report.record.source_fingerprint,
      changedReport.report.record.source_fingerprint,
      missingReport.report.record.source_fingerprint,
    ]).size).toBe(3);
  });
});
