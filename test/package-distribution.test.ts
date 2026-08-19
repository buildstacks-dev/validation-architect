import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CORE_PACKAGE_VERSION } from "../src/versions.js";

const root = resolve(__dirname, "..");

describe("package distribution contract", () => {
  it("ships only runtime and enablement assets", () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      private?: boolean;
      license?: string;
      licenseFile?: string;
      version?: string;
      files?: string[];
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    expect(pkg.private).toBe(false);
    expect(pkg.license).toBe("LicenseRef-FSL-1.1-MIT");
    expect(pkg.licenseFile).toBe("LICENSE.md");
    expect(pkg.files).toEqual([
      "LICENSE.md",
      "THIRD-PARTY-NOTICES.md",
      "bin/validation-architect.js",
      "bin/validation-trace.js",
      "dist/**",
      "schemas/**",
      "enablement/**",
      "skill/validation-harness-design/**",
      "skill/validation-harness-audit/**",
      "skill/implement-harness-ticket/**",
    ]);
    expect(pkg.files).not.toEqual(expect.arrayContaining(["src/**", "test/**", "fixtures/**"]));
    expect(pkg.scripts?.build).toBe("node scripts/clean-dist.mjs core && tsc -p tsconfig.build.json");
    expect(pkg.scripts?.prepack).toContain("build");
    expect(pkg.scripts?.["test:package"]).toContain("package-smoke");
    expect(pkg.dependencies).toEqual({ yaml: "^2.8.0" });
    const install = readFileSync(resolve(root, "enablement", "INSTALL.md"), "utf8");
    expect(install).toContain(`validation-architect@${pkg.version}`);
    expect(install).not.toContain("{{PACKAGE_VERSION}}");
  });

  it("cleans both exact ignored output directories before compiling", () => {
    const designPkg = JSON.parse(readFileSync(resolve(root, "design/package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(designPkg.scripts?.build).toBe("node ../scripts/clean-dist.mjs design && tsc -p tsconfig.build.json");

    const cleaner = readFileSync(resolve(root, "scripts/clean-dist.mjs"), "utf8");
    expect(cleaner).toContain('core: { root: repositoryRoot, name: "validation-architect" }');
    expect(cleaner).toContain('design: { root: join(repositoryRoot, "design"), name: "validation-architect-design" }');
    expect(cleaner).toContain("entry.isSymbolicLink() || !entry.isDirectory()");
    expect(cleaner).not.toMatch(/process\.argv\[2\].*(?:resolve|rmSync)/);
  });

  /**
   * Install snippets are copy-pasted by users, so a stale pin is a broken
   * command, not a typo. README drifted to 0.1.0 while INSTALL.md — the only
   * file previously asserted — stayed current.
   */
  it("pins the same package version everywhere it is quoted", () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string };
    for (const doc of ["README.md", "enablement/INSTALL.md"]) {
      const text = readFileSync(resolve(root, doc), "utf8");
      const pinned = [...text.matchAll(/validation-architect@(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
      expect(pinned.length, `${doc} quotes no install pin`).toBeGreaterThan(0);
      expect([...new Set(pinned)], `${doc} pins a stale version`).toEqual([pkg.version]);
    }
    expect(CORE_PACKAGE_VERSION).toBe(pkg.version);
  });

  it("runs compiled JavaScript without tsx", () => {
    const alias = readFileSync(resolve(root, "bin", "validation-trace.js"), "utf8");
    expect(alias).toContain("dist/trace-cli.js");
    expect(alias).not.toMatch(/tsx|src\/trace-cli\.ts/);
    const core = readFileSync(resolve(root, "bin", "validation-architect.js"), "utf8");
    expect(core).toContain("dist/core-cli.js");
    expect(core).not.toMatch(/tsx|src\/core-cli\.ts/);
  });
});
