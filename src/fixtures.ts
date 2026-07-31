import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { FixtureInfo } from "./types.js";

export function fixturesRoot(repoRoot: string): string {
  return join(repoRoot, "fixtures");
}

export function listFixtures(repoRoot: string): string[] {
  const root = fixturesRoot(repoRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory());
}

/**
 * Load and validate a fixture directory. fixture.yaml is test-harness
 * metadata only — nothing from it beyond the display name may reach agent
 * prompts (the agents must discover conflicts and tiers themselves).
 */
export function loadFixture(repoRoot: string, name: string): FixtureInfo {
  const dir = join(fixturesRoot(repoRoot), name);
  if (!existsSync(dir)) {
    throw new Error(
      `Unknown fixture "${name}". Available: ${listFixtures(repoRoot).join(", ") || "(none)"}`,
    );
  }
  const docsDir = join(dir, "docs");
  if (!existsSync(docsDir) || readdirSync(docsDir).length === 0) {
    throw new Error(`Fixture "${name}" has no docs/ — the designer needs ratified product documents.`);
  }
  const metaPath = join(dir, "fixture.yaml");
  let displayName = name;
  if (existsSync(metaPath)) {
    const meta = parse(readFileSync(metaPath, "utf8")) as { display_name?: string } | null;
    if (meta?.display_name) displayName = meta.display_name;
  }
  return {
    name,
    dir,
    displayName,
    hasRambling: existsSync(join(dir, "rambling.txt")),
  };
}
