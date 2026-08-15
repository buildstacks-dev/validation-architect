import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Conformance detectors for the two-package boundary (VA-PKG-001, building on
 * the ratified decision record 2026-08-15). The packed-tarball halves of these
 * guarantees (exact-version rewrite of workspace:*, tarball contents, deep
 * import refusal) are proven by scripts/package-smoke.mjs; these detectors
 * keep the SOURCE tree from drifting.
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
    .filter(Boolean)
    .map((path) => ({ path, manifest: JSON.parse(readFileSync(join(root, path), "utf8")) as Manifest }));
}

const corePkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Manifest;
const designPkg = JSON.parse(readFileSync(join(root, "design", "package.json"), "utf8")) as Manifest;

describe("exactly two publishable manifests with the ratified names", () => {
  it("publishes validation-architect and validation-architect-design, nothing else", () => {
    const publishable = trackedManifests().filter(({ manifest }) => manifest.private !== true);
    expect(publishable.map(({ manifest }) => manifest.name).sort()).toEqual([
      "validation-architect",
      "validation-architect-design",
    ]);
    expect(publishable.map(({ path }) => path).sort()).toEqual(["design/package.json", "package.json"]);
  });
});

describe("dependency boundary", () => {
  it("core runtime dependencies are exactly { yaml } — no provider SDK ever", () => {
    expect(Object.keys(corePkg.dependencies ?? {})).toEqual(["yaml"]);
  });

  it("design depends on the core through the workspace protocol (pack rewrites to the exact version)", () => {
    expect(designPkg.dependencies?.["validation-architect"]).toBe("workspace:*");
  });

  it("design carries both provider SDKs as ORDINARY exact dependencies", () => {
    expect(designPkg.dependencies?.["@anthropic-ai/claude-agent-sdk"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(designPkg.dependencies?.["@openai/codex-sdk"]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("lockstep versions and license pair", () => {
  it("both manifests share one version", () => {
    expect(designPkg.version).toBe(corePkg.version);
  });

  it("both manifests declare LicenseRef-FSL-1.1-MIT with a bundled LICENSE.md", () => {
    for (const pkg of [corePkg, designPkg]) {
      expect(pkg.license).toBe("LicenseRef-FSL-1.1-MIT");
      expect(pkg.licenseFile).toBe("LICENSE.md");
      expect(pkg.files).toContain("LICENSE.md");
    }
    // The design copy must not drift from the root license text.
    expect(readFileSync(join(root, "design", "LICENSE.md"), "utf8")).toBe(
      readFileSync(join(root, "LICENSE.md"), "utf8"),
    );
  });

  it("both publishable manifests carry complete registry metadata and provenance", () => {
    for (const pkg of [corePkg, designPkg]) {
      expect(pkg.repository?.type).toBe("git");
      expect(pkg.repository?.url).toBe("git+https://github.com/cormidia/validation-architect.git");
      expect(pkg.homepage).toBe("https://github.com/cormidia/validation-architect#readme");
      expect(pkg.bugs?.url).toBe("https://github.com/cormidia/validation-architect/issues");
      expect(pkg.publishConfig).toEqual({ access: "public", provenance: true });
    }
    expect(corePkg.repository?.directory).toBeUndefined();
    expect(designPkg.repository?.directory).toBe("design");
  });
});

describe("bins and exports", () => {
  it("core ships both bins; design ships its own", () => {
    expect(corePkg.bin).toEqual({
      "validation-architect": "./bin/validation-architect.js",
      "validation-trace": "./bin/validation-trace.js",
    });
    expect(designPkg.bin).toEqual({ "validation-architect-design": "./bin/validation-architect-design.js" });
  });

  it("core exports map serves the API root and schema assets, no dist wildcard", () => {
    const exports = corePkg.exports ?? {};
    expect(Object.keys(exports).sort()).toEqual([".", "./package.json", "./schemas/*.schema.json"]);
    expect(exports["."]).toEqual({ types: "./dist/api/index.d.ts", default: "./dist/api/index.js" });
    expect(exports["./*"]).toBeUndefined();
  });
});

describe("skills ship whole, with closed internal references and no VERSION file", () => {
  const skills = ["validation-harness-design", "validation-harness-audit", "implement-harness-ticket"];

  it("all three complete skill trees are in the core files allowlist", () => {
    for (const skill of skills) {
      expect(corePkg.files).toContain(`skill/${skill}/**`);
    }
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
