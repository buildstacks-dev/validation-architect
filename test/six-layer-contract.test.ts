import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { METHOD_VERSION } from "../src/versions.js";

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
    expect(read(paths[6]!)).toContain("L-ACC");
    expect(read(paths[0]!)).toContain("| Outcome-acceptance scenario |");
  });

  it("keeps the audit checklist and standalone prompt on the same six-layer contract", () => {
    const checklist = read("skill/validation-harness-audit/references/harness-policy-conformance.md");
    const standalone = read("skill/validation-harness-audit/STANDALONE_REVIEWER_PROMPT.md");
    const auditReadme = read("skill/validation-harness-audit/README.md");
    expect(checklist).toContain("Every one of the six layers and five execution lanes");
    expect(checklist).toContain("Outcome-acceptance integrity");
    expect(standalone).toContain("six validation layers");
    expect(standalone).toContain("For active `L-ACC`");
    expect(auditReadme).toContain("six validation layers");
    expect(`${checklist}\n${standalone}\n${auditReadme}`).not.toContain("five declared validation layers");
  });

  it("carries the unit-triangulation carve-out across grammar, probes, and primer (VA-MTH-001)", () => {
    // The derivation grammar names dense-logic components, the question bank
    // probes for them, and the primer's hermetic-vs-unit confusion entry
    // points at the deliberate triangulation exception.
    expect(read("skill/validation-harness-design/SKILL.md")).toContain("Dense-logic component");
    expect(read("skill/validation-harness-design/references/question-bank.md")).toContain(
      "behavior-level failure wouldn't tell you where to look",
    );
    expect(read("skill/validation-harness-design/references/concept-primers.md")).toContain(
      "purpose: triangulation",
    );
  });

  it("carries the lane-budget doctrine in both skills (VA-ENF-004)", () => {
    // The design skill states that a breached budget is a defect against the
    // harness; the audit checklist compares declared budgets to observed CI
    // durations. Both halves move with the max_duration_seconds schema field.
    expect(read("skill/validation-harness-design/SKILL.md")).toContain(
      "a breached budget is a defect against the harness, filed like any red",
    );
    expect(read("skill/validation-harness-audit/references/harness-policy-conformance.md")).toContain(
      "declared `max_duration_seconds` budget against observed CI durations",
    );
  });

  it("versions the skills through the package, not standalone VERSION files", () => {
    // Package-version conformance (VA-PKG-001): the skills ship inside the
    // core package and follow its declared METHOD_VERSION. They keep their
    // CHANGELOG.md files; separate VERSION files and contract manifests are
    // gone — the package version is the only version a consumer installs.
    expect(existsSync(resolve(root, "skill/validation-harness-design/VERSION"))).toBe(false);
    expect(existsSync(resolve(root, "skill/validation-harness-audit/VERSION"))).toBe(false);
    expect(existsSync(resolve(root, "skill/implement-harness-ticket/VERSION"))).toBe(false);
    expect(read("skill/validation-harness-design/CHANGELOG.md")).toContain(`## ${METHOD_VERSION}`);
    expect(read("skill/validation-harness-audit/CHANGELOG.md")).toContain(`## ${METHOD_VERSION}`);
  });
});
