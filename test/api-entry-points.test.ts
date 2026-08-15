import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
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

function greenRepo(overrides: Record<string, string | null> = {}): FakeRepositoryPort {
  const files = fixtureFiles();
  for (const [path, content] of Object.entries(overrides)) {
    if (content === null) delete files[path];
    else files[path] = content;
  }
  return new FakeRepositoryPort({ revision: "rev-fixture", files });
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

  it("fails when the cited test disappears (orphaned meaning breaks traceability)", async () => {
    const result = await check(greenRepo({ "tests/fixture.test.ts": null }));
    expect(result.verdict).toBe("fail");
    expect(result.reason).toBe("traceability_broken");
    expect(isGreenValidationResult(result)).toBe(false);
  });

  it("fails when the spec loses its family citation", async () => {
    const result = await check(
      greenRepo({ "tests/fixture.test.ts": "it('uncited', () => {});\n" }),
    );
    expect(result.verdict).toBe("fail");
    expect(isGreenValidationResult(result)).toBe(false);
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
    const output = await plan(greenRepo(), ["src/mystery/unmapped.ts"]);
    expect(output.unknowns.length + output.expansions.length).toBeGreaterThan(0);
    expect(output.family_ids).toContain("CF-X01-S");
    expect(output.negative_control_ids).toContain("NC-X01");
  });

  it("rejects a traversal path in the changed set", async () => {
    await expect(plan(greenRepo(), ["../outside.ts"])).rejects.toSatisfy((error: unknown) =>
      isPublicContractError(error, "invalid_input"),
    );
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
