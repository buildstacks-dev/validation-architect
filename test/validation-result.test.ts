import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  higherLaneToValidationResult,
  traceToValidationResult,
  type ResultMappingContext,
} from "../src/result-adapters.js";
import type { TraceResult } from "../src/trace.js";
import {
  canonicalValidationResult,
  canonicalValidationResultYaml,
  createCompletePass,
  createIncompleteResult,
  createNotApplicable,
  createProductFailure,
  createValidationResult,
  evidenceReference,
  isGreenValidationResult,
  parseValidationResult,
  readResultExtension,
  renderValidationResult,
  resultParityFingerprint,
  validateValidationResult,
  verifyEvidenceIntegrity,
  type ResultReason,
  type ValidationResultInput,
  type ValidationResultV1,
} from "../src/validation-result.js";
import { CURRENT_CORE_VERSIONS, RESULT_SCHEMA } from "../src/versions.js";

const evidence = evidenceReference("EV-1", "result", "evidence/result.json", "exact evidence");

function baseInput(overrides: Partial<ValidationResultInput> = {}): ValidationResultInput {
  return {
    applicability: "applicable",
    completeness: "complete",
    verdict: "pass",
    summary: "The accepted rule passed.",
    next_action: "No action required.",
    identity: {
      product_revision: "abc123",
      lane: "per-commit",
      environment: "local",
      versions: { ...CURRENT_CORE_VERSIONS },
    },
    ownership: { structure_id: "CON-1", root_id: "CF-1", owner: "OWN-1" },
    cases: [{ id: "CF-1", status: "pass", summary: "Tenant rule passed.", evidence_ids: ["EV-1"] }],
    evidence: [evidence],
    extensions: {},
    ...overrides,
  };
}

function matrixInput(
  applicability: "applicable" | "not_applicable",
  completeness: "complete" | "incomplete",
  verdict: "pass" | "fail" | "inconclusive",
  reason: ResultReason | undefined,
): ValidationResultV1 {
  const input = baseInput({ applicability, completeness, verdict, ...(reason ? { reason } : {}) });
  if (applicability === "not_applicable") {
    delete input.ownership;
    input.not_applicable_reason = "The product has no model call site.";
    input.cases = [];
    input.evidence = [];
  } else if (verdict === "fail") {
    input.cases = [{ id: "CF-1", status: "fail", summary: "The rule failed.", evidence_ids: ["EV-1"] }];
    if (completeness === "incomplete") input.cases.push({ id: "CF-2", status: "inconclusive", summary: "Unrelated evidence missing.", evidence_ids: [] });
  } else if (verdict === "inconclusive") {
    input.cases = [{ id: "CF-1", status: "inconclusive", summary: "Evidence did not settle the rule.", evidence_ids: ["EV-1"] }];
  }
  return { ...input, schema: RESULT_SCHEMA };
}

function expectedMatrixValidity(
  applicability: "applicable" | "not_applicable",
  completeness: "complete" | "incomplete",
  verdict: "pass" | "fail" | "inconclusive",
  reason: ResultReason | undefined,
): boolean {
  if (applicability === "not_applicable") return completeness === "complete" && verdict === "inconclusive" && reason === undefined;
  if (completeness === "complete" && verdict === "pass") return reason === undefined;
  if (verdict === "fail" && reason === "product_failure") return true;
  if (completeness === "complete" && verdict === "fail") return reason === "harness_failure" || reason === "traceability_broken";
  if (completeness === "incomplete" && verdict === "inconclusive") return reason !== undefined && reason !== "product_failure";
  return false;
}

describe("validation-architect/result/v1", () => {
  it("exhaustively enforces the axis/reason truth table and the sole green state", () => {
    const applicability = ["applicable", "not_applicable"] as const;
    const completeness = ["complete", "incomplete"] as const;
    const verdicts = ["pass", "fail", "inconclusive"] as const;
    const reasons: Array<ResultReason | undefined> = [undefined, "product_failure", "prerequisite_unavailable", "harness_failure", "evidence_incomplete", "traceability_broken"];
    let checked = 0;
    for (const applies of applicability) for (const complete of completeness) for (const verdict of verdicts) for (const reason of reasons) {
      const value = matrixInput(applies, complete, verdict, reason);
      const valid = validateValidationResult(value).length === 0;
      expect(valid, JSON.stringify({ applies, complete, verdict, reason })).toBe(expectedMatrixValidity(applies, complete, verdict, reason));
      expect(isGreenValidationResult(value)).toBe(valid && applies === "applicable" && complete === "complete" && verdict === "pass");
      checked += 1;
    }
    expect(checked).toBe(72);
  });

  it("keeps required skips incomplete and gives proven product failure precedence", () => {
    const skipped = createValidationResult(baseInput({
      completeness: "incomplete",
      verdict: "inconclusive",
      reason: "evidence_incomplete",
      summary: "A required test was not run.",
      next_action: "Run the required test.",
      cases: [{ id: "CF-1", status: "inconclusive", summary: "Required test skipped.", evidence_ids: ["EV-1"] }],
    }));
    expect(isGreenValidationResult(skipped)).toBe(false);
    expect(() => createValidationResult({ ...skipped, verdict: "pass" })).toThrow(/incomplete pass/);

    const mixed = createValidationResult(baseInput({
      completeness: "incomplete",
      verdict: "fail",
      reason: "product_failure",
      summary: "Tenant isolation failed while another case lacked evidence.",
      next_action: "Fix the proven isolation defect, then collect the missing evidence.",
      cases: [
        { id: "CF-1", status: "fail", summary: "Foreign tenant row returned.", evidence_ids: ["EV-1"] },
        { id: "CF-2", status: "inconclusive", summary: "Recovery evidence missing.", evidence_ids: [] },
      ],
    }));
    expect(mixed).toMatchObject({ verdict: "fail", reason: "product_failure", completeness: "incomplete" });
  });

  it("offers safe constructors for pass, fail, incomplete, and not-applicable outcomes", () => {
    const payload = baseInput();
    delete payload.schema;
    expect(createCompletePass(payload)).toMatchObject({ completeness: "complete", verdict: "pass" });
    expect(createProductFailure({ ...payload, cases: [{ id: "CF-1", status: "fail", summary: "failed", evidence_ids: ["EV-1"] }] }, "incomplete")).toMatchObject({ completeness: "incomplete", verdict: "fail", reason: "product_failure" });
    expect(createIncompleteResult({ ...payload, cases: [{ id: "CF-1", status: "inconclusive", summary: "missing", evidence_ids: ["EV-1"] }] }, "evidence_incomplete")).toMatchObject({ completeness: "incomplete", verdict: "inconclusive" });
    const { ownership: _ownership, cases: _cases, evidence: _evidence, ...notApplicablePayload } = payload;
    expect(createNotApplicable({ ...notApplicablePayload, not_applicable_reason: "No model call site." })).toMatchObject({ applicability: "not_applicable", completeness: "complete", verdict: "inconclusive" });
    expect(() => createValidationResult({ ...createNotApplicable({ ...notApplicablePayload, not_applicable_reason: "No model call site." }), not_applicable_reason: "" })).toThrow(/accepted reason/);
    expect(() => createValidationResult({ ...createCompletePass(payload), cases: [] })).toThrow(/at least one affected case/);
  });

  it("rejects missing identity/evidence, bad case graphs, stale hashes, and extension collisions", () => {
    const valid = createValidationResult(baseInput());
    expect(validateValidationResult({ ...valid, identity: { ...valid.identity, lane: "" } })).toContain("identity requires product_revision, lane, and environment");
    expect(validateValidationResult({ ...valid, evidence: [] })).toEqual(expect.arrayContaining([expect.stringMatching(/integrity-bound evidence/), expect.stringMatching(/missing evidence EV-1/)]));
    expect(validateValidationResult({ ...valid, cases: [...valid.cases, ...valid.cases] })).toContain("duplicate case id CF-1");
    expect(validateValidationResult({ ...valid, cases: [{ id: "CF-1", status: "blocked", blocked_by: "CF-X", summary: "blocked", evidence_ids: [] }] })).toContain("case CF-1 cites missing blocked_by root CF-X");
    expect(validateValidationResult({ ...valid, extensions: { verdict: "pass" } })).toEqual(expect.arrayContaining([expect.stringMatching(/not namespaced/), expect.stringMatching(/collides/)]));
    expect(verifyEvidenceIntegrity(valid, () => "changed evidence")).toEqual(["evidence EV-1 integrity mismatch"]);
  });

  it("serializes canonically, preserves namespaced detail, and renders actionable prose", () => {
    const result = createValidationResult(baseInput({ extensions: { "host.example": { native_status: "OK", retry: 0 } } }));
    expect(canonicalValidationResult(result)).toBe(canonicalValidationResult({ ...result, cases: [...result.cases].reverse() }));
    expect(readResultExtension<{ native_status: string }>(result, "host.example")).toEqual({ native_status: "OK", retry: 0 });
    expect(renderValidationResult(result)).toMatch(/GREEN[\s\S]*Next action[\s\S]*CF-1[\s\S]*sha256/);
  });

  it("matches golden JSON/YAML and parses each format without reinterpretation", () => {
    const result = createValidationResult(baseInput());
    const fixtureRoot = join(process.cwd(), "test", "fixtures", "validation-result");
    const json = readFileSync(join(fixtureRoot, "complete-pass.json"), "utf8");
    const yaml = readFileSync(join(fixtureRoot, "complete-pass.yaml"), "utf8");
    expect(canonicalValidationResult(result)).toBe(json);
    expect(canonicalValidationResultYaml(result)).toBe(yaml);
    expect(parseValidationResult(json, "json")).toEqual(result);
    expect(parseValidationResult(yaml, "yaml")).toEqual(result);
  });
});

function mappingContext(environment = "local"): ResultMappingContext {
  return {
    identity: { product_revision: "abc123", lane: "per-commit", environment, versions: { ...CURRENT_CORE_VERSIONS } },
    structure_id: "CON-1",
    root_id: "ROOT-1",
    owner: "OWN-1",
    evidence: [evidence],
    plan: { selected_scope: ["CF-1"], expansions: ["NC-1"], unresolved_mappings: [] },
  };
}

describe("stable-result domain mappings", () => {
  it("maps trace and higher-lane outcomes without losing native detail", () => {
    const trace: TraceResult = { ok: false, reds: ["forward: missing"], checks: { agreement: [], forward: ["missing"], backward: [], statusHonesty: [], structure: [] }, specs: [], report: "trace report" };
    const traceResult = traceToValidationResult(trace, mappingContext());
    expect(traceResult).toMatchObject({ verdict: "fail", reason: "traceability_broken" });
    expect(readResultExtension<TraceResult>(traceResult, "validation-architect.trace")?.reds).toEqual(trace.reds);

    const higher = { status: "not-run" as const, summary: "Authorization absent.", next_action: "Request per-run approval.", detail: { native: "STOPPED" } };
    expect(readResultExtension(higherLaneToValidationResult(higher, mappingContext()), "validation-architect.higher-lane")).toEqual(higher.detail);
  });

  it("makes local/CI parity explicit while disclosing environment differences", () => {
    const outcome = { status: "pass" as const, summary: "Qualification passed.", next_action: "Retain evidence.", detail: { native: "green" } };
    const local = higherLaneToValidationResult(outcome, mappingContext("local"));
    const ci = higherLaneToValidationResult(outcome, mappingContext("ci"));
    expect(local.identity.environment).not.toBe(ci.identity.environment);
    expect(resultParityFingerprint(local)).toBe(resultParityFingerprint(ci));
  });
});
