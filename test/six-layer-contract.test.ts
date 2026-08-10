import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");

describe("six-layer design/audit contract", () => {
  it("propagates L-ACC through every load-bearing design reference", () => {
    const paths = [
      "skill/validation-harness-design/SKILL.md",
      "skill/validation-harness-design/README.md",
      "skill/validation-harness-design/references/concept-primers.md",
      "skill/validation-harness-design/references/question-bank.md",
      "skill/validation-harness-design/references/tooling-menu.md",
      "skill/validation-harness-design/references/llm-eval-patterns.md",
      "skill/validation-harness-design/references/policy-and-inheritance.md",
    ];
    for (const path of paths) {
      const text = read(path);
      expect(text, path).toMatch(/L-ACC|outcome.acceptance/i);
      expect(text, path).not.toMatch(/five validation layers/i);
    }
    expect(read(paths[6]!)).toContain("outcome_acceptance:");
    expect(read(paths[0]!)).toContain("| Outcome-acceptance scenario |");
  });

  it("keeps the audit checklist and standalone prompt on the same six-layer contract", () => {
    const checklist = read("skill/validation-harness-audit/references/harness-policy-conformance.md");
    const standalone = read("skill/validation-harness-audit/STANDALONE_REVIEWER_PROMPT.md");
    const auditReadme = read("skill/validation-harness-audit/README.md");
    expect(checklist).toContain("Every one of the six lanes");
    expect(checklist).toContain("Outcome-acceptance integrity");
    expect(standalone).toContain("six declared validation layers");
    expect(standalone).toContain("For active `L-ACC`");
    expect(auditReadme).toContain("six validation layers");
    expect(`${checklist}\n${standalone}\n${auditReadme}`).not.toContain("five declared validation layers");
  });

  it("versions the design and audit contract pair together", () => {
    const designVersion = read("skill/validation-harness-design/VERSION").trim();
    const auditVersion = read("skill/validation-harness-audit/VERSION").trim();
    expect(designVersion).toBe("0.6.1");
    expect(auditVersion).toBe(designVersion);
    expect(read("skill/validation-harness-design/CHANGELOG.md")).toContain(`## ${designVersion}`);
    expect(read("skill/validation-harness-audit/CHANGELOG.md")).toContain(`## ${auditVersion}`);
  });
});
