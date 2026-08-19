import { describe, expect, it } from "vitest";
import { TRACEABILITY_CONVENTIONS } from "../src/conventions.js";

describe("TRACEABILITY_CONVENTIONS (issue #4)", () => {
  it("states the model-native conventions and keeps legacy syntax explicit", () => {
    expect(TRACEABILITY_CONVENTIONS).toContain("The checked YAML model is authority");
    expect(TRACEABILITY_CONVENTIONS).toContain("Repository facts stay observed facts");
    expect(TRACEABILITY_CONVENTIONS).toContain("Implementation closure is status-aware");
    expect(TRACEABILITY_CONVENTIONS).toContain("pending");
    expect(TRACEABILITY_CONVENTIONS).toContain("planned_tests");
    expect(TRACEABILITY_CONVENTIONS).toContain("Negative controls remain paired");
    expect(TRACEABILITY_CONVENTIONS).toContain("CONTROL_UNIMPLEMENTED");
    expect(TRACEABILITY_CONVENTIONS).toContain("Legacy headers are annotations, not authority");
    expect(TRACEABILITY_CONVENTIONS).toContain("Historical tokens cannot create or reject current model facts");
    expect(TRACEABILITY_CONVENTIONS).toContain("validation-design/model/*.yaml");
    expect(TRACEABILITY_CONVENTIONS).toContain("validation-architect check");
    expect(TRACEABILITY_CONVENTIONS).toContain("implement-harness-ticket");
    expect(TRACEABILITY_CONVENTIONS).toContain("planned-trace.md");
    expect(TRACEABILITY_CONVENTIONS).toContain("full applicable suite");
    expect(TRACEABILITY_CONVENTIONS).toContain("fresh human authorization");
  });
});
