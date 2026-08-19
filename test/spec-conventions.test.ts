import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { FakeRepositoryPort } from "../src/api/conformance.js";
import { check, explain } from "../src/api/entry-points.js";
import { isPublicContractError } from "../src/api/errors.js";
import { compileValidationModel } from "../src/model-compiler.js";
import { runModelTrace } from "../src/model-trace.js";
import type { ModelFileSet, ModelFilename } from "../src/model.js";
import { MODEL_FILES } from "../src/model.js";
import {
  DEFAULT_SPEC_CONVENTIONS,
  SPEC_RUNNER_PRESETS,
  countTestCallSites,
  firstSpecHeader,
  isSpecPath,
  type SpecConventions,
} from "../src/spec-conventions.js";
import { compileWorkspaceModel } from "../src/workspace-compiler.js";
import { writeValidModel } from "./model-corpus-fixture.js";

/**
 * Spec detection as a per-repo convention (issue #88): the checked model's
 * reviewed `conventions` block in project.yaml selects a runner preset or a
 * custom detection pattern; the default is byte-for-byte today's JS/TS
 * behavior; unknown or ambiguous conventions fail closed at compile time.
 * Every preset and the custom path carries its red negative-control case.
 */

const tmp = mkdtempSync(join(tmpdir(), "va-spec-conventions-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function walk(root: string, dir = root): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(root, path) : [relative(root, path)];
  });
}

function fixtureFiles(): Record<string, string> {
  const dir = join(tmp, `ws-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeValidModel(dir);
  writeFileSync(join(dir, "docs", "PRODUCT.md"), "# Product\n\nContract\n");
  const files: Record<string, string> = {};
  for (const path of walk(dir)) files[path.replaceAll("\\", "/")] = readFileSync(join(dir, path), "utf8");
  return files;
}

function modelFiles(files: Record<string, string>): ModelFileSet {
  const set = {} as ModelFileSet;
  for (const file of MODEL_FILES) set[file as ModelFilename] = files[`validation-design/model/${file}`] as string;
  return set;
}

function withConventions(files: Record<string, string>, conventions: unknown): void {
  const path = "validation-design/model/project.yaml";
  const project = parse(files[path] as string) as Record<string, unknown>;
  project.conventions = conventions;
  files[path] = stringify(project, { lineWidth: 0 });
}

interface ConventionRepoOptions {
  /** conventions block for project.yaml; omit to keep the JS/TS default. */
  conventions?: unknown;
  /** planned_tests replacement for the single fixture family. */
  plannedTest: string;
  /** Repository spec/tests files. */
  specs: Record<string, string>;
  ticketStatus?: "pending" | "landed";
}

function conventionRepo(options: ConventionRepoOptions): FakeRepositoryPort {
  const files = fixtureFiles();
  if (options.conventions !== undefined) withConventions(files, options.conventions);
  const familiesPath = "validation-design/model/families.yaml";
  const families = parse(files[familiesPath] as string) as { families: Array<Record<string, unknown>> };
  (families.families[0] as Record<string, unknown>).planned_tests = [options.plannedTest];
  files[familiesPath] = stringify(families, { lineWidth: 0 });
  if (options.ticketStatus === "landed") {
    const backlogPath = "validation-design/model/backlog.yaml";
    files[backlogPath] = (files[backlogPath] as string).replace("status: pending", "status: landed");
  }
  // The mutated corpus makes the generated views stale; the check path treats
  // regenerable views as warnings, so drop them exactly like splitFamilyRepo.
  for (const path of Object.keys(files)) {
    if (path.startsWith("validation-design/") && !path.startsWith("validation-design/model/")) delete files[path];
  }
  for (const [path, content] of Object.entries(options.specs)) files[path] = content;
  return new FakeRepositoryPort({ revision: "abc123", files });
}

async function findingCodes(repo: FakeRepositoryPort): Promise<string[]> {
  const { graph } = await explain(repo, "CF-X01-S");
  return [...new Set(graph.findings.map((finding) => finding.code))].sort();
}

const JS_SPEC = [
  "// Family: CF-X01-S",
  "// Ticket: HB-001",
  "it('preserves the stable response', () => {});",
  "it('turns red when the stable response changes', () => {});",
  "",
].join("\n");

const PYTEST_SPEC = [
  "# Family: CF-X01-S",
  "# Ticket: HB-001",
  "def test_preserves_stable_response():",
  "    assert True",
  "",
  "async def test_turns_red_when_mutated():",
  "    assert True",
  "",
].join("\n");

const GO_SPEC = [
  "// Family: CF-X01-S",
  "// Ticket: HB-001",
  "package fixture",
  "",
  "func TestPreservesStableResponse(t *testing.T) {}",
  "",
  "func TestTurnsRedWhenMutated(t *testing.T) {}",
  "",
].join("\n");

const LUA_CUSTOM_CONVENTIONS = {
  runner: "custom",
  spec_suffixes: ["_check.lua"],
  test_call_pattern: "^\\s*function\\s+test_\\w+",
  header_comment_styles: ["dash-line"],
};

const LUA_SPEC = [
  "-- Family: CF-X01-S",
  "-- Ticket: HB-001",
  "function test_preserves_stable_response()",
  "end",
  "",
  "function test_turns_red_when_mutated()",
  "end",
  "",
].join("\n");

describe("runner presets", () => {
  it("keeps the default identical to the previously hardcoded JS/TS behavior", () => {
    expect(DEFAULT_SPEC_CONVENTIONS.runner).toBe("jest-vitest");
    expect(DEFAULT_SPEC_CONVENTIONS.spec_suffixes).toEqual([".test.ts", ".test.tsx", ".test.js", ".test.mjs", ".spec.ts"]);
    expect(DEFAULT_SPEC_CONVENTIONS.test_call_pattern).toBe(String.raw`^\s*(?:it|test)(?:\.\w+)?\s*\(`);
    expect(DEFAULT_SPEC_CONVENTIONS.header_comment_styles).toEqual(["slash-line", "slash-block"]);
    expect(countTestCallSites(JS_SPEC, DEFAULT_SPEC_CONVENTIONS)).toBe(2);
    expect(countTestCallSites("test.skip('quarantined', () => {});\nit.each([1])('n', () => {});\n", DEFAULT_SPEC_CONVENTIONS)).toBe(2);
    expect(firstSpecHeader("/* Family: CF-X01-S */\nit('x', () => {});\n", DEFAULT_SPEC_CONVENTIONS)).toContain("CF-X01-S");
  });

  const table: Array<{ runner: string; match: string[]; reject: string[]; green: string; red: string }> = [
    {
      runner: "jest-vitest",
      match: ["tests/a.test.ts", "tests/a.spec.ts", "tests/nested/a.test.mjs"],
      reject: ["tests/a.ts", "tests/a_test.py", "tests/a.test.ts.bak"],
      green: JS_SPEC,
      red: "// Family: CF-X01-S\nconst helper = () => {};\n",
    },
    {
      runner: "pytest",
      match: ["tests/a_test.py", "tests/test_a.py", "tests/nested/test_a.py"],
      reject: ["tests/a.py", "tests/latest.py", "tests/test_a.pyc", "tests/a.test.ts"],
      green: PYTEST_SPEC,
      red: "# Family: CF-X01-S\ndef helper():\n    pass\n",
    },
    {
      runner: "go-test",
      match: ["tests/a_test.go"],
      reject: ["tests/a.go", "tests/a_test.py"],
      green: GO_SPEC,
      red: "// Family: CF-X01-S\npackage fixture\n\nfunc helper() {}\n",
    },
    {
      runner: "junit",
      match: ["tests/FixtureTest.java", "tests/FixtureTests.java", "tests/FixtureTestCase.java", "tests/FixtureIT.java"],
      reject: ["tests/Fixture.java", "tests/FixtureTest.kt"],
      green: "// Family: CF-X01-S\nclass FixtureTest {\n  @Test\n  void preserves() {}\n  @ParameterizedTest\n  void turnsRed() {}\n}\n",
      red: "// Family: CF-X01-S\nclass FixtureTest {\n  void helper() {}\n}\n",
    },
  ];

  it.each(table)("preset $runner recognizes its files, headers, and call sites, red-capable on empty specs", ({ runner, match, reject, green, red }) => {
    const preset = SPEC_RUNNER_PRESETS[runner] as SpecConventions;
    expect(preset).toBeDefined();
    for (const path of match) expect(isSpecPath(path, preset), `${runner} should match ${path}`).toBe(true);
    for (const path of reject) expect(isSpecPath(path, preset), `${runner} should reject ${path}`).toBe(false);
    expect(countTestCallSites(green, preset)).toBeGreaterThan(0);
    expect(firstSpecHeader(green, preset)).toContain("CF-X01-S");
    // Negative control: a spec with no executable call site stays observable.
    expect(countTestCallSites(red, preset)).toBe(0);
    // Negative control: a headerless spec stays observable.
    expect(firstSpecHeader(green.split("\n").slice(2).join("\n"), preset)).toBeUndefined();
  });

  it("reads pytest docstring headers and custom dash-line headers", () => {
    const pytest = SPEC_RUNNER_PRESETS["pytest"] as SpecConventions;
    expect(firstSpecHeader('"""Family: CF-X01-S (HB-001)."""\ndef test_a():\n    pass\n', pytest)).toContain("CF-X01-S");
    expect(firstSpecHeader(LUA_SPEC, LUA_CUSTOM_CONVENTIONS as unknown as SpecConventions)).toContain("CF-X01-S");
  });
});

describe("compiler conventions block", () => {
  it("compiles without a conventions block to the exact prior identity shape", () => {
    const files = modelFiles(fixtureFiles());
    const first = compileValidationModel(files);
    const second = compileValidationModel(files);
    expect(first.accepted).toBe(true);
    expect(first.model?.conventions).toBeUndefined();
    expect(first.canonical_model).not.toContain("conventions:");
    expect(second.identity).toBe(first.identity);
  });

  it("resolves a named preset into the compiled model and records it in the identity", () => {
    const raw = fixtureFiles();
    const base = compileValidationModel(modelFiles(raw));
    withConventions(raw, { runner: "pytest" });
    const compiled = compileValidationModel(modelFiles(raw));
    expect(compiled.accepted, compiled.diagnostics.map((item) => item.message).join("\n")).toBe(true);
    expect(compiled.model?.conventions).toEqual(SPEC_RUNNER_PRESETS["pytest"]);
    expect(compiled.canonical_model).toContain("runner: pytest");
    expect(compiled.identity).not.toBe(base.identity);
  });

  it("accepts an explicit jest-vitest preset as the same detection block as the default", () => {
    const raw = fixtureFiles();
    withConventions(raw, { runner: "jest-vitest" });
    const compiled = compileValidationModel(modelFiles(raw));
    expect(compiled.accepted).toBe(true);
    expect(compiled.model?.conventions).toEqual(DEFAULT_SPEC_CONVENTIONS);
  });

  it("records a custom detection block verbatim in the compiled identity", () => {
    const raw = fixtureFiles();
    const base = compileValidationModel(modelFiles(raw));
    withConventions(raw, LUA_CUSTOM_CONVENTIONS);
    const compiled = compileValidationModel(modelFiles(raw));
    expect(compiled.accepted, compiled.diagnostics.map((item) => item.message).join("\n")).toBe(true);
    expect(compiled.model?.conventions).toEqual(LUA_CUSTOM_CONVENTIONS);
    expect(compiled.canonical_model).toContain("_check.lua");
    expect(compiled.canonical_model).toContain("test_call_pattern");
    expect(compiled.identity).not.toBe(base.identity);
  });

  it("fails closed on an unknown or missing runner instead of falling back to JS/TS", () => {
    for (const conventions of [{ runner: "mocha" }, {}]) {
      const raw = fixtureFiles();
      withConventions(raw, conventions);
      const compiled = compileValidationModel(modelFiles(raw));
      expect(compiled.accepted).toBe(false);
      expect(compiled.diagnostics).toContainEqual(
        expect.objectContaining({ code: "MODEL_CONVENTIONS_RUNNER_UNKNOWN", severity: "error" }),
      );
    }
  });

  it("fails closed when a preset is mixed with custom detection fields", () => {
    const raw = fixtureFiles();
    withConventions(raw, { runner: "pytest", spec_suffixes: ["_spec.py"] });
    const compiled = compileValidationModel(modelFiles(raw));
    expect(compiled.accepted).toBe(false);
    expect(compiled.diagnostics).toContainEqual(
      expect.objectContaining({ code: "MODEL_CONVENTIONS_AMBIGUOUS", severity: "error" }),
    );
  });

  it("rejects unknown fields inside the conventions block", () => {
    const raw = fixtureFiles();
    withConventions(raw, { runner: "pytest", frameworks: ["pytest"] });
    const compiled = compileValidationModel(modelFiles(raw));
    expect(compiled.accepted).toBe(false);
    expect(compiled.diagnostics).toContainEqual(
      expect.objectContaining({ code: "MODEL_FIELD_UNKNOWN", concept: "conventions" }),
    );
  });

  it("rejects incomplete or invalid custom detection blocks with field diagnostics", () => {
    const invalid: unknown[] = [
      { ...LUA_CUSTOM_CONVENTIONS, spec_suffixes: [] },
      { ...LUA_CUSTOM_CONVENTIONS, spec_suffixes: ["ok", ""] },
      { runner: "custom", test_call_pattern: "^x", header_comment_styles: ["dash-line"] },
      { ...LUA_CUSTOM_CONVENTIONS, test_call_pattern: "([" },
      { ...LUA_CUSTOM_CONVENTIONS, test_call_pattern: "x*" },
      { ...LUA_CUSTOM_CONVENTIONS, header_comment_styles: ["semicolon-line"] },
      { ...LUA_CUSTOM_CONVENTIONS, header_comment_styles: ["dash-line", "dash-line"] },
      { ...LUA_CUSTOM_CONVENTIONS, header_comment_styles: [] },
      "pytest",
    ];
    for (const conventions of invalid) {
      const raw = fixtureFiles();
      withConventions(raw, conventions);
      const compiled = compileValidationModel(modelFiles(raw));
      expect(compiled.accepted, `should reject ${JSON.stringify(conventions)}`).toBe(false);
      expect(
        compiled.diagnostics.some(
          (item) => item.severity === "error" && item.concept === "conventions" && item.code === "MODEL_FIELD_INVALID",
        ),
        `should name conventions in a MODEL_FIELD_INVALID for ${JSON.stringify(conventions)}`,
      ).toBe(true);
    }
  });
});

describe("check() closure under configured conventions", () => {
  it("closes a pytest tests root identically to the JS/TS twin through configuration alone", async () => {
    const jsTwin = conventionRepo({ plannedTest: "tests/fixture.test.ts", specs: { "tests/fixture.test.ts": JS_SPEC } });
    const pytest = conventionRepo({
      conventions: { runner: "pytest" },
      plannedTest: "tests/unit/fixture_test.py",
      specs: { "tests/unit/fixture_test.py": PYTEST_SPEC },
    });
    const jsResult = await check(jsTwin);
    const pyResult = await check(pytest);
    expect(pyResult.verdict).toBe(jsResult.verdict);
    expect(pyResult.completeness).toBe(jsResult.completeness);
    expect(pyResult.reason).toBe(jsResult.reason);
    expect(pyResult.verdict).toBe("inconclusive");
    expect(pyResult.reason).toBe("evidence_incomplete");
    expect(await findingCodes(pytest)).toEqual(await findingCodes(jsTwin));
  });

  it("recognizes the pytest test_*.py basename form", async () => {
    const repo = conventionRepo({
      conventions: { runner: "pytest" },
      plannedTest: "tests/test_fixture.py",
      specs: { "tests/test_fixture.py": PYTEST_SPEC },
    });
    const result = await check(repo);
    expect(result.verdict).toBe("inconclusive");
    expect(JSON.stringify(result.extensions)).not.toContain("ORPHAN_TEST");
    expect(JSON.stringify(result.extensions)).not.toContain("IMPLEMENTATION_PENDING");
  });

  it("keeps orphan detection red under the pytest preset", async () => {
    const repo = conventionRepo({
      conventions: { runner: "pytest" },
      plannedTest: "tests/fixture_test.py",
      specs: { "tests/fixture_test.py": PYTEST_SPEC, "tests/extra_test.py": PYTEST_SPEC },
    });
    const result = await check(repo);
    expect(result.verdict).toBe("fail");
    expect(JSON.stringify(result.extensions)).toContain("ORPHAN_TEST");
  });

  it("keeps IMPLEMENTATION_PENDING and CONTROL_UNIMPLEMENTED status-aware under the pytest preset", async () => {
    const pending = await check(
      conventionRepo({ conventions: { runner: "pytest" }, plannedTest: "tests/fixture_test.py", specs: { "tests/.keep": "" } }),
    );
    expect(pending.verdict).toBe("inconclusive");
    expect(JSON.stringify(pending.extensions)).toContain("IMPLEMENTATION_PENDING");
    expect(JSON.stringify(pending.extensions)).toContain("CONTROL_IMPLEMENTATION_PENDING");
    expect(JSON.stringify(pending.extensions)).not.toContain("CONTROL_UNIMPLEMENTED");

    const landed = await check(
      conventionRepo({
        conventions: { runner: "pytest" },
        plannedTest: "tests/fixture_test.py",
        specs: { "tests/.keep": "" },
        ticketStatus: "landed",
      }),
    );
    expect(landed.verdict).toBe("fail");
    expect(JSON.stringify(landed.extensions)).toContain("LANDED_STATUS_FALSE");
    expect(JSON.stringify(landed.extensions)).toContain("CONTROL_UNIMPLEMENTED");
  });

  it("stays red-capable per preset: empty and headerless pytest specs fail closure", async () => {
    const empty = await check(
      conventionRepo({
        conventions: { runner: "pytest" },
        plannedTest: "tests/fixture_test.py",
        specs: { "tests/fixture_test.py": "# Family: CF-X01-S\n# Ticket: HB-001\ndef helper():\n    pass\n" },
      }),
    );
    expect(empty.verdict).toBe("fail");
    expect(JSON.stringify(empty.extensions)).toContain("SPEC_CASE_MISSING");

    const headerless = await check(
      conventionRepo({
        conventions: { runner: "pytest" },
        plannedTest: "tests/fixture_test.py",
        specs: { "tests/fixture_test.py": "import fixture\n\ndef test_a():\n    pass\n" },
      }),
    );
    expect(headerless.verdict).toBe("fail");
    expect(JSON.stringify(headerless.extensions)).toContain("SPEC_HEADER_MISSING");
  });

  it("never observes pytest files without the configured preset (fail-closed default)", async () => {
    const repo = conventionRepo({
      plannedTest: "tests/fixture_test.py",
      specs: { "tests/fixture_test.py": PYTEST_SPEC },
    });
    const result = await check(repo);
    // The default JS/TS convention cannot see the pytest spec: the family
    // stays visibly unimplemented instead of silently closing.
    expect(result.verdict).toBe("inconclusive");
    expect(JSON.stringify(result.extensions)).toContain("IMPLEMENTATION_PENDING");
  });

  it("refuses to run the gate over an unknown convention", async () => {
    const repo = conventionRepo({
      conventions: { runner: "mocha" },
      plannedTest: "tests/fixture.test.ts",
      specs: { "tests/fixture.test.ts": JS_SPEC },
    });
    await expect(check(repo)).rejects.toSatisfy((error: unknown) => isPublicContractError(error, "invalid_input"));
  });

  it("closes a go-test tests root and stays red-capable on an empty spec", async () => {
    const green = await check(
      conventionRepo({
        conventions: { runner: "go-test" },
        plannedTest: "tests/fixture_test.go",
        specs: { "tests/fixture_test.go": GO_SPEC },
      }),
    );
    expect(green.verdict).toBe("inconclusive");
    expect(green.reason).toBe("evidence_incomplete");
    expect(JSON.stringify(green.extensions)).not.toContain("SPEC_HEADER_MISSING");
    expect(JSON.stringify(green.extensions)).not.toContain("IMPLEMENTATION_PENDING");

    const red = await check(
      conventionRepo({
        conventions: { runner: "go-test" },
        plannedTest: "tests/fixture_test.go",
        specs: { "tests/fixture_test.go": "// Family: CF-X01-S\npackage fixture\n\nfunc helper() {}\n" },
      }),
    );
    expect(red.verdict).toBe("fail");
    expect(JSON.stringify(red.extensions)).toContain("SPEC_CASE_MISSING");
  });

  it("closes a custom-pattern tests root and stays red-capable on an empty spec", async () => {
    const green = await check(
      conventionRepo({
        conventions: LUA_CUSTOM_CONVENTIONS,
        plannedTest: "tests/fixture_check.lua",
        specs: { "tests/fixture_check.lua": LUA_SPEC },
      }),
    );
    expect(green.verdict).toBe("inconclusive");
    expect(green.reason).toBe("evidence_incomplete");
    expect(JSON.stringify(green.extensions)).not.toContain("SPEC_HEADER_MISSING");
    expect(JSON.stringify(green.extensions)).not.toContain("IMPLEMENTATION_PENDING");

    const red = await check(
      conventionRepo({
        conventions: LUA_CUSTOM_CONVENTIONS,
        plannedTest: "tests/fixture_check.lua",
        specs: { "tests/fixture_check.lua": "-- Family: CF-X01-S\nlocal helper = 1\n" },
      }),
    );
    expect(red.verdict).toBe("fail");
    expect(JSON.stringify(red.extensions)).toContain("SPEC_CASE_MISSING");
  });
});

describe("trace host under configured conventions", () => {
  function pytestTarget(spec: string): string {
    const target = mkdtempSync(join(tmpdir(), "va-trace-pytest-"));
    writeValidModel(target);
    const modelRoot = join(target, "validation-design", "model");
    const projectPath = join(modelRoot, "project.yaml");
    const project = parse(readFileSync(projectPath, "utf8")) as Record<string, unknown>;
    project.conventions = { runner: "pytest" };
    writeFileSync(projectPath, stringify(project, { lineWidth: 0 }));
    const familiesPath = join(modelRoot, "families.yaml");
    const families = parse(readFileSync(familiesPath, "utf8")) as { families: Array<Record<string, unknown>> };
    (families.families[0] as Record<string, unknown>).planned_tests = ["tests/fixture_test.py"];
    writeFileSync(familiesPath, stringify(families, { lineWidth: 0 }));
    const compiled = compileWorkspaceModel(target, { regenerate: true });
    if (!compiled.accepted) throw new Error(compiled.diagnostics.map((item) => item.message).join("\n"));
    mkdirSync(join(target, "docs"), { recursive: true });
    writeFileSync(join(target, "docs", "PRODUCT.md"), "# Product\n\nContract\n");
    mkdirSync(join(target, "tests"), { recursive: true });
    writeFileSync(join(target, "tests", "fixture_test.py"), spec);
    return target;
  }

  it("closes a hash-commented pytest spec through the checked model's convention", () => {
    const result = runModelTrace(pytestTarget("# CF-X01-S (HB-001; fixture contract)\ndef test_fixture():\n    assert True\n"), {
      testsRoot: "tests",
      environment: "offline-fixture",
    });
    expect(result.ok, result.reds.join("\n")).toBe(true);
    expect(result.graph?.structurally_closed).toBe(true);
    expect(result.inventory?.tests[0]).toMatchObject({ path: "tests/fixture_test.py", family_ids: ["CF-X01-S"], case_count: 1 });
  });

  it("stays red-capable: a pytest spec with no test function is an observed empty spec", () => {
    const result = runModelTrace(pytestTarget("# CF-X01-S (HB-001; fixture contract)\ndef helper():\n    pass\n"), {
      testsRoot: "tests",
      environment: "offline-fixture",
    });
    expect(result.inventory?.tests[0]?.case_count).toBe(0);
  });
});
