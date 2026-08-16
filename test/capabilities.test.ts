import { describe, expect, it } from "vitest";
import {
  STARTUP_CONFORMANCE_FIXTURES,
  bootstrapFailureToValidationResult,
  orderCapabilities,
  reduceDeclaredCausality,
  renderCausalSummary,
  runStartupConformance,
  startupRunToValidationResult,
  validateCapabilityGraph,
  type CapabilityDescriptor,
} from "../src/capabilities.js";
import type { ResultMappingContext } from "../src/result-adapters.js";
import {
  createValidationResult,
  evidenceReference,
  type ResultCaseRecord,
  type ValidationResultV1,
} from "../src/validation-result.js";
import { CURRENT_CORE_VERSIONS } from "../src/versions.js";

const evidence = evidenceReference("EV-PROBE", "probe", "evidence/probe.json", "probe evidence");

function context(rootId = "startup"): ResultMappingContext {
  return {
    identity: { product_revision: "abc123", lane: "inner-loop", environment: "local", versions: { ...CURRENT_CORE_VERSIONS } },
    structure_id: "OPS-STARTUP",
    root_id: rootId,
    owner: "host-runtime",
    evidence: [evidence],
  };
}

describe("startup capability contract", () => {
  it("orders cheapest foundational probes and starts supported dependents exactly once", () => {
    expect(orderCapabilities(STARTUP_CONFORMANCE_FIXTURES).map((item) => item.id)).toEqual([
      "process-identity",
      "offline-package-store",
      "live-child-start",
    ]);
    const starts: string[] = [];
    const run = runStartupConformance(
      STARTUP_CONFORMANCE_FIXTURES,
      [{ id: "offline-tests", depends_on: ["live-child-start"] }],
      (capability) => ({ capability_id: capability.id, status: "available", summary: `${capability.id} available`, next_action: "Proceed." }),
      (test) => starts.push(test.id),
    );
    expect(run.probe_starts).toEqual(["process-identity", "offline-package-store", "live-child-start"]);
    expect(run.test_starts).toEqual(["offline-tests"]);
    expect(starts).toEqual(["offline-tests"]);
    expect(startupRunToValidationResult(run, { ...context(), success_root_id: "startup" })).toMatchObject({ completeness: "complete", verdict: "pass" });
  });

  it("starts zero declared dependents after a prerequisite failure and aggregates missing roots", () => {
    const capabilities: CapabilityDescriptor[] = [
      { id: "identity", title: "Process identity", owner: "runtime", cost: 1, depends_on: [] },
      { id: "store", title: "Offline store", owner: "runtime", cost: 1, depends_on: [] },
      { id: "child", title: "Child start", owner: "runtime", cost: 2, depends_on: ["identity"] },
    ];
    const testStarts: string[] = [];
    const run = runStartupConformance(
      capabilities,
      [
        { id: "identity-dependent", depends_on: ["child"] },
        { id: "store-dependent", depends_on: ["store"] },
      ],
      (capability) => capability.id === "identity" || capability.id === "store"
        ? { capability_id: capability.id, status: "unavailable", summary: `${capability.title} unavailable`, next_action: `Repair ${capability.id}.` }
        : { capability_id: capability.id, status: "available", summary: "available", next_action: "Proceed." },
      (test) => testStarts.push(test.id),
    );
    expect(run.probe_starts).toEqual(["identity", "store"]);
    expect(run.test_starts).toEqual([]);
    expect(testStarts).toEqual([]);
    expect(run.capability_outcomes).toContainEqual({ capability_id: "child", status: "blocked", blocked_by: "identity" });

    const result = startupRunToValidationResult(run, { ...context(), success_root_id: "startup" });
    expect(result).toMatchObject({ completeness: "incomplete", verdict: "inconclusive", reason: "prerequisite_unavailable" });
    const reduction = reduceDeclaredCausality([result]);
    expect(reduction.roots).toEqual(expect.arrayContaining([
      expect.objectContaining({ root_id: "identity", affected_case_ids: ["child", "identity-dependent"] }),
      expect.objectContaining({ root_id: "store", affected_case_ids: ["store-dependent"] }),
    ]));
    expect(reduction.cases.map((item) => item.id)).toEqual(expect.arrayContaining(["identity", "store", "child", "identity-dependent", "store-dependent"]));
    expect(renderCausalSummary(reduction)).toMatch(/Every case remains[\s\S]*blocked_by/);
  });

  it("rejects missing edges and cycles before probing", () => {
    expect(validateCapabilityGraph([{ id: "A", title: "A", owner: "O", cost: 1, depends_on: ["MISSING"] }])).toContain("capability A depends on missing MISSING");
    expect(validateCapabilityGraph([
      { id: "A", title: "A", owner: "O", cost: 1, depends_on: ["B"] },
      { id: "B", title: "B", owner: "O", cost: 1, depends_on: ["A"] },
    ])).toEqual(expect.arrayContaining([expect.stringMatching(/cycle/)]));
  });

  it("maps pre-library failure into a secret-safe incomplete result", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz";
    const result = bootstrapFailureToValidationResult(
      {
        stage: "library-load",
        code: "IPC_EPERM",
        message: `IPC bootstrap failed with token=${secret}`,
        next_action: `Remove authorization=${secret} and retry in a supported host.`,
        affected_case_ids: ["CF-1", "CF-2"],
        sensitive_values: [secret],
        details: { raw_error: `credential ${secret}` },
      },
      context("CAP-BOOT"),
    );
    const serialized = JSON.stringify(result);
    expect(result).toMatchObject({ completeness: "incomplete", verdict: "inconclusive", reason: "prerequisite_unavailable" });
    expect(result.cases.filter((item) => item.status === "blocked")).toHaveLength(2);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");
  });

  it("preserves reviewed prose that merely contains an embedded sk substring", () => {
    const result = bootstrapFailureToValidationResult(
      {
        stage: "library-load",
        code: "REVIEW_REQUIRED",
        message: "E1/E2 remains risk-review-gated.",
        next_action: "Retain the reviewed risk gate.",
        affected_case_ids: [],
      },
      context("CAP-BOOT"),
    );
    expect(result.summary).toBe("E1/E2 remains risk-review-gated.");
    expect(result.summary).not.toContain("[REDACTED]");
  });
});

function causalResult(
  root: ResultCaseRecord,
  dependents: ResultCaseRecord[],
  environment = "local",
): ValidationResultV1 {
  const failed = root.status === "fail";
  return createValidationResult({
    applicability: "applicable",
    completeness: failed ? "complete" : "incomplete",
    verdict: failed ? "fail" : "inconclusive",
    reason: failed ? "product_failure" : "prerequisite_unavailable",
    summary: root.summary,
    next_action: `Repair ${root.id}.`,
    identity: { product_revision: "abc123", lane: "per-commit", environment, versions: { ...CURRENT_CORE_VERSIONS } },
    ownership: { structure_id: "CON-1", root_id: root.id, owner: "OWN-1" },
    cases: [root, ...dependents],
    evidence: [evidence],
    extensions: {},
  });
}

describe("declared causal reduction", () => {
  it("groups only explicit dependencies and leaves same-text failures independent", () => {
    const root = { id: "CAP-1", status: "inconclusive" as const, summary: "connection refused", evidence_ids: ["EV-PROBE"] };
    const grouped = causalResult(root, [
      { id: "CF-1", status: "blocked", blocked_by: "CAP-1", summary: "connection refused", evidence_ids: [] },
      { id: "CF-2", status: "blocked", blocked_by: "CAP-1", summary: "connection refused", evidence_ids: [] },
    ]);
    const independentA = causalResult({ id: "CF-A", status: "fail", summary: "same error text", evidence_ids: ["EV-PROBE"] }, []);
    const independentB = causalResult({ id: "CF-B", status: "fail", summary: "same error text", evidence_ids: ["EV-PROBE"] }, []);
    const reduction = reduceDeclaredCausality([grouped, independentA, independentB]);
    expect(reduction.roots).toEqual([expect.objectContaining({ root_id: "CAP-1", affected_case_ids: ["CF-1", "CF-2"] })]);
    expect(reduction.ungrouped_case_ids).toEqual(["CF-A", "CF-B"]);
  });

  it("rejects duplicate cases, cross-run identity, missing roots, and cycles", () => {
    const first = causalResult({ id: "CAP-1", status: "inconclusive", summary: "missing", evidence_ids: ["EV-PROBE"] }, []);
    expect(() => reduceDeclaredCausality([first, first])).toThrow(/duplicate causal case/);
    const ci = causalResult({ id: "CAP-2", status: "inconclusive", summary: "missing", evidence_ids: ["EV-PROBE"] }, [], "ci");
    expect(() => reduceDeclaredCausality([first, ci])).toThrow(/cross-run identities/);

    const missing = structuredClone(first) as ValidationResultV1;
    missing.cases = [{ id: "CF-1", status: "blocked", blocked_by: "MISSING", summary: "blocked", evidence_ids: [] }];
    expect(() => reduceDeclaredCausality([missing])).toThrow(/missing blocked_by root/);

    const cycle = structuredClone(first) as ValidationResultV1;
    cycle.ownership = { ...cycle.ownership!, root_id: "A" };
    cycle.cases = [
      { id: "A", status: "blocked", blocked_by: "B", summary: "A", evidence_ids: [] },
      { id: "B", status: "blocked", blocked_by: "A", summary: "B", evidence_ids: [] },
    ];
    expect(() => reduceDeclaredCausality([cycle])).toThrow(/cycle/);
  });
});
