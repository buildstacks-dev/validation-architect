import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { listFixtures, loadFixture } from "../src/fixtures.js";

const repoRoot = resolve(__dirname, "..");

interface FixtureMeta {
  name: string;
  display_name: string;
  kind: string;
  expected_tier: string;
  seeded_conflicts: Array<{ id: string; rambling_says: string; docs_say: string; kind: string }>;
  directive_seed: string;
  invariant_seeds: string[];
  llm_call_sites: boolean;
}

// The three synthetic eval fixtures carry seeded conflicts and expected
// outcomes; operon is a real target (docs snapshot of the pilot repo) and
// deliberately has none — the campaign derives everything itself.
const EVAL_FIXTURES = ["lumen-webapp", "relay-backend", "docsmith-agent"];

describe("fixtures", () => {
  it("ships the three eval product types plus the operon real target", () => {
    expect(listFixtures(repoRoot).sort()).toEqual([
      "docsmith-agent",
      "lumen-webapp",
      "operon",
      "relay-backend",
    ]);
  });

  for (const name of EVAL_FIXTURES) {
    describe(name, () => {
      const dir = join(repoRoot, "fixtures", name);
      const meta = parse(readFileSync(join(dir, "fixture.yaml"), "utf8")) as FixtureMeta;

      it("loads with docs and rambling present", () => {
        const info = loadFixture(repoRoot, name);
        expect(info.displayName).toBe(meta.display_name);
        expect(info.hasRambling).toBe(true);
        expect(existsSync(join(dir, "docs", "PRODUCT.md"))).toBe(true);
        expect(existsSync(join(dir, "docs", "ARCHITECTURE.md"))).toBe(true);
      });

      it("declares tier, conflicts, directive, and invariant seeds", () => {
        expect(meta.expected_tier).toMatch(/^C[0-4]$/);
        expect(meta.seeded_conflicts.length).toBeGreaterThanOrEqual(2);
        const kinds = meta.seeded_conflicts.map((c) => c.kind);
        // Both conflict species must be present: facts (docs win) and
        // values (open decision) — they exercise different stakeholder rules.
        expect(kinds).toContain("fact-conflict");
        expect(kinds).toContain("values-vs-policy");
        expect(meta.directive_seed.length).toBeGreaterThan(0);
        expect(meta.invariant_seeds.length).toBeGreaterThanOrEqual(2);
        expect(typeof meta.llm_call_sites).toBe("boolean");
      });

      it("rambling.txt actually contains the seeded directive verbatim", () => {
        const ramble = readFileSync(join(dir, "rambling.txt"), "utf8");
        expect(ramble).toContain(meta.directive_seed);
      });
    });
  }

  describe("operon (real target)", () => {
    const dir = join(repoRoot, "fixtures", "operon");
    const meta = parse(readFileSync(join(dir, "fixture.yaml"), "utf8")) as {
      display_name: string;
      real_target?: boolean;
      seeded_conflicts?: unknown;
      expected_tier?: unknown;
    };

    it("loads with docs and rambling present", () => {
      const info = loadFixture(repoRoot, "operon");
      expect(info.displayName).toBe("Operon");
      expect(info.hasRambling).toBe(true);
      expect(existsSync(join(dir, "docs", "README.md"))).toBe(true);
      expect(existsSync(join(dir, "docs", "AGENTS.md"))).toBe(true);
    });

    it("declares itself a real target with no seeded expectations", () => {
      expect(meta.real_target).toBe(true);
      // A real target must not carry an answer key: seeding conflicts or an
      // expected tier here would turn a live product into a rigged eval.
      expect(meta.seeded_conflicts).toBeUndefined();
      expect(meta.expected_tier).toBeUndefined();
    });
  });

  it("exactly one fixture exercises the LLM eval phase", () => {
    const withLlm = EVAL_FIXTURES.filter((n) => {
      const meta = parse(
        readFileSync(join(repoRoot, "fixtures", n, "fixture.yaml"), "utf8"),
      ) as FixtureMeta;
      return meta.llm_call_sites;
    });
    expect(withLlm).toEqual(["docsmith-agent"]);
  });

  it("rejects an unknown fixture with the available list", () => {
    expect(() => loadFixture(repoRoot, "nope")).toThrow(/Unknown fixture/);
  });
});
