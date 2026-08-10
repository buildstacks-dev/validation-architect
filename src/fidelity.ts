import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseFindings } from "./audit.js";
import type { CaseCatalogManifest, CatalogFamily, CatalogTicket } from "./catalog.js";
import { creditedFamilyIds } from "./catalog.js";
import { fidelityAuditorPrompt } from "./prompts.js";
import { runTrace, type TraceOptions } from "./trace.js";
import { captureTargetRevision, verifyTargetRevision } from "./target.js";
import type { AuditFinding, AuditorRunner, TargetRevision } from "./types.js";

/**
 * The fidelity audit (issue #7): a fresh-context judgment pass over a product
 * repo, scoped per wave or per ticket set, asking the ONE question the trace
 * CLI deliberately does not: do the citing specs actually falsify their
 * ratified seeds, or has the case been quietly weakened?
 *
 * Boundaries (from the decision record and the #7 design comment):
 * - Findings only. The auditor never proposes patches, never edits files —
 *   remediation belongs to the product repo's coding agents. Enforced in the
 *   prompt AND by the report-format guard here (both halves, like the audit
 *   loop's convergence rules).
 * - Deterministic closure comes first: a trace-red repo is REFUSED — fix
 *   closure before asking for judgment; the auditor must not spend tokens
 *   rediscovering missing files.
 * - Not part of the campaign state machine: no state.json, no resumability
 *   surface. Standalone entry like `vda audit`, but pointed at a product
 *   repo instead of a campaign workspace.
 */

/** Fidelity findings use the AUD-9xx range: campaign audits own 1xx/2xx, post-hoc 3xx+. */
export const FIDELITY_ITERATION = 9;

export interface FidelityScopeFamily {
  family: CatalogFamily;
  /** Specs the trace CLI credits to this family (paths relative to the target root). */
  files: string[];
}

export interface FidelityScope {
  label: string;
  tickets: CatalogTicket[];
  families: FidelityScopeFamily[];
}

/**
 * Resolve the audited sample: explicit tickets win, else a wave, else the
 * whole backlog. Exhaustive within scope (the #7 default); unknown ids and
 * empty scopes fail closed.
 */
export function resolveFidelityScope(
  manifest: CaseCatalogManifest,
  specsByFamily: Map<string, string[]>,
  opts: { wave?: string; tickets?: string[] },
): FidelityScope {
  let tickets: CatalogTicket[];
  let label: string;
  if (opts.tickets && opts.tickets.length > 0) {
    const byId = new Map(manifest.tickets.map((t) => [t.id, t]));
    tickets = opts.tickets.map((id) => {
      const t = byId.get(id);
      if (!t) throw new Error(`Unknown ticket "${id}" — not in the manifest's backlog.`);
      return t;
    });
    label = `tickets ${tickets.map((t) => t.id).join(", ")}`;
  } else if (opts.wave !== undefined) {
    tickets = manifest.tickets.filter((t) => t.wave === opts.wave);
    if (tickets.length === 0) {
      throw new Error(
        `Wave "${opts.wave}" owns no tickets. Waves in the manifest: ${[...new Set(manifest.tickets.map((t) => t.wave))].join(", ") || "(none)"}`,
      );
    }
    label = `wave ${opts.wave}`;
  } else {
    tickets = manifest.tickets;
    if (tickets.length === 0) throw new Error("The manifest has no backlog tickets to scope a fidelity audit to.");
    label = "all waves";
  }

  const familyIds = new Set(tickets.flatMap((t) => t.families));
  const families = manifest.families
    .filter((f) => familyIds.has(f.id) && f.status === "implementable")
    .map((f) => ({ family: f, files: specsByFamily.get(f.id) ?? [] }));
  if (families.length === 0) {
    throw new Error(`Scope "${label}" contains no implementable families — nothing to judge.`);
  }
  return { label, tickets, families };
}

/** Specs credited per family id, from the trace scan (same crediting rule as coverage). */
export function specsByFamily(
  manifest: CaseCatalogManifest,
  specs: Array<{ path: string; citations: string[] }>,
): Map<string, string[]> {
  const map = new Map<string, string[]>(manifest.families.map((f) => [f.id, []]));
  for (const spec of specs) {
    const credited = new Set<string>();
    for (const c of spec.citations) {
      for (const id of creditedFamilyIds(c, manifest.families)) credited.add(id);
    }
    for (const id of credited) (map.get(id) as string[]).push(spec.path);
  }
  return map;
}

/**
 * The findings-only format guard — the parser half of the no-patches rule.
 * A fidelity report containing a patch is a protocol violation regardless of
 * how good the patch is.
 */
export function checkFidelityReportFormat(text: string): string[] {
  const violations: string[] = [];
  if (/```(diff|patch)\b/i.test(text)) {
    violations.push("report contains a fenced diff/patch block — fidelity reports are findings ledgers only");
  }
  if (/^\+\+\+ \S/m.test(text) || /^@@ .*@@/m.test(text)) {
    violations.push("report contains unified-diff hunks — fidelity reports are findings ledgers only");
  }
  if (/apply (this|the following) (change|patch|diff)/i.test(text)) {
    violations.push('report instructs "apply this change/patch" — remediation belongs to the product repo\'s agents');
  }
  const wrongIds = parseFindings(text, FIDELITY_ITERATION)
    .map((finding) => finding.id)
    .filter((id) => !/^AUD-9\d{2}$/.test(id));
  if (wrongIds.length > 0) {
    violations.push(`findings use ids outside the reserved AUD-9xx range: ${wrongIds.join(", ")}`);
  }
  return violations;
}

/**
 * The completeness half of the report contract: the rubric makes the
 * "What I checked" coverage section mandatory even at zero findings, so an
 * auditor session that ends on mid-work narration (observed live: "waiting
 * for the remaining sub-passes to complete") cannot read as a clean pass.
 * Fail-closed, same discipline as the no-patches guard.
 */
export function checkFidelityReportCompleteness(text: string, scope?: FidelityScope): string[] {
  const violations: string[] = [];
  if ((text.match(/^[^\r\n]*/)?.[0] ?? "").trim().toLowerCase() !== "mode: fidelity") {
    violations.push('report lacks the required first-line "mode: fidelity" marker');
  }
  const heading = /^#{1,6}\s+what i checked\s*$/im.exec(text);
  if (!heading) {
    violations.push(
      'report lacks the mandatory "What I checked" coverage section — an incomplete auditor session must not read as a clean pass',
    );
    return violations;
  }

  const checked = text.slice(heading.index + heading[0].length);
  if (
    !/(?:all\s+four\s+axes|axes?\s+a\s*[–-]\s*d|seed coverage[\s\S]*negative-control reality[\s\S]*oracle match[\s\S]*no quiet narrowing)/i.test(
      checked,
    )
  ) {
    violations.push('"What I checked" does not attest that all four fidelity axes were applied');
  }
  for (const entry of scope?.families ?? []) {
    const escapedId = entry.family.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const idPattern = new RegExp(`(?:^|[^A-Za-z0-9-])${escapedId}(?![A-Za-z0-9-])`, "i");
    if (!idPattern.test(checked)) {
      violations.push(`"What I checked" omits scoped family ${entry.family.id}`);
      continue;
    }
    for (const file of entry.files) {
      if (!checked.includes(file)) {
        violations.push(`"What I checked" omits scoped file ${file} for ${entry.family.id}`);
      }
    }
  }
  return violations;
}

export interface FidelityOptions extends TraceOptions {
  wave?: string;
  tickets?: string[];
  /** Trusted identity supplied only by runBoundFidelityAudit for report provenance. */
  targetRevision?: TargetRevision;
}

export type FidelityStatus = "ok" | "findings" | "protocol-violation" | "refused-closure";

export interface FidelityRunResult {
  status: FidelityStatus;
  /** Trace reds when refused. */
  reds: string[];
  findings: AuditFinding[];
  violations: string[];
  scope?: FidelityScope;
  prompt?: string;
  /** The full report document (header + auditor text), ready to write. */
  report: string;
}

export interface BoundFidelityRunResult {
  result: FidelityRunResult;
  /** Pre-audit identity. Registry writes must bind this exact value. */
  targetRevision: TargetRevision;
}

function revisionReportLines(revision: TargetRevision | undefined): string {
  return revision
    ? `target-commit: ${revision.commit}\ntarget-tree: ${revision.sourceTree}\ntarget-captured-at: ${revision.capturedAt}\ninput: detached immutable snapshot\n`
    : "";
}

export async function runFidelityAudit(
  auditor: AuditorRunner,
  targetRoot: string,
  opts: FidelityOptions = {},
): Promise<FidelityRunResult> {
  const traceOpts: TraceOptions = {
    ...(opts.manifestPath !== undefined ? { manifestPath: opts.manifestPath } : {}),
    ...(opts.testsRoot !== undefined ? { testsRoot: opts.testsRoot } : {}),
  };
  const trace = runTrace(targetRoot, traceOpts);
  if (!trace.ok || !trace.manifest) {
    return {
      status: "refused-closure",
      reds: trace.reds,
      findings: [],
      violations: [],
      report: `# Fidelity audit — REFUSED\n${revisionReportLines(opts.targetRevision)}\nClosure is red; fix closure before asking for judgment (guardrails-enforce before evals-measure, applied recursively). Trace findings:\n\n${trace.reds.map((r) => `- ${r}`).join("\n")}\n`,
    };
  }

  const scope = resolveFidelityScope(trace.manifest, specsByFamily(trace.manifest, trace.specs), {
    ...(opts.wave !== undefined ? { wave: opts.wave } : {}),
    ...(opts.tickets !== undefined ? { tickets: opts.tickets } : {}),
  });
  const prompt = fidelityAuditorPrompt(scope, trace.manifest.product);
  const text = await auditor.run(prompt, targetRoot);
  const violations = [...checkFidelityReportFormat(text), ...checkFidelityReportCompleteness(text, scope)];
  const findings = parseFindings(text, FIDELITY_ITERATION);

  const header = `# Fidelity audit${trace.manifest.product ? ` — ${trace.manifest.product}` : ""}
mode: fidelity
scope: ${scope.label}
date: ${new Date().toISOString().slice(0, 10)}
${revisionReportLines(opts.targetRevision)}closure: green (${trace.specs.length} spec files scanned)
findings: ${findings.length}${violations.length > 0 ? `\nPROTOCOL-VIOLATION: ${violations.join("; ")}` : ""}

Findings only — remediation belongs to the product repo's coding agents (route
via the implement-harness-ticket skill; structural findings re-enter
validation-harness-design's harness-revision mode).

---

`;
  return {
    status: violations.length > 0 ? "protocol-violation" : findings.length > 0 ? "findings" : "ok",
    reds: [],
    findings,
    violations,
    scope,
    prompt,
    report: header + text.trim() + "\n",
  };
}

function snapshotOptionPath(
  value: string | undefined,
  targetRoot: string,
  label: string,
): string | undefined {
  if (value === undefined) return undefined;
  const target = resolve(targetRoot);
  const absolute = isAbsolute(value) ? resolve(value) : resolve(target, value);
  const rel = relative(target, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} must be inside the target repo when fidelity uses an immutable snapshot: ${value}`);
  }
  return rel || ".";
}

/**
 * Run a fidelity pass against a detached, no-remote clone of one clean target
 * revision. The user's checkout is checked again after the pass; any movement
 * invalidates the result even though the auditor itself saw immutable input.
 */
export async function runBoundFidelityAudit(
  auditor: AuditorRunner,
  targetRoot: string,
  opts: FidelityOptions = {},
): Promise<BoundFidelityRunResult> {
  const target = resolve(targetRoot);
  const targetRevision = captureTargetRevision(target);
  const temp = mkdtempSync(join(tmpdir(), "vda-fidelity-"));
  const snapshot = join(temp, "target");
  let result: FidelityRunResult | undefined;
  let auditError: unknown;
  let verificationError: unknown;
  try {
    const manifestPath = snapshotOptionPath(opts.manifestPath, target, "--manifest");
    const testsRoot = snapshotOptionPath(opts.testsRoot, target, "--tests");
    execFileSync("git", ["clone", "--no-local", "--no-checkout", "--quiet", "--", target, snapshot], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" },
    });
    execFileSync("git", ["checkout", "--detach", "--quiet", targetRevision.commit], {
      cwd: snapshot,
      stdio: ["ignore", "ignore", "pipe"],
    });
    execFileSync("git", ["remote", "remove", "origin"], {
      cwd: snapshot,
      stdio: ["ignore", "ignore", "pipe"],
    });
    try {
      result = await runFidelityAudit(auditor, snapshot, {
        ...opts,
        ...(manifestPath !== undefined ? { manifestPath } : {}),
        ...(testsRoot !== undefined ? { testsRoot } : {}),
        targetRevision,
      });
    } catch (err) {
      auditError = err;
    }
    try {
      verifyTargetRevision(target, targetRevision);
    } catch (err) {
      verificationError = err;
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  if (verificationError) throw verificationError;
  if (auditError) throw auditError;
  if (!result) throw new Error("Fidelity audit ended without a result.");
  return { result, targetRevision };
}
