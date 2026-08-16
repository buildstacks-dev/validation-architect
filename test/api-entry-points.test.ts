import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { FakeRepositoryPort } from "../src/api/conformance.js";
import { check, compile, explain, ingest, migrate, plan, render } from "../src/api/entry-points.js";
import { isPublicContractError } from "../src/api/errors.js";
import { CORPUS_SCHEMA, canonicalJson } from "../src/api/schemas.js";
import { isGreenValidationResult } from "../src/validation-result.js";
import { writeValidModel } from "./model-corpus-fixture.js";

/**
 * VA-API-003 conformance: the seven deterministic entry points over a fake
 * RepositoryPort only — no ambient filesystem read, Git, provider, or network
 * inside the functions under test. The temp directory below exists solely to
 * reuse the shared corpus fixture; its contents are loaded into memory first.
 */

const tmp = mkdtempSync(join(tmpdir(), "va-api-entry-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function walk(root: string, dir = root): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(root, path) : [relative(root, path)];
  });
}

const GREEN_SPEC = [
  "// Family: CF-X01-S",
  "// Ticket: HB-001",
  "it('preserves the stable response', () => {});",
  "it('turns red when the stable response changes', () => {});",
  "",
].join("\n");

function fixtureFiles(): Record<string, string> {
  const dir = join(tmp, `ws-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeValidModel(dir);
  writeFileSync(join(dir, "docs", "PRODUCT.md"), "# Product\n\nContract\n");
  const files: Record<string, string> = {};
  for (const path of walk(dir)) files[path.replaceAll("\\", "/")] = readFileSync(join(dir, path), "utf8");
  files["tests/fixture.test.ts"] = GREEN_SPEC;
  return files;
}

function greenRepo(overrides: Record<string, string | null> = {}, revision = "abc123"): FakeRepositoryPort {
  const files = fixtureFiles();
  for (const [path, content] of Object.entries(overrides)) {
    if (content === null) delete files[path];
    else files[path] = content;
  }
  return new FakeRepositoryPort({ revision, files });
}

function repoWithTicketStatus(
  status: "pending" | "landed" | "blocked" | "parked",
  overrides: Record<string, string | null> = {},
): FakeRepositoryPort {
  const files = fixtureFiles();
  const backlogPath = "validation-design/model/backlog.yaml";
  const backlog = files[backlogPath];
  if (!backlog) throw new Error("fixture is missing backlog.yaml");
  files[backlogPath] = backlog.replace("status: pending", `status: ${status}`);
  for (const [path, content] of Object.entries(overrides)) {
    if (content === null) delete files[path];
    else files[path] = content;
  }
  return new FakeRepositoryPort({ revision: "abc123", files });
}

function splitFamilyRepo(): FakeRepositoryPort {
  const files = fixtureFiles();
  const controlsPath = "validation-design/model/controls.yaml";
  const familiesPath = "validation-design/model/families.yaml";
  const backlogPath = "validation-design/model/backlog.yaml";
  const controls = parse(files[controlsPath] ?? "") as { controls: Array<Record<string, unknown>> };
  const families = parse(files[familiesPath] ?? "") as { families: Array<Record<string, unknown>> };
  const backlog = parse(files[backlogPath] ?? "") as { tickets: Array<Record<string, unknown>> };
  controls.controls.push({
    id: "NC-X01-R",
    title: "Fixture refusal mutation",
    family_id: "CF-X01-R",
    owner: "OWN-1",
    expected_failure: "The refusal detector turns red when mutation happens before refusal",
  });
  families.families.push({
    id: "CF-X01-R",
    title: "Fixture refusal path",
    meaning: "An invalid fixture response refuses before mutation",
    structure_ids: ["CON-1"],
    owner: "OWN-1",
    source_ids: ["SRC-1"],
    lane: "per-commit",
    status: "implementable",
    layer: "L2",
    oracle: "refusal",
    risk: "E1",
    control_ids: ["NC-X01-R"],
    ticket: "HB-002",
    planned_tests: ["tests/fixture.test.ts"],
  });
  backlog.tickets.push({
    id: "HB-002",
    title: "Minimal refusal harness",
    wave: "0",
    status: "pending",
    owner: "OWN-1",
    executor: "standing coding agent",
    lane: "per-commit",
    layer: "L2",
    acceptance_criteria: ["The refusal detector and negative control pass in the per-commit lane"],
    family_ids: ["CF-X01-R"],
  });
  files[controlsPath] = stringify(controls, { lineWidth: 0 });
  files[familiesPath] = stringify(families, { lineWidth: 0 });
  files[backlogPath] = stringify(backlog, { lineWidth: 0 });
  for (const path of Object.keys(files)) {
    if (path.startsWith("validation-design/") && !path.startsWith("validation-design/model/")) {
      delete files[path];
    }
  }
  files["tests/fixture.test.ts"] = [
    "// Historical family: CF-LEGACY-COMPOSITE",
    "// Historical ticket: HB-HISTORICAL",
    "it('preserves the split obligations', () => {});",
    "",
  ].join("\n");
  return new FakeRepositoryPort({ revision: "abc123", files });
}

describe("compile", () => {
  it("returns findings and regenerated views as data for a valid corpus", async () => {
    const output = await compile(greenRepo());
    expect(output.accepted).toBe(true);
    expect(output.identity).toBeTruthy();
    expect(output.findings.filter((item) => item.severity === "error")).toEqual([]);
    expect(Object.keys(output.views).length).toBeGreaterThan(0);
  });

  it("returns source-located author findings for an invalid corpus and never an accepted bundle", async () => {
    const output = await compile(greenRepo({ "validation-design/model/families.yaml": "schema: wrong\n" }));
    expect(output.accepted).toBe(false);
    expect(output.findings.some((item) => item.severity === "error")).toBe(true);
    expect(output.identity).toBeUndefined();
  });
});

describe("check", () => {
  it("reports a closed trace with structural-only evidence as explicitly incomplete, never green by absence", async () => {
    const first = await check(greenRepo());
    const second = await check(greenRepo());
    // Structural closure alone is not product green: the fail-closed record
    // says closed-but-evidence-partial and the green predicate stays false.
    expect(first.verdict).toBe("inconclusive");
    expect(first.completeness).toBe("incomplete");
    expect(first.reason).toBe("evidence_incomplete");
    expect(isGreenValidationResult(first)).toBe(false);
    expect(canonicalJson(first)).toBe(canonicalJson(second));
  });

  it("keeps an unimplemented family non-green but structurally closed while its owner ticket is pending", async () => {
    const result = await check(greenRepo({ "tests/fixture.test.ts": null, "tests/.keep": "" }));
    expect(result.verdict).toBe("inconclusive");
    expect(result.completeness).toBe("incomplete");
    expect(result.reason).toBe("evidence_incomplete");
    expect(isGreenValidationResult(result)).toBe(false);
    expect(JSON.stringify(result.extensions)).toContain("IMPLEMENTATION_PENDING");
    expect(JSON.stringify(result.extensions)).not.toContain("IMPLEMENTATION_MISSING");
    expect(JSON.stringify(result.extensions)).not.toContain("PLANNED_IMPLEMENTATION_DRIFT");
  });

  it("fails when the cited test disappears after its owner ticket is landed", async () => {
    const result = await check(repoWithTicketStatus("landed", { "tests/fixture.test.ts": null, "tests/.keep": "" }));
    expect(result.verdict).toBe("fail");
    expect(result.reason).toBe("traceability_broken");
    expect(JSON.stringify(result.extensions)).toContain("LANDED_STATUS_FALSE");
    expect(isGreenValidationResult(result)).toBe(false);
  });

  it("removes the pending-implementation finding when the exact planned test exists", async () => {
    const result = await check(repoWithTicketStatus("pending"));
    expect(result.verdict).toBe("inconclusive");
    expect(JSON.stringify(result.extensions)).not.toContain("IMPLEMENTATION_PENDING");
  });

  it("uses the reviewed planned path when a spec header carries no current family citation", async () => {
    const result = await check(
      greenRepo({ "tests/fixture.test.ts": "// Historical trace note only\nit('planned', () => {});\n" }),
    );
    expect(result.verdict).toBe("inconclusive");
    expect(isGreenValidationResult(result)).toBe(false);
    expect(JSON.stringify(result.extensions)).not.toContain("ORPHAN_TEST");
  });

  it("keeps header presence and an executable call red-capable on a planned path", async () => {
    const missingHeader = await check(
      greenRepo({ "tests/fixture.test.ts": "it('planned but headerless', () => {});\n" }),
    );
    expect(missingHeader.verdict).toBe("fail");
    expect(JSON.stringify(missingHeader.extensions)).toContain("SPEC_HEADER_MISSING");
    expect(JSON.stringify(missingHeader.extensions)).not.toContain("ORPHAN_TEST");

    const missingCase = await check(
      greenRepo({ "tests/fixture.test.ts": "// Historical trace note only\nconst planned = true;\n" }),
    );
    expect(missingCase.verdict).toBe("fail");
    expect(JSON.stringify(missingCase.extensions)).toContain("SPEC_CASE_MISSING");
  });

  it("maps one observed planned path to every reviewed split family and control, ignoring historical tokens", async () => {
    const repo = splitFamilyRepo();
    const result = await check(repo);
    expect(result.verdict).toBe("inconclusive");
    expect(JSON.stringify(result.extensions)).not.toContain("ORPHAN_TEST");
    expect(JSON.stringify(result.extensions)).not.toContain("TEST_TICKET_UNKNOWN");

    const { graph } = await explain(repo, "tests/fixture.test.ts");
    const test = graph.nodes.find((node) => node.kind === "test" && node.path === "tests/fixture.test.ts");
    expect(test).toBeDefined();
    expect(graph.edges).toEqual(expect.arrayContaining([
      { from: "CF-X01-S", to: test?.id, type: "implemented-by" },
      { from: "CF-X01-R", to: test?.id, type: "implemented-by" },
      { from: "NC-X01", to: test?.id, type: "implemented-by" },
      { from: "NC-X01-R", to: test?.id, type: "implemented-by" },
    ]));
  });

  it("fails when an additional orphan spec coexists with a covered family", async () => {
    const result = await check(greenRepo({
      "tests/orphan.test.ts": "// Family: CF-X01-S\n// Ticket: HB-001\nit('orphan', () => {});\n",
    }));
    expect(result.verdict).toBe("fail");
    expect(result.reason).toBe("traceability_broken");
    expect(JSON.stringify(result.extensions)).toContain("ORPHAN_TEST");
  });

  it("binds a stale corpus failure to the repository revision actually checked", async () => {
    const result = await check(greenRepo({}, "abc124"));
    expect(result.verdict).toBe("fail");
    expect(result.identity.product_revision).toBe("abc124");
    expect(JSON.stringify(result.extensions)).toContain("MODEL_REVISION_STALE");
  });

  it("fails structural closure when an additional spec omits its required header", async () => {
    const result = await check(greenRepo({ "tests/unowned.test.ts": "it('unowned', () => {});\n" }));
    expect(result.verdict).toBe("fail");
    expect(JSON.stringify(result.extensions)).toContain("SPEC_HEADER_MISSING");
  });

  it("fails closed with a typed error when the corpus does not compile", async () => {
    await expect(check(greenRepo({ "validation-design/model/project.yaml": null }))).rejects.toSatisfy(
      (error: unknown) => isPublicContractError(error, "invalid_input"),
    );
  });
});

describe("explain", () => {
  it("traverses from a family to its structures, tests, and controls with product meaning first", async () => {
    const output = await explain(greenRepo(), "CF-X01-S");
    expect(output.query.nodes.map((item) => item.id)).toEqual(
      expect.arrayContaining(["CF-X01-S", "CON-1", "NC-X01"]),
    );
    expect(output.explanation).toMatch(/remains stable/i);
  });

  it("keeps unresolved hops explicit instead of inventing a relationship", async () => {
    const output = await explain(greenRepo(), "CF-DOES-NOT-EXIST");
    expect(output.query.nodes).toEqual([]);
    expect(output.query.unresolved.length).toBeGreaterThan(0);
  });
});

describe("plan", () => {
  it("plan(repo, []) answers the full-suite/environment question", async () => {
    const output = await plan(greenRepo(), []);
    expect(output.schema).toBe("validation-architect/plan/v1");
    expect(output.full_required_ci.command).toBe("pnpm test");
    expect(output.advisory).toBe(true);
    expect(output.full_required_ci_authoritative).toBe(true);
  });

  it("expands an unknown changed path to the full applicable suite with the unknown recorded", async () => {
    const output = await plan(greenRepo(), ["unmapped/mystery.ts"]);
    expect(output.unknowns.length + output.expansions.length).toBeGreaterThan(0);
    expect(output.family_ids).toContain("CF-X01-S");
    expect(output.negative_control_ids).toContain("NC-X01");
  });

  it("rejects a traversal path in the changed set", async () => {
    await expect(plan(greenRepo(), ["../outside.ts"])).rejects.toSatisfy((error: unknown) =>
      isPublicContractError(error, "invalid_input"),
    );
  });

  it("rejects malformed ChangedInput objects before invoking the planner", async () => {
    await expect(plan(greenRepo(), [{ id: "", kind: "content" } as never])).rejects.toSatisfy((error: unknown) =>
      isPublicContractError(error, "invalid_input"),
    );
  });

  it("binds a widened stale plan to the repository revision actually inspected", async () => {
    const output = await plan(greenRepo({}, "abc124"), []);
    expect(output.identity.product_revision).toBe("abc124");
    expect(output.unknowns.join(" ")).toMatch(/stale/i);
  });
});

describe("ingest", () => {
  const ctx = () => ({
    identity: {
      product_revision: "abc123",
      lane: "per-commit",
      environment: "offline",
      versions: {
        package: "0.1.1",
        method: "0.7.0",
        model: "validation-architect/corpus/v1",
        compiler: "validation-architect/compiler/v1",
        policy: "validation-architect/policy/v1",
        result: "validation-architect/result/v1",
        golden_set: "validation-architect/golden-set/v1",
      },
    },
    structure_id: "CON-1",
    root_id: "ROOT-1",
    owner: "OWN-1",
    evidence: [
      {
        id: "EV-LOG",
        kind: "log" as const,
        reference: "artifacts/bootstrap.log",
        integrity: { algorithm: "sha256" as const, digest: "d".repeat(64) },
      },
    ],
  });

  it("maps a bootstrap failure to typed incomplete evidence, never a pass", () => {
    const result = ingest(
      {
        kind: "bootstrap-failure",
        envelope: {
          stage: "outer-launcher",
          code: "DB_UNAVAILABLE",
          message: "database missing",
          next_action: "start the database",
          affected_case_ids: ["CF-X01-S"],
        },
      },
      ctx(),
    );
    expect(result.completeness).toBe("incomplete");
    expect(result.verdict).toBe("inconclusive");
    expect(result.reason).toBe("prerequisite_unavailable");
    expect(isGreenValidationResult(result)).toBe(false);
    expect(result.cases.find((item) => item.id === "CF-X01-S")?.status).toBe("blocked");
  });

  it("re-validates a supplied result record instead of trusting it", () => {
    expect(() => ingest({ kind: "validation-result", value: { schema: "validation-architect/result/v1" } }, ctx())).toThrow(
      /validation/i,
    );
  });

  it("rejects an unknown ingest kind and an invalid context", () => {
    expect(() => ingest({ kind: "mystery" } as never, ctx())).toThrow(/kind/i);
    expect(() => ingest({ kind: "bootstrap-failure", envelope: { message: "m" } } as never, {})).toThrow();
  });

  it("rejects a mutated or shallow relationship graph instead of trusting a claimed closed flag", async () => {
    const { graph } = await explain(greenRepo(), "CF-X01-S");
    const mutated = structuredClone(graph);
    mutated.findings = [];
    mutated.assurance_complete = true;
    expect(() => ingest({ kind: "relationship-trace", graph: mutated }, ctx())).toThrow(/graph_identity/);
    expect(() => ingest({ kind: "relationship-trace", graph: { identity: graph.identity } } as never, ctx())).toThrow();
  });
});

describe("render", () => {
  it("produces all four role views from one graph and query identity", async () => {
    const repo = greenRepo();
    const gate = await check(repo);
    const { graph } = await explain(repo, "CF-X01-S");
    const identities = new Set<string>();
    for (const view of ["author", "architect", "reviewer", "operator"] as const) {
      const rendered = render(view, { graph, selector: "CF-X01-S", result: gate });
      expect(rendered.role).toBe(view);
      expect(rendered.markdown.length).toBeGreaterThan(0);
      identities.add(`${rendered.graph_identity}:${rendered.product_revision}`);
    }
    expect(identities.size).toBe(1);
  });

  it("rejects an invalid view name and a missing graph", async () => {
    const { graph } = await explain(greenRepo(), "CF-X01-S");
    expect(() => render("owner" as never, { graph, selector: "CF-X01-S" })).toThrow();
    expect(() => render("author", { selector: "CF-X01-S" } as never)).toThrow();
  });
});

describe("migrate", () => {
  it("refuses any target other than the current corpus major with the typed error", () => {
    expect(() =>
      migrate({ kind: "legacy-catalog", catalogMarkdown: "x", backlogMarkdown: "y", review: {} as never }, "validation-architect/corpus/v2"),
    ).toThrow(/supported range/);
  });

  it("refuses an unreviewed legacy corpus instead of casting it", () => {
    let caught: unknown;
    try {
      migrate(
        {
          kind: "legacy-catalog",
          catalogMarkdown: "# Catalog\n",
          backlogMarkdown: "# Backlog\n",
          review: {
            product: { id: "p", name: "P", revision: "r", intended_use: "u", criticality: "C1", criticality_reason: "why" },
            inner_loop_command: "pnpm test",
            owners: [],
            sources: [],
            structures: [],
            families: {},
            ticket_reviews: {},
          },
        },
        CORPUS_SCHEMA,
      );
    } catch (error) {
      caught = error;
    }
    expect(isPublicContractError(caught, "invalid_input")).toBe(true);
  });
});
