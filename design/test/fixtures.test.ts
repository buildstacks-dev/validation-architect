import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  listPackagedFixtures,
  materializeFixtureTarget,
  packagedFixtureDirectory,
} from "../src/fixtures.js";

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

  it("rejects an unknown fixture without creating a source", () => {
    expect(() => materializeFixtureTarget("unknown", state, "unknown-run")).toThrow(/unknown fixture/);
  });
});
