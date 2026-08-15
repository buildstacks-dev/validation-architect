import type { TraceResult } from "./trace.js";
import type { ExplainedImpactPlan } from "./impact.js";
import type { RelationshipGraph } from "./relationship-graph.js";
import type { AuditState, RunState } from "./types.js";
import type { WorkspaceCompilation } from "./workspace-compiler.js";
import {
  createValidationResult,
  type ResultCaseRecord,
  type ResultEvidenceReference,
  type ResultIdentity,
  type ResultPlan,
  type ResultReason,
  type ValidationResultV1,
} from "./validation-result.js";

export interface ResultMappingContext {
  identity: ResultIdentity;
  structure_id: string;
  root_id: string;
  owner: string;
  evidence: ResultEvidenceReference[];
  plan?: ResultPlan;
}

/** Shared fail-closed mapping core. Exported for the sibling adapters that
 * live outside the published build (fidelity stays campaign-host-only so the
 * public compile closure never pulls provider-adjacent modules). */
export function mappedResult(
  context: ResultMappingContext,
  outcome: {
    completeness: "complete" | "incomplete";
    verdict: "pass" | "fail" | "inconclusive";
    reason?: ResultReason;
    summary: string;
    next_action: string;
    cases: ResultCaseRecord[];
    namespace: string;
    detail: unknown;
  },
): ValidationResultV1 {
  const root: ResultCaseRecord = {
    id: context.root_id,
    status: outcome.verdict === "pass" ? "pass" : outcome.verdict === "fail" ? "fail" : "inconclusive",
    summary: outcome.summary,
    evidence_ids: context.evidence.map((item) => item.id),
  };
  return createValidationResult({
    applicability: "applicable",
    completeness: outcome.completeness,
    verdict: outcome.verdict,
    ...("reason" in outcome ? { reason: outcome.reason } : {}),
    summary: outcome.summary,
    next_action: outcome.next_action,
    identity: context.identity,
    ownership: { structure_id: context.structure_id, root_id: context.root_id, owner: context.owner },
    cases: [root, ...outcome.cases.filter((item) => item.id !== root.id)],
    ...(context.plan ? { plan: context.plan } : {}),
    evidence: context.evidence,
    extensions: { [outcome.namespace]: outcome.detail },
  });
}

export function traceToValidationResult(trace: TraceResult, context: ResultMappingContext): ValidationResultV1 {
  const familyCases: ResultCaseRecord[] = (trace.manifest?.families ?? []).map((family) => ({
    id: family.id,
    status: trace.ok ? "pass" : "inconclusive",
    summary: `${family.id} trace status is ${family.status}`,
    evidence_ids: context.evidence.map((item) => item.id),
  }));
  return mappedResult(context, {
    completeness: "complete",
    verdict: trace.ok ? "pass" : "fail",
    ...(trace.ok ? {} : { reason: "traceability_broken" as const }),
    summary: trace.ok ? "Design-to-implementation trace is closed." : `Trace found ${trace.reds.length} closure problem(s).`,
    next_action: trace.ok ? "No trace repair is required." : "Repair every trace red before relying on implementation evidence.",
    cases: familyCases,
    namespace: "validation-architect.trace",
    detail: trace,
  });
}

export function relationshipTraceToValidationResult(graph: RelationshipGraph, context: ResultMappingContext): ValidationResultV1 {
  const partial = graph.findings.some((item) => item.level === "partial");
  const green = graph.structurally_closed && !partial;
  const cases: ResultCaseRecord[] = graph.nodes.filter((item) => item.kind === "family").map((family) => {
    const findings = graph.findings.filter((item) => item.subject_id === family.id);
    return {
      id: family.id,
      status: findings.some((item) => item.level === "red") ? "fail" : findings.length > 0 ? "inconclusive" : "pass",
      summary: findings.map((item) => item.message).join("; ") || family.meaning,
      evidence_ids: context.evidence.map((item) => item.id),
    };
  });
  const blockingFindings = graph.findings.filter((item) => item.level === "red" || item.level === "unresolved");
  if (blockingFindings.length > 0 && !cases.some((item) => item.status === "fail")) {
    cases.unshift({
      id: context.root_id,
      status: "fail",
      summary: blockingFindings.map((item) => item.message).join("; "),
      evidence_ids: context.evidence.map((item) => item.id),
    });
  } else if (partial && !cases.some((item) => item.status === "inconclusive" || item.status === "blocked")) {
    cases.unshift({
      id: context.root_id,
      status: "inconclusive",
      summary: graph.findings.filter((item) => item.level === "partial").map((item) => item.message).join("; "),
      evidence_ids: context.evidence.map((item) => item.id),
    });
  }
  return mappedResult(context, {
    completeness: !graph.structurally_closed || green ? "complete" : "incomplete",
    verdict: green ? "pass" : graph.structurally_closed ? "inconclusive" : "fail",
    ...(green ? {} : { reason: graph.structurally_closed ? "evidence_incomplete" as const : "traceability_broken" as const }),
    summary: green ? "Model-native structural trace is closed with complete evidence." : graph.structurally_closed ? "Structural trace is closed, but evidence remains partial." : `Validation Trace found ${graph.findings.filter((item) => item.level !== "partial").length} closure problem(s).`,
    next_action: green ? "Retain the exact graph identity; fidelity remains a separate judgment." : "Repair every red/unresolved link and collect complete evidence before product green.",
    cases,
    namespace: "validation-architect.relationship-trace",
    detail: graph,
  });
}

export function impactPlanToValidationResult(plan: ExplainedImpactPlan, context: ResultMappingContext): ValidationResultV1 {
  return mappedResult({ ...context, plan: plan.result_plan }, {
    completeness: "complete",
    verdict: "pass",
    summary: plan.expansions.length > 0 ? "Impact advice expanded fail-safe and produced a complete plan." : "Impact advice produced an exact explained plan.",
    next_action: "Use likely-first advice for feedback, then run the full required CI suite exactly once.",
    cases: plan.family_ids.map((id) => ({ id, status: "pass", summary: `Selected family ${id}`, evidence_ids: context.evidence.map((item) => item.id) })),
    namespace: "validation-architect.impact",
    detail: plan,
  });
}

export function compilerToValidationResult(compilation: WorkspaceCompilation, context: ResultMappingContext): ValidationResultV1 {
  const cases: ResultCaseRecord[] = compilation.diagnostics.map((diagnostic, index) => ({
    id: `COMPILER-${index + 1}`,
    status: diagnostic.severity === "error" ? "fail" : "pass",
    summary: `${diagnostic.concept}: ${diagnostic.message}`,
    evidence_ids: context.evidence.map((item) => item.id),
  }));
  return mappedResult(context, {
    completeness: "complete",
    verdict: compilation.accepted ? "pass" : "fail",
    ...(compilation.accepted ? {} : { reason: "traceability_broken" as const }),
    summary: compilation.accepted ? `Model ${compilation.identity} compiled cleanly.` : "The checked validation model is invalid or its projections are stale.",
    next_action: compilation.accepted ? "Use only projections bound to this model identity." : "Apply every source-located compiler correction and regenerate projections.",
    cases,
    namespace: "validation-architect.compiler",
    detail: compilation,
  });
}

export function campaignToValidationResult(state: RunState, context: ResultMappingContext): ValidationResultV1 {
  const complete = state.status === "completed";
  const reason: ResultReason | undefined = complete ? undefined : state.status === "failed" ? "harness_failure" : "evidence_incomplete";
  return mappedResult(context, {
    completeness: complete ? "complete" : "incomplete",
    verdict: complete ? "pass" : "inconclusive",
    ...(reason ? { reason } : {}),
    summary: complete ? `Campaign ${state.runId} completed its design gates.` : `Campaign ${state.runId} is ${state.status}.`,
    next_action: complete ? "Use the ratification package; do not treat campaign completion as product-test success." : state.statusReason ?? "Resume or inspect the interrupted campaign.",
    cases: [],
    namespace: "validation-architect.campaign",
    detail: state,
  });
}

export function auditToValidationResult(audit: AuditState, context: ResultMappingContext): ValidationResultV1 {
  const clean = audit.phase === "done" && audit.verdict === "clean";
  const unfinished = audit.phase !== "done" || !audit.verdict;
  const cases: ResultCaseRecord[] = audit.findings.map((finding) => ({
    id: finding.id,
    status: audit.dispositions[finding.id]?.kind === "fixed" ? "pass" : unfinished ? "inconclusive" : "fail",
    summary: finding.title,
    evidence_ids: context.evidence.map((item) => item.id),
  }));
  return mappedResult(context, {
    completeness: unfinished ? "incomplete" : "complete",
    verdict: clean ? "pass" : unfinished ? "inconclusive" : "fail",
    ...(clean ? {} : { reason: unfinished ? "evidence_incomplete" as const : "traceability_broken" as const }),
    summary: clean ? "Independent design audit is clean." : unfinished ? "Independent design audit is incomplete." : `Independent design audit ended ${audit.verdict}.`,
    next_action: clean ? "Retain the audit identity; this is not a product-test verdict." : "Resolve or explicitly arbitrate every graded audit finding.",
    cases,
    namespace: "validation-architect.audit",
    detail: audit,
  });
}

export function higherLaneToValidationResult(
  outcome: { status: "pass" | "fail" | "inconclusive" | "not-run"; summary: string; next_action: string; detail: unknown },
  context: ResultMappingContext,
): ValidationResultV1 {
  const incomplete = outcome.status === "inconclusive" || outcome.status === "not-run";
  return mappedResult(context, {
    completeness: incomplete ? "incomplete" : "complete",
    verdict: outcome.status === "pass" ? "pass" : outcome.status === "fail" ? "fail" : "inconclusive",
    ...(outcome.status === "fail" ? { reason: "product_failure" as const } : incomplete ? { reason: "evidence_incomplete" as const } : {}),
    summary: outcome.summary,
    next_action: outcome.next_action,
    cases: [],
    namespace: "validation-architect.higher-lane",
    detail: outcome.detail,
  });
}
