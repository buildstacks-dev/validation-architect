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
      "bin/validation-trace.js",
      "dist/catalog.js",
      "dist/model-compiler.js",
      "dist/model-inventory.js",
      "dist/model-trace.js",
      "dist/model-validation.js",
      "dist/model-views.js",
      "dist/model.js",
      "dist/relationship-graph.js",
      "dist/trace-cli.js",
      "dist/trace.js",
      "dist/versions.js",
      "enablement/**",
      "skill/implement-harness-ticket/SKILL.md",
    ]);
    expect(pkg.files).not.toEqual(expect.arrayContaining(["src/**", "test/**", "fixtures/**"]));
    expect(pkg.scripts?.prepack).toContain("build");
    expect(pkg.scripts?.["test:package"]).toContain("package-smoke");
    expect(pkg.dependencies).toEqual({ yaml: "^2.8.0" });
    const install = readFileSync(resolve(root, "enablement", "INSTALL.md"), "utf8");
    expect(install).toContain(`validation-architect@${pkg.version}`);
    expect(install).not.toContain("{{PACKAGE_VERSION}}");
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
    const bin = readFileSync(resolve(root, "bin", "validation-trace.js"), "utf8");
    expect(bin).toContain("dist/trace-cli.js");
    expect(bin).not.toMatch(/tsx|src\/trace-cli\.ts/);
  });
});
