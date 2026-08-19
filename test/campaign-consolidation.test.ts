import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const record = readFileSync(
  resolve(root, "docs/decisions/2026-08-19-campaign-consolidation.md"),
  "utf8",
);

const dispositions = new Map([
  ["fixture/demo runs", "replace"],
  ["immutable target capture", "port"],
  ["revision mode and source recovery", "replace"],
  ["model/auth configuration", "port"],
  ["rambling/intake hot reload", "port"],
  ["transcript and human report generation", "replace"],
  ["fresh readers and independent audit", "replace"],
  ["post-hoc readers/audit", "port"],
  ["branch delivery and idempotent re-delivery", "port"],
  ["fidelity audit", "port"],
  ["fleet registry and staleness reporting", "port"],
  ["live smoke behavior", "replace"],
  ["old aborted/completed run inspection", "drop"],
] as const);

describe("campaign consolidation capability record", () => {
  it("accounts exactly once for every unique legacy-host capability", () => {
    for (const [capability, disposition] of dispositions) {
      const row = `| **${capability}** | \`${disposition}\` |`;
      expect(record.split(row).length - 1, capability).toBe(1);
    }
    expect(record.match(/^\| \*\*[^|]+\*\* \| `(?:port|replace|drop)` \|/gm)).toHaveLength(dispositions.size);
  });

  it("selects one public-engine command and refuses legacy-state compatibility", () => {
    expect(record).toContain("`validation-architect-design` is the sole live campaign command");
    expect(record).toContain("public `design()` / `resume()` engine");
    expect(record).toContain("`CampaignCheckpoint` is the only campaign transition state");
    expect(record).toContain("no legacy compatibility path");
    expect(record).toContain("preserved untouched on this machine");
  });

  it("keeps the superseded host, state, adapters, tests, and duplicate fixtures deleted", () => {
    const removed = [
      "src/cli.ts",
      "src/orchestrator.ts",
      "src/designer.ts",
      "src/stakeholder.ts",
      "src/readers.ts",
      "src/auditor.ts",
      "src/types.ts",
      "src/run-state-version.ts",
      "src/markers.ts",
      "src/prompts.ts",
      "src/target.ts",
      "src/registry.ts",
      "src/fidelity.ts",
      "test/orchestrator.test.ts",
      "test/cli-acceptance.test.ts",
      "test/version-compatibility.test.ts",
      "fixtures",
    ];
    for (const path of removed) expect(existsSync(resolve(root, path)), path).toBe(false);
  });

  it("keeps provider SDKs and live imports outside the core package", () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.scripts?.vda).toBeUndefined();
    expect(pkg.dependencies).toEqual({ yaml: "^2.8.0" });
    expect(pkg.devDependencies).not.toHaveProperty("@anthropic-ai/claude-agent-sdk");
    expect(pkg.devDependencies).not.toHaveProperty("@openai/codex-sdk");

    const sourceFiles = (directory: string): string[] => readdirSync(directory).flatMap((entry) => {
      const path = resolve(directory, entry);
      return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
    });
    const coreSource = sourceFiles(resolve(root, "src")).map((path) => readFileSync(path, "utf8")).join("\n");
    expect(coreSource).not.toContain("@anthropic-ai/claude-agent-sdk");
    expect(coreSource).not.toContain("@openai/codex-sdk");
  });

  it("documents only the consolidated campaign command and state", () => {
    for (const path of ["README.md", "AGENTS.md"]) {
      const text = readFileSync(resolve(root, path), "utf8");
      expect(text, path).toContain("validation-architect-design");
      expect(text, path).not.toContain("pnpm vda");
      expect(text, path).not.toContain("RunState");
      expect(text, path).not.toContain("src/orchestrator.ts");
    }
  });
});
