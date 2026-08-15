import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Conformance detectors for the ratified VA-API-001 / license decision record
 * (docs/decisions/2026-08-15-public-naming-and-license.md). Each detector is
 * red-capable: it fails when the repository drifts from a ratified choice. */

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const record = readFileSync(
  join(root, "docs", "decisions", "2026-08-15-public-naming-and-license.md"),
  "utf8",
);

function grepTree(pattern: string): string[] {
  try {
    const out = execFileSync(
      "git",
      ["grep", "-l", pattern, "--", "src", "test", "skill", "docs", "enablement", "scripts", "bin"],
      { cwd: root, encoding: "utf8" },
    );
    return out.split("\n").filter(Boolean);
  } catch {
    return []; // git grep exits 1 on no match
  }
}

describe("decision 1: bare package pair", () => {
  it("keeps the core package name", () => {
    expect(pkg.name).toBe("validation-architect");
  });

  it("spells no scoped @validation-architect package anywhere shipped", () => {
    expect(grepTree("@validation-architect/")).toEqual([]);
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
});

describe("decision 3: one canonical result schema ID", () => {
  it("writes only validation-architect/result/v1", async () => {
    const versions = await import("../src/versions.js");
    expect(versions.RESULT_SCHEMA).toBe("validation-architect/result/v1");
  });

  it("has no writable validation-result/v1 spelling in the tree", () => {
    // The rejected alternative may appear only in the decision record and in
    // this detector's own source.
    const hits = grepTree("validation-result/v1").filter(
      (path) =>
        !path.startsWith("docs/decisions/") &&
        path !== "test/public-contract-decision.test.ts",
    );
    expect(hits).toEqual([]);
  });
});

describe("decision 4: FSL-1.1-MIT license adoption", () => {
  const license = readFileSync(join(root, "LICENSE.md"), "utf8");

  it("declares LicenseRef-FSL-1.1-MIT with a shipped LICENSE.md", () => {
    expect(pkg.license).toBe("LicenseRef-FSL-1.1-MIT");
    expect(pkg.licenseFile).toBe("LICENSE.md");
    expect(pkg.files).toContain("LICENSE.md");
    expect(pkg.files).toContain("THIRD-PARTY-NOTICES.md");
  });

  it("bundles the FSL-1.1-MIT terms with the confirmed holder and no placeholder", () => {
    expect(license).toContain("FSL-1.1-MIT");
    expect(license).toContain("Copyright 2026 Bikram Gupta");
    expect(license).not.toMatch(/\$\{(year|licensor name)\}/);
  });

  it("never claims to be open source or UNLICENSED", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(readme).not.toContain("UNLICENSED");
    const licenseSection = readme.slice(readme.indexOf("## License"));
    expect(licenseSection).toContain("fair source");
    expect(licenseSection).not.toMatch(/\bis open source\b/);
  });
});

describe("no stale release guidance", () => {
  it("presents no 0.2.0 as the planned public release", () => {
    // Skill changelogs legitimately contain historical 0.2.0 entries.
    const hits = grepTree("0\\.2\\.0").filter((path) => !path.endsWith("CHANGELOG.md"));
    expect(hits).toEqual([]);
  });

  it("records all four ratified decisions", () => {
    expect(record).toContain("validation-architect-design");
    expect(record).toContain("validation-architect/result/v1");
    expect(record).toContain("First deprecated version");
    expect(record).toContain("LicenseRef-FSL-1.1-MIT");
  });
});
