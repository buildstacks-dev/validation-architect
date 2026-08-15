import type { ResultMappingContext } from "./result-adapters.js";
import {
  createValidationResult,
  type ResultCaseRecord,
  type ValidationResultV1,
  validateValidationResult,
} from "./validation-result.js";

export interface CapabilityDescriptor {
  id: string;
  title: string;
  owner: string;
  cost: number;
  depends_on: string[];
}

export type CapabilityProbeOutcome = {
  capability_id: string;
  status: "available";
  summary: string;
  next_action: string;
} | {
  capability_id: string;
  status: "unavailable";
  summary: string;
  next_action: string;
};

export interface StartupTestDescriptor {
  id: string;
  depends_on: string[];
}

export interface StartupConformanceRun {
  capability_outcomes: Array<CapabilityProbeOutcome | { capability_id: string; status: "blocked"; blocked_by: string }>;
  tests: Array<{ id: string; started: boolean; blocked_by?: string }>;
  probe_starts: string[];
  test_starts: string[];
}

export interface BootstrapFailureEnvelope {
  stage: "outer-launcher" | "library-load" | "test-framework-load";
  code: string;
  message: string;
  next_action: string;
  affected_case_ids: string[];
  sensitive_values?: string[];
  details?: Record<string, unknown>;
}

export const STARTUP_CONFORMANCE_FIXTURES: readonly CapabilityDescriptor[] = Object.freeze([
  { id: "process-identity", title: "Required process identity", owner: "host-runtime", cost: 1, depends_on: [] },
  { id: "offline-package-store", title: "Offline package store", owner: "host-runtime", cost: 2, depends_on: ["process-identity"] },
  { id: "live-child-start", title: "Live child process start", owner: "host-runtime", cost: 3, depends_on: ["process-identity", "offline-package-store"] },
]);

export function validateCapabilityGraph(capabilities: readonly CapabilityDescriptor[], tests: readonly StartupTestDescriptor[] = []): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const item of capabilities) {
    if (!item.id || !item.title || !item.owner || !Number.isFinite(item.cost) || item.cost < 0) problems.push(`capability ${item.id || "(missing)"} is invalid`);
    if (ids.has(item.id)) problems.push(`duplicate capability ${item.id}`);
    ids.add(item.id);
  }
  for (const item of capabilities) for (const dependency of item.depends_on) if (!ids.has(dependency)) problems.push(`capability ${item.id} depends on missing ${dependency}`);
  const testsSeen = new Set<string>();
  for (const test of tests) {
    if (!test.id || testsSeen.has(test.id)) problems.push(`duplicate or missing startup test ${test.id || "(missing)"}`);
    testsSeen.add(test.id);
    for (const dependency of test.depends_on) if (!ids.has(dependency)) problems.push(`startup test ${test.id} depends on missing ${dependency}`);
  }
  const byId = new Map(capabilities.map((item) => [item.id, item]));
  const visit = (id: string, path: Set<string>, done: Set<string>) => {
    if (path.has(id)) { problems.push(`capability dependency cycle includes ${id}`); return; }
    if (done.has(id)) return;
    path.add(id);
    for (const dependency of byId.get(id)?.depends_on ?? []) visit(dependency, path, done);
    path.delete(id);
    done.add(id);
  };
  const done = new Set<string>();
  for (const id of ids) visit(id, new Set(), done);
  return [...new Set(problems)];
}

export function orderCapabilities(capabilities: readonly CapabilityDescriptor[]): CapabilityDescriptor[] {
  const problems = validateCapabilityGraph(capabilities);
  if (problems.length > 0) throw new Error(`invalid capability graph: ${problems.join("; ")}`);
  const pending = new Map(capabilities.map((item) => [item.id, item]));
  const completed = new Set<string>();
  const ordered: CapabilityDescriptor[] = [];
  while (pending.size > 0) {
    const ready = [...pending.values()].filter((item) => item.depends_on.every((id) => completed.has(id))).sort((a, b) => a.cost - b.cost || a.id.localeCompare(b.id));
    if (ready.length === 0) throw new Error("capability graph cannot be ordered");
    for (const item of ready) { ordered.push(item); completed.add(item.id); pending.delete(item.id); }
  }
  return ordered;
}

function failedRoot(id: string, outcomes: ReadonlyMap<string, StartupConformanceRun["capability_outcomes"][number]>): string | undefined {
  let current = outcomes.get(id);
  const seen = new Set<string>();
  while (current?.status === "blocked") {
    if (seen.has(current.blocked_by)) return undefined;
    seen.add(current.blocked_by);
    current = outcomes.get(current.blocked_by);
  }
  return current?.status === "unavailable" ? current.capability_id : undefined;
}

export function runStartupConformance(
  capabilities: readonly CapabilityDescriptor[],
  tests: readonly StartupTestDescriptor[],
  probe: (capability: CapabilityDescriptor) => CapabilityProbeOutcome,
  startTest: (test: StartupTestDescriptor) => void,
): StartupConformanceRun {
  const problems = validateCapabilityGraph(capabilities, tests);
  if (problems.length > 0) throw new Error(`invalid startup contract: ${problems.join("; ")}`);
  const capabilityOutcomes: StartupConformanceRun["capability_outcomes"] = [];
  const byId = new Map<string, StartupConformanceRun["capability_outcomes"][number]>();
  const probeStarts: string[] = [];
  for (const capability of orderCapabilities(capabilities)) {
    const blocker = capability.depends_on.map((id) => failedRoot(id, byId)).find((id): id is string => Boolean(id));
    const outcome = blocker
      ? { capability_id: capability.id, status: "blocked" as const, blocked_by: blocker }
      : probe(capability);
    if (!blocker) probeStarts.push(capability.id);
    if (outcome.capability_id !== capability.id) throw new Error(`probe for ${capability.id} returned ${outcome.capability_id}`);
    capabilityOutcomes.push(outcome);
    byId.set(capability.id, outcome);
  }
  const testResults: StartupConformanceRun["tests"] = [];
  const testStarts: string[] = [];
  for (const test of tests) {
    const blocker = test.depends_on.map((id) => failedRoot(id, byId)).find((id): id is string => Boolean(id));
    if (blocker) testResults.push({ id: test.id, started: false, blocked_by: blocker });
    else { startTest(test); testStarts.push(test.id); testResults.push({ id: test.id, started: true }); }
  }
  return { capability_outcomes: capabilityOutcomes, tests: testResults, probe_starts: probeStarts, test_starts: testStarts };
}

function redactText(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets.filter(Boolean)) redacted = redacted.split(secret).join("[REDACTED]");
  return redacted.replace(/AKIA[A-Z0-9]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|sk-[A-Za-z0-9_-]{12,}|((?:token|secret|password|authorization)=)\S+/gi, "$1[REDACTED]");
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, secrets)]));
  return value;
}

export function bootstrapFailureToValidationResult(envelope: BootstrapFailureEnvelope, context: ResultMappingContext): ValidationResultV1 {
  const secrets = envelope.sensitive_values ?? [];
  const rootId = context.root_id;
  const root: ResultCaseRecord = { id: rootId, status: "inconclusive", summary: redactText(envelope.message, secrets), evidence_ids: context.evidence.map((item) => item.id) };
  const affected = [...new Set(envelope.affected_case_ids)].filter((id) => id !== rootId).map<ResultCaseRecord>((id) => ({ id, status: "blocked", blocked_by: rootId, summary: `Not started because ${rootId} was unavailable.`, evidence_ids: [] }));
  return createValidationResult({ applicability: "applicable", completeness: "incomplete", verdict: "inconclusive", reason: "prerequisite_unavailable", summary: root.summary, next_action: redactText(envelope.next_action, secrets), identity: context.identity, ownership: { structure_id: context.structure_id, root_id: rootId, owner: context.owner }, cases: [root, ...affected], ...(context.plan ? { plan: context.plan } : {}), evidence: context.evidence, extensions: { "validation-architect.bootstrap": redactValue({ stage: envelope.stage, code: envelope.code, details: envelope.details ?? {} }, secrets) } });
}

export function startupRunToValidationResult(run: StartupConformanceRun, context: Omit<ResultMappingContext, "root_id"> & { success_root_id: string }): ValidationResultV1 {
  const unavailable = run.capability_outcomes.filter((item): item is Extract<CapabilityProbeOutcome, { status: "unavailable" }> => item.status === "unavailable");
  const primaryRoot = unavailable[0]?.capability_id ?? context.success_root_id;
  const evidenceIds = context.evidence.map((item) => item.id);
  const cases: ResultCaseRecord[] = run.capability_outcomes.map((item) => item.status === "available"
    ? { id: item.capability_id, status: "pass", summary: item.summary, evidence_ids: evidenceIds }
    : item.status === "unavailable"
      ? { id: item.capability_id, status: "inconclusive", summary: item.summary, evidence_ids: evidenceIds }
      : { id: item.capability_id, status: "blocked", blocked_by: item.blocked_by, summary: `Probe not started because ${item.blocked_by} was unavailable.`, evidence_ids: [] });
  for (const test of run.tests) cases.push(test.started ? { id: test.id, status: "pass", summary: "Startup prerequisites allowed exactly one start.", evidence_ids: evidenceIds } : { id: test.id, status: "blocked", blocked_by: test.blocked_by as string, summary: `Test not started because ${test.blocked_by} was unavailable.`, evidence_ids: [] });
  if (!cases.some((item) => item.id === primaryRoot)) cases.unshift({ id: primaryRoot, status: "pass", summary: "Startup contract completed.", evidence_ids: evidenceIds });
  return createValidationResult({ applicability: "applicable", completeness: unavailable.length === 0 ? "complete" : "incomplete", verdict: unavailable.length === 0 ? "pass" : "inconclusive", ...(unavailable.length > 0 ? { reason: "prerequisite_unavailable" as const } : {}), summary: unavailable.length === 0 ? "All declared startup capabilities were available." : `${unavailable.length} declared startup prerequisite(s) were unavailable.`, next_action: unavailable.length === 0 ? "Proceed with the declared dependent tests." : unavailable.map((item) => `${item.capability_id}: ${item.next_action}`).join(" "), identity: context.identity, ownership: { structure_id: context.structure_id, root_id: primaryRoot, owner: context.owner }, cases, ...(context.plan ? { plan: context.plan } : {}), evidence: context.evidence, extensions: { "validation-architect.startup": run } });
}

export interface CausalReduction {
  primary_root_id?: string;
  roots: Array<{ root_id: string; meaning: string; owner: string; next_action: string; affected_case_ids: string[] }>;
  ungrouped_case_ids: string[];
  cases: ResultCaseRecord[];
}

export function reduceDeclaredCausality(results: readonly ValidationResultV1[]): CausalReduction {
  if (results.length === 0) throw new Error("causal reduction requires at least one result");
  for (const result of results) { const problems = validateValidationResult(result); if (problems.length > 0) throw new Error(`invalid causal input: ${problems.join("; ")}`); }
  const identity = JSON.stringify(results[0]?.identity);
  if (results.some((result) => JSON.stringify(result.identity) !== identity)) throw new Error("causal inputs have cross-run identities");
  const cases = results.flatMap((result) => result.cases);
  const ids = new Set<string>();
  for (const item of cases) { if (ids.has(item.id)) throw new Error(`duplicate causal case ${item.id}`); ids.add(item.id); }
  const byId = new Map(cases.map((item) => [item.id, item]));
  for (const item of cases) if (item.blocked_by && !byId.has(item.blocked_by)) throw new Error(`case ${item.id} cites missing causal root ${item.blocked_by}`);
  const rootIds = [...new Set(cases.flatMap((item) => item.blocked_by ? [item.blocked_by] : []))];
  const descendants = (rootId: string) => cases.filter((item) => { let cursor = item.blocked_by; const seen = new Set<string>(); while (cursor) { if (cursor === rootId) return true; if (seen.has(cursor)) throw new Error(`causal cycle includes ${cursor}`); seen.add(cursor); cursor = byId.get(cursor)?.blocked_by; } return false; });
  const roots = rootIds.map((rootId) => {
    const ownerResult = results.find((result) => result.cases.some((item) => item.id === rootId));
    const root = byId.get(rootId) as ResultCaseRecord;
    return { root_id: rootId, meaning: root.summary, owner: ownerResult?.ownership?.owner ?? "unknown", next_action: ownerResult?.next_action ?? "Inspect the root result.", affected_case_ids: descendants(rootId).map((item) => item.id).sort() };
  }).sort((a, b) => b.affected_case_ids.length - a.affected_case_ids.length || a.root_id.localeCompare(b.root_id));
  const grouped = new Set(roots.flatMap((root) => [root.root_id, ...root.affected_case_ids]));
  const ungrouped = cases.filter((item) => item.status !== "pass" && !grouped.has(item.id)).map((item) => item.id).sort();
  return { ...(roots[0] ? { primary_root_id: roots[0].root_id } : {}), roots, ungrouped_case_ids: ungrouped, cases };
}

export function renderCausalSummary(reduction: CausalReduction): string {
  const roots = reduction.roots.map((root) => `- \`${root.root_id}\` — ${root.meaning} Owner: ${root.owner}. Next: ${root.next_action} Affected: ${root.affected_case_ids.join(", ") || "none"}.`).join("\n") || "- No declared causal group.";
  return `# Causal validation summary\n\n${roots}\n\nUngrouped non-green cases: ${reduction.ungrouped_case_ids.join(", ") || "none"}.\n\nEvery case remains in the machine record; grouping uses only explicit blocked_by edges.\n`;
}
