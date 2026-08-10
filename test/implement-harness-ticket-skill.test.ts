import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const skillPath = resolve(__dirname, "..", "skill", "implement-harness-ticket", "SKILL.md");

/** Basenames from the standard validation-design corpus layout (Enable leg). */
const KNOWN_CORPUS_ARTIFACTS = new Set([
  "case-catalog.md",
  "case-catalog.yaml",
  "harness-backlog.md",
  "invariants.md",
  "boundary-map.md",
  "llm-eval-plan.md",
  "validation-policy.yaml",
  "agents-md-contribution.md",
  "risk-allocation.md",
  "system-map.md",
  "owner-briefing.md",
  "owner-backlog.md",
  "trace-report.md",
  "contracts/",
  "acceptance/",
]);

/** Match `foo.md`, `foo.yaml`, or durable artifact-directory references in prose. */
const ARTIFACT_REF = /\b([a-z][a-z0-9-]*\.(?:md|yaml)|(?:contracts|acceptance)\/)\b/g;

function parseFrontmatter(source: string): { name?: string; description?: string; body: string } {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { body: source };
  const front = match[1] as string;
  const body = match[2] as string;
  const out: { name?: string; description?: string; body: string } = { body };
  const name = front.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = front.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (name !== undefined) out.name = name;
  if (description !== undefined) out.description = description;
  return out;
}

describe("implement-harness-ticket skill (issue #6)", () => {
  it("exists beside the vendored design/audit skills", () => {
    expect(existsSync(skillPath)).toBe(true);
  });

  it("has YAML frontmatter and teaches the required workflow", () => {
    const source = readFileSync(skillPath, "utf8");
    const { name, description, body } = parseFrontmatter(source);

    expect(name).toBe("implement-harness-ticket");
    expect(description).toBeTruthy();
    expect(body).toMatch(/^#\s+Implement Harness Ticket/m);

    const text = source.toLowerCase();

    // Four-level resolution chain
    expect(text).toMatch(/four-level|four level/);
    expect(text).toContain("harness-backlog.md");
    expect(text).toContain("case-catalog.yaml");
    expect(text).toMatch(/enumeration/);
    expect(text).toMatch(/invariants\.md|boundary-map|contracts/);
    expect(text).toContain("acceptance/");
    expect(text).toMatch(/l-acc|outcome acceptance/);
    expect(text).toMatch(/inconclusive/);

    // Standing rules digest
    expect(text).toMatch(/cheapest falsifying layer|cheapest.*layer/);
    expect(text).toMatch(/red-then-green|red then green/);
    expect(text).toMatch(/non-empty walk/);
    expect(text).toMatch(/tighten-only|tighten only/);
    expect(text).toMatch(/green by absence|no green by absence/);
    expect(text).toMatch(/detector-deposit|detector deposit/);

    // File/header conventions (issue #4)
    expect(text).toMatch(/cf-inv-001|family id/);
    expect(text).toMatch(/spec file headers|headers cite/);
    expect(text).toMatch(/pending wave/);
    expect(text).toMatch(/same change/);

    // Structural escalation + architect boundary
    expect(text).toMatch(/structural change|structural-change/);
    expect(text).toMatch(/harness-revision/);
    expect(text).toMatch(/never.*writes product or test code|does not write product/);

    // Trace CLI
    expect(text).toContain("validation-trace");
  });

  it("references only known corpus artifact basenames", () => {
    const source = readFileSync(skillPath, "utf8");
    const refs = [...source.matchAll(ARTIFACT_REF)].map((m) => m[1] as string);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(KNOWN_CORPUS_ARTIFACTS.has(ref), `unexpected artifact reference: ${ref}`).toBe(true);
    }
  });
});
