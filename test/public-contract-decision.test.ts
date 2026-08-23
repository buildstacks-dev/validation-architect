import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Conformance detectors for the current scoped-package publication ruling and
 * the retained alias/schema decisions in VA-API-001. */

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const record = readFileSync(
  join(root, "docs", "decisions", "2026-08-23-single-package-publication.md"),
  "utf8",
);
const history = readFileSync(
  join(root, "docs", "decisions", "2026-08-15-public-naming-and-license.md"),
  "utf8",
);

function grepTree(pattern: string, binary = "git"): string[] {
  const result = spawnSync(
    binary,
    ["grep", "-l", pattern, "--", "src", "test", "skill", "docs", "enablement", "scripts", "bin"],
    { cwd: root, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status === 1) return []; // git grep's documented no-match status
  if (result.status !== 0) {
    throw new Error(`git grep detector failed (${result.status}): ${result.stderr}`);
  }
  // The decision record names rejected alternatives on purpose, and this
  // detector file necessarily spells every pattern it hunts.
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .filter((path) => !path.startsWith("docs/decisions/") && path !== "test/public-contract-decision.test.ts");
}

describe("decision 1: scoped single package", () => {
  it("fails closed when the repository scan cannot run", () => {
    expect(() => grepTree("anything", "definitely-not-a-git-binary")).toThrow();
  });

  it("keeps the scoped package name", () => {
    expect(pkg.name).toBe("@cormidia/validation-architect");
  });

  it("carries no imports from either superseded bare package", () => {
    expect(grepTree('from "validation-architect"')).toEqual([]);
    expect(grepTree('from "validation-architect-design"')).toEqual([]);
  });

  it("documents the schema-asset wildcard without inventing a directory export", () => {
    expect(record).toContain("schemas/**");
    expect(pkg.exports["./schemas/*.schema.json"])
      .toBe("./schemas/*.schema.json");
    expect(pkg.exports["./schemas"]).toBeUndefined();
  });
});

describe("decision 2: validation-trace alias retained through 0.x", () => {
  it("ships the validation-trace bin until 1.0", () => {
    const major = Number(String(pkg.version).split(".")[0]);
    if (major < 1) {
      expect(pkg.bin["validation-trace"]).toBe("./bin/validation-trace.js");
    } else {
      expect(pkg.bin["validation-trace"]).toBeUndefined();
    }
  });

  it("records the bounded bridge without changing the public check command", () => {
    const alias = readFileSync(join(root, "src", "trace-cli.ts"), "utf8");
    const core = readFileSync(join(root, "src", "core-cli.ts"), "utf8");
    expect(history).toContain("Bounded cutover bridge");
    expect(alias).toContain("TRACE_LEGACY_BRIDGE_ACTIVE");
    expect(alias).toContain("hasCheckedModelFile");
    expect(core).not.toContain('"manifest"');
  });
});

describe("decision 3: one canonical result schema ID", () => {
  it("writes only validation-architect/result/v1", async () => {
    const versions = await import("../src/versions.js");
    expect(versions.RESULT_SCHEMA).toBe("validation-architect/result/v1");
  });

  it("has no writable validation-result/v1 spelling in the tree", () => {
    expect(grepTree("validation-result/v1")).toEqual([]);
  });
});

describe("decision 4: Apache-2.0 license adoption", () => {
  const license = readFileSync(join(root, "LICENSE"), "utf8");
  const notice = readFileSync(join(root, "NOTICE"), "utf8");

  it("declares Apache-2.0 with shipped LICENSE and NOTICE", () => {
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.licenseFile).toBeUndefined();
    expect(pkg.files).toContain("LICENSE");
    expect(pkg.files).toContain("NOTICE");
    expect(pkg.files).toContain("THIRD-PARTY-NOTICES.md");
  });

  it("bundles Apache-2.0 and the confirmed copyright holder", () => {
    expect(license).toContain("Apache License");
    expect(license).toContain("Version 2.0");
    expect(notice).toContain("Copyright 2026 Bikram Gupta");
  });

  it("never claims to be UNLICENSED and records deferred provenance", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(readme).not.toContain("UNLICENSED");
    const licenseSection = readme.slice(readme.indexOf("## License"));
    expect(licenseSection).toContain("Apache License 2.0");
    expect(licenseSection).toContain("provenance");
  });
});

describe("no stale release guidance", () => {
  it("presents no 0.2.0 as the planned public release", () => {
    // Tests and changelogs legitimately name the retired candidate as a
    // negative control or historical entry; neither is release guidance.
    const hits = grepTree("0\\.2\\.0").filter(
      (path) => !path.startsWith("test/") && !path.endsWith("CHANGELOG.md"),
    );
    expect(hits).toEqual([]);
  });

  it("records all seven current rulings and retained schema/alias decisions", () => {
    for (const ruling of ["1.", "2.", "3.", "4.", "5.", "6.", "7."]) {
      expect(record).toContain(ruling);
    }
    expect(record).toContain("@cormidia/validation-architect@0.5.0");
    expect(record).toContain("Apache-2.0");
    expect(history).toContain("validation-architect/result/v1");
    expect(history).toContain("First deprecated version");
  });
});
