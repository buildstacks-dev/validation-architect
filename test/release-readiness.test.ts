import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { CORE_PACKAGE_VERSION } from "../src/versions.js";

/** Red-capable detectors for the two-dispatch, single-package release path. */

const root = join(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");
const packageManifest = JSON.parse(read("package.json"));
const node24ActionPins = [
  ["actions/checkout", "3d3c42e5aac5ba805825da76410c181273ba90b1"],
  ["actions/setup-node", "820762786026740c76f36085b0efc47a31fe5020"],
  ["actions/upload-artifact", "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"],
  ["actions/download-artifact", "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c"],
] as const;

function expectNode24ActionPins(workflow: string): void {
  for (const [action, commit] of node24ActionPins) {
    expect(workflow).toContain(`uses: ${action}@${commit}`);
  }
}

function shellBlocks(workflow: string): string[] {
  const lines = workflow.split("\n");
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)(?:-\s+)?run:\s*\|\s*$/.exec(lines[index] ?? "");
    if (!match) continue;
    const indentation = match[1]?.length ?? 0;
    const body: string[] = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (line !== "" && (line.match(/^\s*/)?.[0].length ?? 0) <= indentation) {
        index -= 1;
        break;
      }
      body.push(line);
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

describe("0.5.0 scoped single-package candidate identity", () => {
  it("keeps the manifest and code constant on one version", () => {
    expect(packageManifest.name).toBe("@cormidia/validation-architect");
    expect(packageManifest.version).toBe("0.5.0");
    expect(CORE_PACKAGE_VERSION).toBe(packageManifest.version);
  });

  it("exact-pins consumer guidance and carries no stale candidate", () => {
    for (const path of ["enablement/INSTALL.md", "README.md"]) {
      const text = read(path);
      expect(text, path).toContain(`@cormidia/validation-architect@${packageManifest.version}`);
      expect(text, path).not.toMatch(/validation-architect@0\.[12]\./);
    }
  });

  it("names 0.5.0 as the candidate and retains the closure history", () => {
    const changelog = read("CHANGELOG.md");
    expect(changelog).toContain("## 0.5.0");
    expect(changelog).toContain("## 0.4.16");
    expect(changelog).toContain("## 0.4.15");
    expect(changelog).toContain("## 0.4.14");
    expect(changelog).toContain("## 0.4.13");
    expect(changelog).toContain("## 0.4.12");
    expect(changelog).toContain("## 0.4.11");
    expect(changelog).toContain("## 0.4.10");
    expect(changelog).toContain("## 0.4.9");
    expect(changelog).toContain("## 0.4.8");
    expect(changelog).toContain("## 0.4.7");
    expect(changelog).toContain("## 0.4.6");
    expect(changelog).toContain("## 0.4.5");
    expect(changelog).toContain("## 0.4.4");
    expect(changelog).toContain("## 0.4.3");
    expect(changelog).toContain("## 0.4.2");
    expect(changelog).toContain("## 0.4.1");
    expect(changelog).toContain("## 0.4.0");
    expect(changelog).toContain("## 0.3.0");
    expect(changelog).toMatch(/0\.2\.0.*(superseded|abandoned)|abandoned.*0\.2\.0/);
  });
});

describe("candidate construction", () => {
  const script = read("scripts/release-candidate.mjs");

  it("has no dirty-tree bypass and checks cleanliness around construction", () => {
    expect(script).not.toContain("RELEASE_CANDIDATE_ALLOW_DIRTY");
    expect(script).toContain("--untracked-files=all");
    expect(script.match(/assertClean\(/g)).toHaveLength(3);
  });

  it("binds name, version, commit, and the exact tarball digest", () => {
    for (const value of [
      "@cormidia/validation-architect",
      "CORE_PACKAGE_VERSION",
      "git\", [\"rev-parse\", \"HEAD\"]",
      'createHash("sha256")',
      "tarballDigest",
    ]) {
      expect(script).toContain(value);
    }
    expect(script).not.toMatch(/run\("npm", \["(?:view|publish)/);
    expect(script).not.toMatch(/run\("git", \["tag/);
    expect(script).toContain("publish=false");
    expect(script).toContain("publish=true");
    expect(script).not.toContain("protected npm-publish environment");
  });
});

describe("gated release workflow", () => {
  const workflow = read(".github/workflows/release.yml");

  it("fires only on dispatch with the complete immutable preview", () => {
    expect(workflow).toContain("workflow_dispatch");
    expect(workflow).not.toMatch(/\bon:\s*\n\s*push/);
    expect(workflow).not.toContain("pull_request");
    for (const input of ["commit", "tag", "digest"]) {
      expect(workflow).toContain(`${input}:`);
    }
    expect(workflow).not.toContain("design_digest:");
    for (const shape of [
      "^[0-9a-f]{40}$",
      "^v[0-9]+\\.[0-9]+\\.[0-9]+$",
      "^[0-9a-f]{64}$",
    ]) {
      expect(workflow).toContain(shape);
    }
  });

  it("defaults to verify-only and schedules OIDC only on an explicit second dispatch", () => {
    const parsed = YAML.parse(workflow) as {
      on: {
        workflow_dispatch: {
          inputs: Record<string, { required?: boolean; type?: string; default?: boolean }>;
        };
      };
      jobs: Record<string, {
        if?: string;
        needs?: string;
        environment?: string;
        permissions?: Record<string, string>;
      }>;
    };
    expect(parsed.on.workflow_dispatch.inputs.publish).toMatchObject({
      required: true,
      type: "boolean",
      default: false,
    });
    expect(parsed.jobs.publish?.if).toBe("${{ inputs.publish == true }}");
    expect(parsed.jobs.publish?.needs).toBe("verify-candidate");
    expect(parsed.jobs.publish?.environment).toBe("npm-publish");
    expect(parsed.jobs.publish?.permissions?.["id-token"]).toBe("write");
    expect(parsed.jobs["verify-candidate"]?.permissions?.["id-token"]).toBeUndefined();
    expect(workflow.match(/id-token: write/g)).toHaveLength(1);
  });

  it("passes approved values to shells through environment variables", () => {
    for (const body of shellBlocks(workflow)) {
      expect(body).not.toMatch(/\$\{\{\s*(?:inputs|needs|runner)\./);
    }
  });

  it("uses runner-only context after the job reaches a runner", () => {
    const parsed = YAML.parse(workflow) as {
      jobs: Record<string, { env?: Record<string, string> }>;
    };
    for (const [jobId, job] of Object.entries(parsed.jobs)) {
      for (const [name, value] of Object.entries(job.env ?? {})) {
        expect(value, `jobs.${jobId}.env.${name}`).not.toMatch(/\$\{\{\s*runner\./);
      }
    }
    expect(workflow).toContain('CANDIDATE_DIR=$RUNNER_TEMP/candidate');
  });

  it("pins third-party actions and validates immutable source identity", () => {
    expect(workflow).not.toMatch(/uses:\s*actions\/[^@\s]+@v\d/);
    expect(workflow.match(/uses:\s*actions\/[^@\s]+@[0-9a-f]{40}/g)?.length).toBeGreaterThanOrEqual(6);
    expectNode24ActionPins(workflow);
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("fetch-tags: true");
    expect(workflow).toContain("git show-ref --verify --quiet refs/remotes/origin/main");
    expect(workflow).toContain("git merge-base --is-ancestor");
    expect(workflow).toContain("refs/remotes/origin/main");
    expect(workflow).toContain("tag does not point to approved commit");
    expect(workflow).toContain("dirty tree after packing");
    expect(workflow).not.toMatch(/^\s*git fetch\b/m);
  });

  it("uses identity-bound OIDC publishing without a token or provenance claim", () => {
    expect(workflow).toContain("environment: npm-publish");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("node-version: 24");
    expect(workflow).toContain("npm@11.19.0");
    expect(workflow).not.toContain("NPM_TOKEN");
    expect(workflow).not.toContain("--provenance");
  });

  it("reconciles exact integrity around one conditional publication", () => {
    const initial = workflow.indexOf("release-registry.mjs plan");
    const publish = workflow.indexOf('npm publish "$CANDIDATE_DIR/package.tgz"');
    const final = workflow.indexOf("release-registry.mjs verify");
    expect(initial).toBeGreaterThan(0);
    expect(initial).toBeLessThan(publish);
    expect(publish).toBeLessThan(final);
    expect(workflow.match(/continue-on-error: true/g)).toHaveLength(1);
    expect(workflow).toContain("steps.registry-plan.outputs.publish == 'true'");
    expect(workflow).toContain("if: always()");
  });
});

describe("declared runtime floor", () => {
  const workflow = read(".github/workflows/ci.yml");

  it("runs maintainer tooling only where pinned pnpm is supported", () => {
    expectNode24ActionPins(workflow);
    expect(workflow).toContain('node-version: ["22.14.0", "24"]');
    expect(workflow).toContain("pnpm typecheck");
    expect(workflow).toContain("pnpm test:package");
  });

  it("installs and imports the packed package under strict Node 20 engines", () => {
    expect(workflow).toContain("runtime-floor:");
    expect(workflow).toContain('node-version: "20"');
    expect(workflow).toContain('npm_config_engine_strict: "true"');
    expect(workflow).toContain('"$PACKAGE_DIR/package.tgz"');
    expect(workflow).toContain('from "@cormidia/validation-architect"');
    expect(workflow).toContain('from "@cormidia/validation-architect/design"');
    for (const entry of [
      "compile, check, explain, plan, ingest, render, migrate, design, resume",
      "LocalCampaignStore, LocalRepository, LocalTurnPort",
    ]) {
      expect(workflow).toContain(entry);
    }
  });
});

describe("release runbook", () => {
  const runbook = read("docs/release/RUNBOOK.md");

  it("documents private-repository OIDC without claiming provenance", () => {
    for (const phrase of ["private source repository", "omits `--provenance`", "npm 11.19.0", "Node 22.14"]) {
      expect(runbook).toContain(phrase);
    }
    expect(runbook).toMatch(/OIDC trusted\s+publishing/);
  });

  it("documents the one-time owner bootstrap and two-dispatch later recovery", () => {
    expect(runbook).toContain("only local publication");
    expect(runbook).toContain("npm publish ./package.tgz --access public --ignore-scripts");
    expect(runbook).toContain("same commit, tag, and digest");
    expect(runbook).toContain("Every later version is published only by the two-dispatch workflow");
    expect(runbook).toContain("workflow definition from current `main`");
    expect(runbook).toContain("physically unable to schedule");
    expect(runbook).toContain("leaving `publish=false`");
    expect(runbook).toContain("with `publish=true`");
    expect(runbook).toContain("GitHub Team does not support required environment reviewers for private");
    expect(runbook).toContain("subject binding");
    expect(runbook).not.toContain("environment approver");
    expect(runbook).toContain("Only a structured `E404` means absent");
    expect(runbook).toContain("exact npm `dist.integrity`");
  });
});
