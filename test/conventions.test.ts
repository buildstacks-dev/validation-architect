import { describe, expect, it } from "vitest";
import { TRACEABILITY_CONVENTIONS } from "../src/conventions.js";
import { designerKickoff } from "../src/prompts.js";

describe("TRACEABILITY_CONVENTIONS (issue #4)", () => {
  it("states the three normative conventions the trace CLI depends on", () => {
    expect(TRACEABILITY_CONVENTIONS).toContain("Test directories are named by case-family ID");
    expect(TRACEABILITY_CONVENTIONS).toContain("Spec file headers cite the family and the owning backlog ticket");
    expect(TRACEABILITY_CONVENTIONS).toContain("Every implementable family owns ≥1 citing spec");
    expect(TRACEABILITY_CONVENTIONS).toContain("case-catalog.yaml");
    expect(TRACEABILITY_CONVENTIONS).toContain("validation-trace");
  });

  it("is embedded verbatim in the designer kickoff so every campaign emits it", () => {
    const kickoff = designerKickoff({
      name: "widgetd",
      dir: "/tmp/widgetd",
      displayName: "Widgetd",
      hasRambling: true,
    });
    expect(kickoff).toContain(TRACEABILITY_CONVENTIONS);
    expect(kickoff).toContain("case-catalog.yaml");
    expect(kickoff).toContain("validation-architect/case-catalog/v1");
  });
});
