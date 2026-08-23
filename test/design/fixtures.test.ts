import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  listPackagedFixtures,
  materializeFixtureTarget,
  packagedFixtureDirectory,
} from "../../src/design/fixtures.js";

const state = mkdtempSync(join(tmpdir(), "va-design-fixtures-"));
afterAll(() => rmSync(state, { recursive: true, force: true }));

describe("packaged public-engine fixtures", () => {
  it("ships all three fixtures and materializes no answer key", () => {
    expect(listPackagedFixtures()).toEqual(["docsmith-agent", "lumen-webapp", "relay-backend"]);
    expect(existsSync(packagedFixtureDirectory("lumen-webapp"))).toBe(true);
    const target = materializeFixtureTarget("lumen-webapp", state, "fixture-run");
    expect(existsSync(join(target, "fixture.yaml"))).toBe(false);
    expect(readFileSync(join(target, "rambling.txt"), "utf8")).toContain("skip the load testing stuff");
    expect(existsSync(join(target, ".git"))).toBe(true);
  });

  it("keeps every answer key internally complete without exposing it to campaign source", () => {
    const llmFixtures: string[] = [];
    for (const name of listPackagedFixtures()) {
      const directory = packagedFixtureDirectory(name);
      const meta = parse(readFileSync(join(directory, "fixture.yaml"), "utf8")) as {
        expected_tier: string;
        seeded_conflicts: Array<{ kind: string }>;
        directive_seed: string;
        invariant_seeds: string[];
        llm_call_sites: boolean;
      };
      expect(meta.expected_tier).toMatch(/^C[0-4]$/);
      expect(meta.seeded_conflicts.map((item) => item.kind)).toEqual(expect.arrayContaining(["fact-conflict", "values-vs-policy"]));
      expect(meta.invariant_seeds.length).toBeGreaterThanOrEqual(2);
      expect(readFileSync(join(directory, "rambling.txt"), "utf8")).toContain(meta.directive_seed);
      if (meta.llm_call_sites) llmFixtures.push(name);
    }
    expect(llmFixtures).toEqual(["docsmith-agent"]);
  });

  it("rejects an unknown fixture without creating a source", () => {
    expect(() => materializeFixtureTarget("unknown", state, "unknown-run")).toThrow(/unknown fixture/);
  });
});
