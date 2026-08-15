import { createHash } from "node:crypto";
import { parseDocument, stringify } from "yaml";
import type { CoreVersionBundle } from "./versions.js";
import { RESULT_SCHEMA } from "./versions.js";

export type ResultApplicability = "applicable" | "not_applicable";
export type ResultCompleteness = "complete" | "incomplete";
export type ResultVerdict = "pass" | "fail" | "inconclusive";
export type ResultReason =
  | "product_failure"
  | "prerequisite_unavailable"
  | "harness_failure"
  | "evidence_incomplete"
  | "traceability_broken";
export type ResultCaseStatus = "pass" | "fail" | "inconclusive" | "blocked" | "not_applicable";

export interface ResultEvidenceReference {
  id: string;
  kind: "artifact" | "log" | "probe" | "result";
  reference: string;
  integrity: { algorithm: "sha256"; digest: string };
}

export interface ResultCaseRecord {
  id: string;
  status: ResultCaseStatus;
  summary: string;
  evidence_ids: string[];
  blocked_by?: string;
}

export interface ResultIdentity {
  product_revision: string;
  lane: string;
  environment: string;
  versions: CoreVersionBundle;
}

export interface ResultPlan {
  selected_scope: string[];
  expansions: string[];
  unresolved_mappings: string[];
}

export interface ValidationResultV1 {
  schema: typeof RESULT_SCHEMA;
  applicability: ResultApplicability;
  completeness: ResultCompleteness;
  verdict: ResultVerdict;
  reason?: ResultReason;
  not_applicable_reason?: string;
  summary: string;
  next_action: string;
  identity: ResultIdentity;
  ownership?: { structure_id: string; root_id: string; owner: string };
  cases: ResultCaseRecord[];
  plan?: ResultPlan;
  evidence: ResultEvidenceReference[];
  extensions: Record<string, unknown>;
}

export type ValidationResultInput = Omit<ValidationResultV1, "schema"> & { schema?: typeof RESULT_SCHEMA };

const CORE_REASONS = new Set<ResultReason>([
  "product_failure",
  "prerequisite_unavailable",
  "harness_failure",
  "evidence_incomplete",
  "traceability_broken",
]);
const CASE_STATUSES = new Set<ResultCaseStatus>(["pass", "fail", "inconclusive", "blocked", "not_applicable"]);
const VERSION_KEYS: Array<keyof CoreVersionBundle> = ["package", "method", "model", "compiler", "policy", "result", "golden_set"];
const SECRET_PATTERN = /(?:AKIA[A-Z0-9]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{12,}|(?:token|secret|password|authorization)=(?!\[REDACTED\])\S+)/i;

function duplicate(values: readonly string[]): string[] {
  const seen = new Set<string>();
  return [...new Set(values.filter((value) => seen.has(value) || !seen.add(value)))];
}

function validateIdentity(identity: ResultIdentity | undefined, problems: string[]): void {
  if (!identity?.product_revision || !identity.lane || !identity.environment) {
    problems.push("identity requires product_revision, lane, and environment");
    return;
  }
  for (const key of VERSION_KEYS) if (!identity.versions?.[key]) problems.push(`identity.versions.${key} is required`);
  if (identity.versions?.result !== RESULT_SCHEMA) problems.push(`identity.versions.result must be ${RESULT_SCHEMA}`);
}

function validateCaseGraph(result: ValidationResultV1, problems: string[]): void {
  const ids = result.cases.map((item) => item.id);
  for (const id of duplicate(ids)) problems.push(`duplicate case id ${id}`);
  const cases = new Map(result.cases.map((item) => [item.id, item]));
  const evidence = new Set(result.evidence.map((item) => item.id));
  for (const item of result.cases) {
    if (!item.id || !item.summary || !CASE_STATUSES.has(item.status)) problems.push(`case ${item.id || "(missing)"} is invalid`);
    for (const evidenceId of item.evidence_ids) if (!evidence.has(evidenceId)) problems.push(`case ${item.id} cites missing evidence ${evidenceId}`);
    if (item.status === "blocked" && !item.blocked_by) problems.push(`blocked case ${item.id} requires blocked_by`);
    if (item.status !== "blocked" && item.blocked_by) problems.push(`non-blocked case ${item.id} cannot declare blocked_by`);
    if (item.blocked_by && !cases.has(item.blocked_by)) problems.push(`case ${item.id} cites missing blocked_by root ${item.blocked_by}`);
  }
  for (const item of result.cases) {
    const visited = new Set<string>([item.id]);
    let cursor = item.blocked_by;
    while (cursor) {
      if (visited.has(cursor)) { problems.push(`case dependency cycle includes ${cursor}`); break; }
      visited.add(cursor);
      cursor = cases.get(cursor)?.blocked_by;
    }
  }
  if (result.ownership && !cases.has(result.ownership.root_id)) problems.push(`owning root ${result.ownership.root_id} is absent from cases`);
}

function validateEvidence(result: ValidationResultV1, problems: string[]): void {
  for (const id of duplicate(result.evidence.map((item) => item.id))) problems.push(`duplicate evidence id ${id}`);
  for (const item of result.evidence) {
    if (!item.id || !item.reference || !["artifact", "log", "probe", "result"].includes(item.kind)) problems.push(`evidence ${item.id || "(missing)"} is invalid`);
    if (item.integrity?.algorithm !== "sha256" || !/^[a-f0-9]{64}$/.test(item.integrity?.digest ?? "")) problems.push(`evidence ${item.id} requires a lowercase sha256 digest`);
    if (SECRET_PATTERN.test(item.reference)) problems.push(`evidence ${item.id} reference may expose a secret`);
  }
}

function validateExtensions(extensions: Record<string, unknown>, problems: string[]): void {
  for (const key of Object.keys(extensions)) {
    if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(key)) problems.push(`extension key ${key} is not namespaced`);
    if (["schema", "applicability", "completeness", "verdict", "reason", "identity", "cases", "evidence"].includes(key)) problems.push(`extension key ${key} collides with a core field`);
  }
}

export function validateValidationResult(value: ValidationResultV1): string[] {
  const problems: string[] = [];
  if (value.schema !== RESULT_SCHEMA) problems.push(`schema must be ${RESULT_SCHEMA}`);
  if (!value.summary || !value.next_action) problems.push("summary and next_action are required");
  if (SECRET_PATTERN.test(value.summary) || SECRET_PATTERN.test(value.next_action)) problems.push("summary or next_action may expose a secret");
  validateIdentity(value.identity, problems);
  validateExtensions(value.extensions ?? {}, problems);
  validateEvidence(value, problems);
  validateCaseGraph(value, problems);

  if (value.applicability === "not_applicable") {
    if (!value.not_applicable_reason) problems.push("not_applicable requires an accepted reason");
    if (value.reason) problems.push("not_applicable cannot use an applicable failure reason");
    if (value.completeness !== "complete" || value.verdict !== "inconclusive") problems.push("not_applicable must be complete and inconclusive");
  } else if (value.applicability === "applicable") {
    if (value.not_applicable_reason) problems.push("applicable cannot use not_applicable_reason");
    if (!value.ownership?.structure_id || !value.ownership.root_id || !value.ownership.owner) problems.push("applicable requires owning structure, root, and owner");
    if (value.cases.length === 0) problems.push("applicable requires at least one affected case");
    if (value.evidence.length === 0) problems.push("applicable requires integrity-bound evidence");
    const greenAxes = value.completeness === "complete" && value.verdict === "pass";
    if (greenAxes && value.reason) problems.push("complete pass cannot have a failure reason");
    if (!greenAxes && (!value.reason || !CORE_REASONS.has(value.reason))) problems.push("applicable non-green requires exactly one core reason");
    if (value.verdict === "pass" && value.completeness !== "complete") problems.push("incomplete pass is invalid");
    if (value.completeness === "complete" && value.verdict === "inconclusive") problems.push("complete applicable evidence cannot be inconclusive");
    if (value.reason === "product_failure" && value.verdict !== "fail") problems.push("product_failure requires fail verdict");
    if (["prerequisite_unavailable", "evidence_incomplete"].includes(value.reason ?? "") && (value.completeness !== "incomplete" || value.verdict !== "inconclusive")) problems.push(`${value.reason} requires incomplete/inconclusive`);
    if (value.completeness === "incomplete" && value.verdict === "fail" && value.reason !== "product_failure") problems.push("only a proven product failure may remain fail with incomplete evidence");
  } else problems.push("applicability is invalid");

  if (value.verdict === "pass" && value.cases.some((item) => item.status !== "pass")) problems.push("pass requires every affected case to pass");
  if (value.verdict === "fail" && !value.cases.some((item) => item.status === "fail")) problems.push("fail requires at least one failed case");
  if (value.verdict === "inconclusive" && value.applicability === "applicable" && !value.cases.some((item) => item.status === "blocked" || item.status === "inconclusive")) problems.push("inconclusive requires a blocked or inconclusive case");
  return problems;
}

export function createValidationResult(input: ValidationResultInput): ValidationResultV1 {
  const result: ValidationResultV1 = { ...input, schema: RESULT_SCHEMA };
  const problems = validateValidationResult(result);
  if (problems.length > 0) throw new Error(`invalid ${RESULT_SCHEMA}: ${problems.join("; ")}`);
  return result;
}

type ApplicablePayload = Omit<ValidationResultInput, "schema" | "applicability" | "completeness" | "verdict" | "reason" | "not_applicable_reason">;

export function createCompletePass(payload: ApplicablePayload): ValidationResultV1 {
  return createValidationResult({ ...payload, applicability: "applicable", completeness: "complete", verdict: "pass" });
}

export function createProductFailure(payload: ApplicablePayload, completeness: ResultCompleteness = "complete"): ValidationResultV1 {
  return createValidationResult({ ...payload, applicability: "applicable", completeness, verdict: "fail", reason: "product_failure" });
}

export function createIncompleteResult(payload: ApplicablePayload, reason: Exclude<ResultReason, "product_failure">): ValidationResultV1 {
  return createValidationResult({ ...payload, applicability: "applicable", completeness: "incomplete", verdict: "inconclusive", reason });
}

export function createNotApplicable(
  payload: Omit<ApplicablePayload, "ownership" | "cases" | "evidence"> & { not_applicable_reason: string },
): ValidationResultV1 {
  return createValidationResult({ ...payload, applicability: "not_applicable", completeness: "complete", verdict: "inconclusive", cases: [], evidence: [] });
}

export function isGreenValidationResult(result: ValidationResultV1): boolean {
  return validateValidationResult(result).length === 0 && result.applicability === "applicable" && result.completeness === "complete" && result.verdict === "pass";
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableValue(item)]));
  return value;
}

export function canonicalValidationResult(result: ValidationResultV1): string {
  const problems = validateValidationResult(result);
  if (problems.length > 0) throw new Error(`cannot serialize invalid ${RESULT_SCHEMA}: ${problems.join("; ")}`);
  const normalized = { ...result, cases: [...result.cases].sort((a, b) => a.id.localeCompare(b.id)), evidence: [...result.evidence].sort((a, b) => a.id.localeCompare(b.id)) };
  return `${JSON.stringify(stableValue(normalized), null, 2)}\n`;
}

export function canonicalValidationResultYaml(result: ValidationResultV1): string {
  const canonical = JSON.parse(canonicalValidationResult(result)) as unknown;
  return stringify(canonical, { lineWidth: 0, sortMapEntries: true });
}

export function parseValidationResult(serialized: string, format: "json" | "yaml"): ValidationResultV1 {
  let value: unknown;
  if (format === "json") value = JSON.parse(serialized);
  else {
    const document = parseDocument(serialized, { prettyErrors: false });
    if (document.errors.length > 0) throw new Error(`invalid validation result YAML: ${document.errors[0]?.message}`);
    value = document.toJS({ maxAliasCount: 0 });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("validation result root must be an object");
  const result = value as ValidationResultV1;
  const problems = validateValidationResult(result);
  if (problems.length > 0) throw new Error(`invalid ${RESULT_SCHEMA}: ${problems.join("; ")}`);
  return result;
}

export function evidenceReference(id: string, kind: ResultEvidenceReference["kind"], reference: string, content: string | Uint8Array): ResultEvidenceReference {
  return { id, kind, reference, integrity: { algorithm: "sha256", digest: createHash("sha256").update(content).digest("hex") } };
}

export function verifyEvidenceIntegrity(result: ValidationResultV1, read: (reference: string) => string | Uint8Array): string[] {
  return result.evidence.flatMap((item) => createHash("sha256").update(read(item.reference)).digest("hex") === item.integrity.digest ? [] : [`evidence ${item.id} integrity mismatch`]);
}

export function readResultExtension<T>(result: ValidationResultV1, namespace: string): T | undefined {
  return result.extensions[namespace] as T | undefined;
}

export function renderValidationResult(result: ValidationResultV1): string {
  const state = isGreenValidationResult(result) ? "GREEN" : result.applicability === "not_applicable" ? "NOT APPLICABLE" : result.verdict.toUpperCase();
  const cases = result.cases.map((item) => `- \`${item.id}\`: ${item.status}${item.blocked_by ? ` (blocked by \`${item.blocked_by}\`)` : ""} — ${item.summary}`).join("\n") || "- None (rule not applicable).";
  const evidence = result.evidence.map((item) => `- \`${item.id}\` ${item.kind}: ${item.reference} (sha256 ${item.integrity.digest})`).join("\n") || "- None required.";
  return `# Validation result — ${state}\n\n${result.summary}\n\n- Reason: ${result.reason ?? result.not_applicable_reason ?? "complete success"}\n- Next action: ${result.next_action}\n- Revision: \`${result.identity.product_revision}\`\n- Lane/environment: \`${result.identity.lane}\` / \`${result.identity.environment}\`\n\n## Affected cases\n\n${cases}\n\n## Evidence\n\n${evidence}\n`;
}

export function resultParityFingerprint(result: ValidationResultV1): string {
  const comparable = { ...result, identity: { ...result.identity, environment: "<environment>" } };
  return createHash("sha256").update(canonicalValidationResult(comparable)).digest("hex");
}
