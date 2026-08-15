import { describe, expect, it } from "vitest";
import { buildRelationshipGraph, queryRelationshipGraph, VALIDATION_TRACE_CHECK } from "../src/relationship-graph.js";
import { explainRelationshipQuery, generateRelationshipViews } from "../src/relationship-views.js";
import { relationshipTraceToValidationResult } from "../src/result-adapters.js";
import { validateValidationResult } from "../src/validation-result.js";
import { graphFixture } from "./core-graph-fixture.js";

function build() {
  const fixture = graphFixture();
  return { ...fixture, graph: buildRelationshipGraph({ ...fixture, model_identity: "model-1", projection_identity: "model-1", observed_paths: ["docs/contracts.md", "docs/retries.md", "artifacts/tenant.json", "artifacts/retry.json"] }) };
}

describe("model-native relationship graph", () => {
  it("answers both directions from structure, contract, family, test, evidence, and exact path", () => {
    const { graph } = build();
    expect(graph.structurally_closed).toBe(true);
    expect(graph.check).toEqual({ name: VALIDATION_TRACE_CHECK, required_check_handoff: true });
    for (const selector of ["CON-TENANT", "CF-TENANT", "TEST-TENANT", "EV-TENANT", "tests/tenant.test.ts"]) {
      const query = queryRelationshipGraph(graph, selector);
      expect(query.unresolved).toEqual([]);
      expect(query.nodes.map((item) => item.id)).toEqual(expect.arrayContaining(["CON-TENANT", "CF-TENANT", "TEST-TENANT", "EV-TENANT", "NC-TENANT", "OWN-TENANCY", "SRC-TENANCY"]));
      expect(query.nodes.map((item) => item.id)).not.toContain("CF-RETRY");
    }
  });

  it("leads explanations with product meaning and retains exact identities", () => {
    const { graph } = build();
    const query = queryRelationshipGraph(graph, "TEST-TENANT");
    const explanation = explainRelationshipQuery(query, graph);
    expect(explanation.indexOf("A lookup never returns another tenant's record")).toBeLessThan(explanation.indexOf("CF-TENANT"));
    expect(explanation).toContain("TEST-TENANT");
    expect(explanation).toContain("structural trace closure, not a claim of test fidelity");
  });

  it("generates all role projections from one immutable graph identity", () => {
    const { graph } = build();
    const query = queryRelationshipGraph(graph, "CF-TENANT");
    const views = generateRelationshipViews(graph, query);
    expect(Object.keys(views).sort()).toEqual(["architect", "author", "operator", "reviewer"]);
    expect(new Set(Object.values(views).map((item) => item.graph_identity))).toEqual(new Set([graph.identity.graph_identity]));
    expect(views.reviewer.markdown).toMatch(/Protected meaning[\s\S]*owner `OWN-TENANCY`[\s\S]*layer `L2`[\s\S]*oracle `state`[\s\S]*Live cloud tenancy[\s\S]*NC-TENANT[\s\S]*EV-TENANT/);
    const mutated = structuredClone(graph);
    mutated.identity.graph_identity = "mutated-graph";
    expect(new Set(Object.values(generateRelationshipViews(mutated, query)).map((item) => item.graph_identity))).toEqual(new Set(["mutated-graph"]));
  });

  it("keeps unresolved queries explicit and bounds cyclic traversal", () => {
    const { graph } = build();
    const unresolved = queryRelationshipGraph(graph, "UNKNOWN");
    expect(unresolved.unresolved).toEqual([expect.objectContaining({ code: "QUERY_UNRESOLVED", level: "unresolved" })]);
    const cyclic = structuredClone(graph);
    cyclic.edges.push({ from: "EV-TENANT", to: "CON-TENANT", type: "protects" });
    expect(queryRelationshipGraph(cyclic, "TEST-TENANT").nodes.length).toBeLessThanOrEqual(cyclic.nodes.length);
  });

  it("redacts credential-shaped adapter/model text from graph and query output", () => {
    const fixture = graphFixture();
    fixture.inventory.tests[0]!.command = "TOKEN=supersecret-value pnpm test";
    const graph = buildRelationshipGraph({ ...fixture, model_identity: "model-1" });
    expect(graph.findings).toContainEqual(expect.objectContaining({ code: "COMMAND_UNSAFE", level: "red" }));
    expect(JSON.stringify(graph)).not.toContain("supersecret-value");
    expect(JSON.stringify(queryRelationshipGraph(graph, "token=supersecret-value"))).not.toContain("supersecret-value");
  });

  it("keeps incomplete evidence visibly partial without claiming product green", () => {
    const fixture = graphFixture();
    fixture.evidence.items[0]!.state = "inconclusive";
    const graph = buildRelationshipGraph({ ...fixture, model_identity: "model-1" });
    expect(graph.structurally_closed).toBe(true);
    expect(graph.assurance_complete).toBe(false);
    expect(graph.findings).toContainEqual(expect.objectContaining({ code: "EVIDENCE_PARTIAL", level: "partial", subject_id: "EV-TENANT" }));
    expect(queryRelationshipGraph(graph, "EV-TENANT").nodes.find((item) => item.id === "EV-TENANT")?.state).toBe("inconclusive");
  });

  it("maps green, partial, and red graphs to fail-closed results and an operator view", () => {
    const context = (versions: ReturnType<typeof graphFixture>["model"]["versions"]) => ({
      identity: { product_revision: "rev-1", lane: "per-commit", environment: "offline-linux", versions },
      structure_id: "CON-TENANT",
      root_id: "TRACE-ROOT",
      owner: "OWN-TENANCY",
      evidence: [{ id: "EV-TRACE", kind: "artifact" as const, reference: "artifacts/trace.json", integrity: { algorithm: "sha256" as const, digest: "d".repeat(64) } }],
    });
    const clean = build();
    const cleanResult = relationshipTraceToValidationResult(clean.graph, context(clean.model.versions));
    expect(cleanResult).toMatchObject({ completeness: "complete", verdict: "pass" });
    expect(validateValidationResult(cleanResult)).toEqual([]);
    const operator = generateRelationshipViews(clean.graph, queryRelationshipGraph(clean.graph, "CF-TENANT"), { result: cleanResult }).operator;
    expect(operator.markdown).toMatch(/First cause and next action[\s\S]*TRACE-ROOT[\s\S]*Run identity[\s\S]*artifacts\/trace.json/);

    const partialFixture = graphFixture();
    partialFixture.evidence.items[0]!.state = "incomplete";
    const partial = buildRelationshipGraph({ ...partialFixture, model_identity: "model-1" });
    const partialResult = relationshipTraceToValidationResult(partial, context(partialFixture.model.versions));
    expect(partialResult).toMatchObject({ completeness: "incomplete", verdict: "inconclusive", reason: "evidence_incomplete" });
    expect(validateValidationResult(partialResult)).toEqual([]);

    const redFixture = graphFixture();
    redFixture.inventory.tests_root_present = false;
    const red = buildRelationshipGraph({ ...redFixture, model_identity: "model-1" });
    const redResult = relationshipTraceToValidationResult(red, context(redFixture.model.versions));
    expect(redResult).toMatchObject({ completeness: "complete", verdict: "fail", reason: "traceability_broken" });
    expect(validateValidationResult(redResult)).toEqual([]);
  });
});

describe("Validation Trace detector species", () => {
  const problems: Array<[string, (fixture: ReturnType<typeof graphFixture>) => void, string]> = [
    ["missing implementation", (fixture) => { fixture.inventory.tests = fixture.inventory.tests.filter((item) => !item.family_ids.includes("CF-RETRY")); fixture.evidence.items = fixture.evidence.items.filter((item) => !item.family_ids.includes("CF-RETRY")); }, "IMPLEMENTATION_MISSING"],
    ["orphan test", (fixture) => { fixture.inventory.tests.push({ id: "TEST-ORPHAN", path: "tests/orphan.test.ts", family_ids: ["CF-UNKNOWN"] }); }, "ORPHAN_TEST"],
    ["false landed", (fixture) => { fixture.inventory.tests = fixture.inventory.tests.filter((item) => !item.family_ids.includes("CF-RETRY")); fixture.evidence.items = fixture.evidence.items.filter((item) => !item.family_ids.includes("CF-RETRY")); }, "LANDED_STATUS_FALSE"],
    ["missing owner", (fixture) => { fixture.model.owners = []; }, "OWNER_MISSING"],
    ["broken negative control", (fixture) => { fixture.model.controls = fixture.model.controls.filter((item) => item.id !== "NC-RETRY"); }, "NEGATIVE_CONTROL_LINK_BROKEN"],
    ["missing evidence", (fixture) => { fixture.evidence.items = fixture.evidence.items.filter((item) => item.id !== "EV-RETRY"); }, "EVIDENCE_ARTIFACT_MISSING"],
    ["absent tests root", (fixture) => { fixture.inventory.tests_root_present = false; }, "TESTS_ROOT_ABSENT"],
    ["invalid evidence hash", (fixture) => { fixture.evidence.items[0]!.integrity = "not-a-hash"; }, "EVIDENCE_ARTIFACT_INVALID"],
  ];
  for (const [name, seed, code] of problems) it(`turns red for ${name}`, () => {
    const fixture = graphFixture();
    seed(fixture);
    const graph = buildRelationshipGraph({ ...fixture, model_identity: "model-1" });
    expect(graph.structurally_closed).toBe(false);
    expect(graph.findings).toContainEqual(expect.objectContaining({ code, level: "red" }));
  });

  it("turns red for broken source links, stale projections, and stale runtime identities", () => {
    const fixture = graphFixture();
    fixture.inventory.revision = "stale";
    const graph = buildRelationshipGraph({ ...fixture, model_identity: "model-1", projection_identity: "old-model", observed_paths: ["docs/contracts.md"] });
    expect(graph.findings.map((item) => item.code)).toEqual(expect.arrayContaining(["SOURCE_LINK_BROKEN", "GENERATED_VIEW_STALE", "INVENTORY_IDENTITY_MISMATCH"]));
  });
});
