import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");

describe("package distribution contract", () => {
  it("ships only runtime and enablement assets", () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      private?: boolean;
      license?: string;
      version?: string;
      files?: string[];
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    expect(pkg.private).toBe(false);
    expect(pkg.license).toBe("UNLICENSED");
    expect(pkg.files).toEqual([
      "bin/validation-trace.js",
      "dist/catalog.js",
      "dist/trace.js",
      "dist/trace-cli.js",
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

  it("runs compiled JavaScript without tsx", () => {
    const bin = readFileSync(resolve(root, "bin", "validation-trace.js"), "utf8");
    expect(bin).toContain("dist/trace-cli.js");
    expect(bin).not.toMatch(/tsx|src\/trace-cli\.ts/);
  });
});
