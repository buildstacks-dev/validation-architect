import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Conformance detectors for the ratified single-package boundary. Packed
 * contents, optional-peer behavior, and deep-import refusal are proven by
 * scripts/package-smoke.mjs; these detectors keep the source tree from drift.
 */

const root = resolve(__dirname, "..");

interface Manifest {
  name?: string;
  version?: string;
  private?: boolean;
  license?: string;
  licenseFile?: string;
  bin?: Record<string, string>;
  exports?: Record<string, unknown>;
  files?: string[];
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  devDependencies?: Record<string, string>;
  repository?: { type?: string; url?: string; directory?: string };
  homepage?: string;
  bugs?: { url?: string };
  publishConfig?: { access?: string; provenance?: boolean };
}

function trackedManifests(): Array<{ path: string; manifest: Manifest }> {
  const out = execFileSync("git", ["ls-files", "*package.json", "**/package.json"], {
    cwd: root,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter((path) => path && existsSync(join(root, path)))
    .map((path) => ({ path, manifest: JSON.parse(readFileSync(join(root, path), "utf8")) as Manifest }));
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Manifest;

describe("exactly one publishable manifest with the ratified scoped name", () => {
  it("publishes @cormidia/validation-architect and nothing else", () => {
    const publishable = trackedManifests().filter(({ manifest }) => manifest.private !== true);
    expect(publishable.map(({ manifest }) => manifest.name)).toEqual(["@cormidia/validation-architect"]);
    expect(publishable.map(({ path }) => path)).toEqual(["package.json"]);
  });
});

describe("dependency boundary", () => {
  it("runtime dependencies are exactly { yaml }", () => {
    expect(pkg.dependencies).toEqual({ yaml: "^2.8.0" });
  });

  it("carries both tested SDKs as exact optional peers and exact dev dependencies", () => {
    const expected = {
      "@anthropic-ai/claude-agent-sdk": "0.3.220",
      "@openai/codex-sdk": "0.146.0",
    };
    expect(pkg.peerDependencies).toEqual(expected);
    expect(pkg.peerDependenciesMeta).toEqual({
      "@anthropic-ai/claude-agent-sdk": { optional: true },
      "@openai/codex-sdk": { optional: true },
    });
    for (const [name, version] of Object.entries(expected)) {
      expect(pkg.devDependencies?.[name]).toBe(version);
    }
  });
});

describe("license and registry identity", () => {
  it("declares Apache-2.0 with bundled LICENSE and NOTICE", () => {
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.licenseFile).toBeUndefined();
    expect(pkg.files).toEqual(expect.arrayContaining(["LICENSE", "NOTICE", "THIRD-PARTY-NOTICES.md"]));
    expect(readFileSync(join(root, "LICENSE"), "utf8")).toContain("Apache License");
    expect(readFileSync(join(root, "NOTICE"), "utf8")).toContain("Copyright 2026 Bikram Gupta");
  });

  it("carries complete registry metadata", () => {
    expect(pkg.repository?.type).toBe("git");
    expect(pkg.repository?.url).toBe("git+https://github.com/cormidia/validation-architect.git");
    expect(pkg.repository?.directory).toBeUndefined();
    expect(pkg.homepage).toBe("https://github.com/cormidia/cormidia-web");
    expect(pkg.bugs?.url).toBe("https://github.com/cormidia/validation-architect/issues");
    expect(pkg.publishConfig).toEqual({ access: "public" });
  });
});

describe("bins and exports", () => {
  it("ships all three established bins", () => {
    expect(pkg.bin).toEqual({
      "validation-architect": "./bin/validation-architect.js",
      "validation-trace": "./bin/validation-trace.js",
      "validation-architect-design": "./bin/validation-architect-design.js",
    });
  });

  it("exports the API, design adapters, and schemas with no dist wildcard", () => {
    const exports = pkg.exports ?? {};
    expect(Object.keys(exports).sort()).toEqual([".", "./design", "./package.json", "./schemas/*.schema.json"]);
    expect(exports["."]).toEqual({ types: "./dist/api/index.d.ts", default: "./dist/api/index.js" });
    expect(exports["./design"]).toEqual({ types: "./dist/design/index.d.ts", default: "./dist/design/index.js" });
    expect(exports["./*"]).toBeUndefined();
  });
});

describe("skills ship whole, with closed internal references and no VERSION file", () => {
  const skills = ["validation-harness-design", "validation-harness-audit", "implement-harness-ticket"];

  it("all three complete skill trees are in the files allowlist", () => {
    expect(pkg.files).toContain("skill/**");
  });

  it("no skill VERSION file exists anywhere", () => {
    const tracked = execFileSync("git", ["ls-files", "skill"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    expect(tracked.filter((path) => path.endsWith("/VERSION"))).toEqual([]);
    for (const skill of skills) {
      expect(existsSync(join(root, "skill", skill, "VERSION"))).toBe(false);
    }
  });

  it("every relative file a SKILL.md references exists in a shipped skill tree", () => {
    for (const skill of skills) {
      const skillDir = join(root, "skill", skill);
      const text = readFileSync(join(skillDir, "SKILL.md"), "utf8");
      // Relative references like references/x.md, assets/templates/y.yaml,
      // scripts/z.py — the closure that must ship with the SKILL.md. A
      // reference may name a sibling skill's file (the design skill points at
      // the audit skill's canonical criticality rubric); all three trees ship
      // whole in the same package, so the closure is package-level.
      const references = [
        ...text.matchAll(/(?:^|[\s(`[])((?:references|assets|scripts|evals)\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+)/gm),
      ].map((match) => match[1] as string);
      for (const reference of new Set(references)) {
        const shippedIn = skills.filter((tree) => existsSync(join(root, "skill", tree, reference)));
        expect(shippedIn.length, `${skill}/SKILL.md references ${reference}, found in no shipped skill tree`).toBeGreaterThan(0);
      }
    }
  });

  it("files referenced from within references/ documents resolve too", () => {
    for (const skill of skills) {
      const skillDir = join(root, "skill", skill);
      const referenceDocs = execFileSync("git", ["ls-files", `skill/${skill}/references`], {
        cwd: root,
        encoding: "utf8",
      })
        .split("\n")
        .filter((path) => path.endsWith(".md"));
      for (const doc of referenceDocs) {
        const text = readFileSync(join(root, doc), "utf8");
        const links = [...text.matchAll(/\]\((?!https?:|#|mailto:)([^)\s]+?\.[A-Za-z0-9]+)(?:#[^)]*)?\)/g)].map(
          (match) => match[1] as string,
        );
        for (const link of new Set(links)) {
          const target = resolve(join(root, dirname(doc)), link);
          expect(existsSync(target), `${doc} links missing file ${link}`).toBe(true);
          expect(target.startsWith(skillDir), `${doc} links outside its skill tree: ${link}`).toBe(true);
        }
      }
    }
  });
});
