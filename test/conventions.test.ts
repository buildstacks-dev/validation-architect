import { describe, expect, it } from "vitest";
import { TRACEABILITY_CONVENTIONS } from "../src/conventions.js";
import { designerKickoff } from "../src/prompts.js";

describe("TRACEABILITY_CONVENTIONS (issue #4)", () => {
  it("states the model-native conventions and keeps legacy syntax explicit", () => {
    expect(TRACEABILITY_CONVENTIONS).toContain("The checked YAML model is authority");
    expect(TRACEABILITY_CONVENTIONS).toContain("Repository facts stay injected facts");
    expect(TRACEABILITY_CONVENTIONS).toContain("Every implementable family has an observed implementation");
    expect(TRACEABILITY_CONVENTIONS).toContain("Negative controls remain paired");
    expect(TRACEABILITY_CONVENTIONS).toContain("Legacy headers are adapter syntax, not authority");
    expect(TRACEABILITY_CONVENTIONS).toContain("validation-design/model/*.yaml");
    expect(TRACEABILITY_CONVENTIONS).toContain("validation-trace");
    expect(TRACEABILITY_CONVENTIONS).toContain("implement-harness-ticket");
    expect(TRACEABILITY_CONVENTIONS).toContain("planned-trace.md");
    expect(TRACEABILITY_CONVENTIONS).toContain("full applicable suite");
    expect(TRACEABILITY_CONVENTIONS).toContain("fresh human authorization");
  });

  it("is embedded verbatim in the designer kickoff so every campaign emits it", () => {
    const kickoff = designerKickoff({
      name: "widgetd",
      dir: "/tmp/widgetd",
      displayName: "Widgetd",
      hasRambling: true,
    });
    expect(kickoff).toContain(TRACEABILITY_CONVENTIONS);
    expect(kickoff).toContain("model/families.yaml");
    expect(kickoff).toContain("validation-architect/model/<name>/v1");
  });
});
