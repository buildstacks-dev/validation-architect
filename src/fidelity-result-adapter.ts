/**
 * Fidelity → result/v1 mapping, split out of result-adapters.ts so the public
 * API compile closure never reaches fidelity.ts (which pulls the campaign-host
 * prompt/target/audit modules). This module is repo-internal: the published
 * build's entry points do not import it.
 */

import type { FidelityRunResult } from "./fidelity.js";
import { mappedResult, type ResultMappingContext } from "./result-adapters.js";
import type { ResultCaseRecord, ValidationResultV1 } from "./validation-result.js";

export function fidelityToValidationResult(fidelity: FidelityRunResult, context: ResultMappingContext): ValidationResultV1 {
  const outcomes = {
    ok: { completeness: "complete", verdict: "pass", summary: "Fidelity review found no implementation mismatch.", next: "Retain the exact revision-bound report." },
    findings: { completeness: "complete", verdict: "fail", reason: "traceability_broken", summary: `Fidelity review found ${fidelity.findings.length} mismatch(es).`, next: "Route each finding to implementation or structural revision." },
    "protocol-violation": { completeness: "incomplete", verdict: "inconclusive", reason: "harness_failure", summary: "Fidelity reporter violated its protocol.", next: "Discard the report and rerun a compliant fresh reviewer." },
    "refused-closure": { completeness: "incomplete", verdict: "inconclusive", reason: "traceability_broken", summary: "Fidelity review refused because deterministic closure is red.", next: "Repair trace closure before spending on fidelity judgment." },
  } as const;
  const outcome = outcomes[fidelity.status];
  const cases: ResultCaseRecord[] = fidelity.findings.map((finding) => ({ id: finding.id, status: "fail", summary: finding.title, evidence_ids: context.evidence.map((item) => item.id) }));
  return mappedResult(context, {
    completeness: outcome.completeness,
    verdict: outcome.verdict,
    ...("reason" in outcome ? { reason: outcome.reason } : {}),
    summary: outcome.summary,
    next_action: outcome.next,
    cases,
    namespace: "validation-architect.fidelity",
    detail: fidelity,
  });
}
