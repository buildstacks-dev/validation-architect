import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CORE_PACKAGE_VERSION } from "../src/versions.js";

/**
 * VA-REL-001 candidate detectors: the 0.3.0 lockstep identity is consistent
 * everywhere a consumer can see it, install guidance carries the exact pin,
 * stale release numbers are gone, and the release workflow is structurally
 * incapable of publishing without the human-approved candidate.
 */

const root = join(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const corePkg = JSON.parse(read("package.json"));
const designPkg = JSON.parse(read("design/package.json"));

describe("0.3.0 lockstep candidate identity", () => {
  it("both manifests and the code constant agree on the candidate version", () => {
    expect(corePkg.version).toBe("0.3.0");
    expect(designPkg.version).toBe(corePkg.version);
    expect(CORE_PACKAGE_VERSION).toBe(corePkg.version);
  });

  it("install guidance exact-pins the candidate and carries no stale pin", () => {
    for (const path of ["enablement/INSTALL.md", "README.md"]) {
      const text = read(path);
      expect(text, path).toContain(`validation-architect@${corePkg.version}`);
      expect(text, path).not.toMatch(/validation-architect@0\.1\./);
      expect(text, path).not.toMatch(/validation-architect@0\.2\./);
    }
  });

  it("the changelog names 0.3.0 as the candidate and supersedes 0.2.0", () => {
    const changelog = read("CHANGELOG.md");
    expect(changelog).toContain("## 0.3.0");
    expect(changelog).toMatch(/0\.2\.0.*(superseded|abandoned)|abandoned.*0\.2\.0/);
  });
});

describe("gated release workflow", () => {
  const workflow = read(".github/workflows/release.yml");

  it("fires only on explicit human dispatch with the full approval preview", () => {
    expect(workflow).toContain("workflow_dispatch");
    expect(workflow).not.toMatch(/\bon:\s*\n\s*push/);
    expect(workflow).not.toContain("pull_request");
    for (const input of ["commit", "tag", "core_digest", "design_digest"]) {
      expect(workflow).toContain(`${input}:`);
    }
  });

  it("publishes only behind the protected environment with trusted provenance", () => {
    expect(workflow).toContain("environment: npm-publish");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("--provenance");
    // No long-lived token: the workflow must not reference an NPM_TOKEN secret.
    expect(workflow).not.toContain("NPM_TOKEN");
  });

  it("verifies digests, preflight-checks existing versions, and never blindly republishes", () => {
    expect(workflow).toContain("digest mismatch");
    expect(workflow).toContain("already published");
    expect(workflow).toContain("RUNBOOK.md");
    // Publish order is documented: core before design.
    expect(workflow.indexOf("core.tgz --provenance")).toBeLessThan(workflow.indexOf("design.tgz --provenance"));
  });
});

describe("runbook", () => {
  it("covers the reconciliation states and forbids escape-by-bump", () => {
    const runbook = read("docs/release/RUNBOOK.md");
    for (const phrase of ["Partial", "ambiguous", "Never unpublish", "provenance", "approval preview"]) {
      expect(runbook).toContain(phrase);
    }
  });
});
