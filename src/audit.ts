import type {
  AuditDisposition,
  AuditFinding,
  AuditState,
  AuditTier,
  AuditVerdict,
} from "./types.js";

/**
 * Machine-readable audit protocol, mirroring the verdict-tag discipline:
 *
 *   auditor finding    AUD-101 (blocking) — invariants.md — INV-003 has no falsifier
 *   designer ruling    DISPOSITION: AUD-101 = fixed — rewrote the oracle
 *   auditor-2 verdict  AUD-101: NOT-FIXED — the oracle still cannot fail
 *
 * The prompts prescribe these formats; the parsers here are the enforcement.
 */

const FINDING_RE =
  /^[#*\->\t ]*(AUD-\d+)[ \t]*\((blocking|significant|minor)\)[ \t]*[-–—:]?[ \t]*(.*)$/gim;

export function parseFindings(reportText: string, iteration: number): AuditFinding[] {
  const seen = new Set<string>();
  const out: AuditFinding[] = [];
  for (const m of reportText.matchAll(FINDING_RE)) {
    const id = (m[1] as string).toUpperCase();
    if (seen.has(id)) continue; // first mention wins; later mentions are prose
    seen.add(id);
    out.push({
      id,
      tier: (m[2] as string).toLowerCase() as AuditTier,
      title: (m[3] ?? "").trim(),
      iteration,
    });
  }
  return out;
}

const DISPOSITION_RE =
  /^[ \t]*DISPOSITION:[ \t]*(AUD-\d+)[ \t]*=[ \t]*(fixed|disputed|deferred)[ \t]*[-–—:]?[ \t]*(.*)$/gim;

export function parseDispositions(text: string): Array<{ id: string } & AuditDisposition> {
  const out: Array<{ id: string } & AuditDisposition> = [];
  for (const m of text.matchAll(DISPOSITION_RE)) {
    out.push({
      id: (m[1] as string).toUpperCase(),
      kind: (m[2] as string).toLowerCase() as AuditDisposition["kind"],
      note: (m[3] ?? "").trim(),
    });
  }
  return out;
}

const VERIFICATION_RE =
  /^[#*\->\t ]*(AUD-\d+)[ \t]*:[ \t]*(VERIFIED|NOT-FIXED|REGRESSION)\b[ \t]*[-–—:]?[ \t]*(.*)$/gim;

export interface VerificationVerdict {
  id: string;
  verdict: "VERIFIED" | "NOT-FIXED" | "REGRESSION";
  note: string;
}

export function parseVerifications(reportText: string): VerificationVerdict[] {
  const out: VerificationVerdict[] = [];
  const seen = new Set<string>();
  for (const m of reportText.matchAll(VERIFICATION_RE)) {
    const id = (m[1] as string).toUpperCase();
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      verdict: (m[2] as string).toUpperCase() as VerificationVerdict["verdict"],
      note: (m[3] ?? "").trim(),
    });
  }
  return out;
}

export interface AuditReportValidation {
  problems: string[];
  findings: AuditFinding[];
  verifications: VerificationVerdict[];
}

/** Choose a non-colliding first-pass range for a completed run's post-hoc audit. */
export function nextPostHocAuditIteration(
  entries: Array<{ role: string; note?: string | undefined }>,
): number {
  const auditorEntries = entries.filter((entry) => entry.role === "auditor");
  const used = new Set<number>();
  for (const entry of auditorEntries) {
    const parsed = entry.note?.match(/\baudit-iteration-(\d+)\b/i);
    if (parsed) used.add(Number(parsed[1]));
  }
  let candidate = used.size > 0
    ? Math.max(...used) + 1
    : auditorEntries.length === 0
      ? 1
      : Math.max(3, auditorEntries.length + 1);
  if (candidate === 2) candidate = 3; // iteration 2 is reserved for in-campaign verification
  while (used.has(candidate)) candidate += 1;
  return candidate;
}

function hasWhatIChecked(reportText: string): boolean {
  const heading = reportText.match(
    /^\s{0,3}(?:#{1,6}\s*)?(?:\*\*)?What I checked(?:\*\*)?\s*:?\s*(.*)$/im,
  );
  if (!heading || heading.index === undefined) return false;
  if ((heading[1] ?? "").trim().length > 0) return true;
  const after = reportText.slice(heading.index + heading[0].length);
  const firstBodyLine = after
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstBodyLine !== undefined && !/^#{1,6}\s/.test(firstBodyLine);
}

/**
 * Validate the parts of an auditor response that drive state transitions.
 * A progress note, empty response, or prose that merely happens not to parse
 * must never be interpreted as a clean audit.
 */
export function validateAuditReport(
  reportText: string,
  iteration: number,
  expectedRoundOneIds: string[] = [],
  opts: { requireBlindSource?: boolean } = {},
): AuditReportValidation {
  const problems: string[] = [];
  const findings = parseFindings(reportText, iteration);
  const verifications = parseVerifications(reportText);
  if (!reportText.trim()) problems.push("report is blank");
  if (!hasWhatIChecked(reportText)) {
    problems.push('missing a non-empty structured "What I checked" section');
  }

  const iterationRange = new RegExp(`^AUD-${iteration}\\d{2}$`);
  const wrongRange = findings.filter((finding) => !iterationRange.test(finding.id));
  if (wrongRange.length > 0) {
    problems.push(
      `finding ids outside iteration ${iteration}'s AUD-${iteration}xx range: ${wrongRange.map((f) => f.id).join(", ")}`,
    );
  }
  const untitled = findings.filter((finding) => !finding.title.trim());
  if (untitled.length > 0) {
    problems.push(`finding headers missing a claim: ${untitled.map((f) => f.id).join(", ")}`);
  }

  if (iteration !== 2) {
    const explicitNoFindings =
      /^\s{0,3}(?:#{1,6}\s*)?(?:\*\*)?No findings\.?(?:\*\*)?\s*$/im.test(reportText);
    if (findings.length === 0 && !explicitNoFindings) {
      problems.push("report has neither parseable findings nor an explicit standalone 'No findings' result");
    }
    if (opts.requireBlindSource) {
      if (!/(?:phase\s*0|blind derivation)/i.test(reportText)) {
        problems.push("target audit does not record the mandatory Phase 0 blind derivation");
      }
      if (!/(?:\.\/)?target-source\//i.test(reportText)) {
        problems.push("target audit does not record any target-source/ evidence");
      }
    }
  }

  if (iteration === 2) {
    if (!/^\s{0,3}(?:#{1,6}\s*)?Disposition verification\s*:?\s*$/im.test(reportText)) {
      problems.push('missing the structured "Disposition verification" section');
    }
    const expected = new Set(expectedRoundOneIds.map((id) => id.toUpperCase()));
    const actual = new Set(verifications.map((verification) => verification.id));
    const missing = [...expected].filter((id) => !actual.has(id));
    const unknown = [...actual].filter((id) => !expected.has(id));
    if (missing.length > 0) problems.push(`missing round-1 verification verdicts: ${missing.join(", ")}`);
    if (unknown.length > 0) problems.push(`verification verdicts for unknown round-1 ids: ${unknown.join(", ")}`);

    const counts = new Map<string, number>();
    for (const match of reportText.matchAll(VERIFICATION_RE)) {
      const id = (match[1] as string).toUpperCase();
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    const duplicates = [...counts].filter(([, count]) => count > 1).map(([id]) => id);
    if (duplicates.length > 0) problems.push(`duplicate verification verdicts: ${duplicates.join(", ")}`);
  }

  return { problems, findings, verifications };
}

/** A finding neither fixed nor explicitly disputed-and-arbitrated is open. */
function isOpen(audit: AuditState, f: AuditFinding): boolean {
  const d = audit.dispositions[f.id];
  return (
    !d ||
    d.kind === "deferred" ||
    d.kind === "reopened" ||
    d.confirmed !== true ||
    (d.kind === "disputed" && d.arbitrated !== true)
  );
}

/**
 * Exit verdict, fail-closed:
 * - any unconfirmed graded disposition, any unarbitrated graded dispute, or
 *   any blocking finding still open (no disposition, deferred, or reopened
 *   by the iteration-2 auditor)
 *   → "reservations";
 * - else any blocking/significant finding disputed, or any significant
 *   finding left open/deferred (escalated to the human via the ratification
 *   package) → "clean-with-disputes";
 * - else "clean". Minor findings never move the verdict.
 */
export function computeVerdict(audit: AuditState): AuditVerdict {
  const graded = audit.findings.filter((f) => f.tier !== "minor");
  if (
    graded.some((f) => {
      const disposition = audit.dispositions[f.id];
      return disposition !== undefined && disposition.kind !== "reopened" && disposition.confirmed !== true;
    })
  ) {
    return "reservations";
  }
  if (
    graded.some((f) => {
      const disposition = audit.dispositions[f.id];
      return disposition?.kind === "disputed" && disposition.arbitrated !== true;
    })
  ) {
    return "reservations";
  }
  if (graded.some((f) => f.tier === "blocking" && isOpen(audit, f))) return "reservations";
  const contested = graded.some(
    (f) => audit.dispositions[f.id]?.kind === "disputed" || isOpen(audit, f),
  );
  return contested ? "clean-with-disputes" : "clean";
}

export function renderDispositionRecord(audit: AuditState): string {
  const rows = audit.findings.map((f) => {
    const d = audit.dispositions[f.id];
    const arbitration = d?.kind === "disputed" ? (d.arbitrated ? "confirmed" : "missing") : "n/a";
    const confirmation = d?.kind === "reopened" ? "verifier-authoritative" : d?.confirmed ? "confirmed" : "missing";
    return `| ${f.id} | ${f.tier} | ${f.title.replace(/\|/g, "\\|")} | ${d?.kind ?? "none"} | ${(d?.note ?? "").replace(/\|/g, "\\|")} | ${confirmation} | ${(d?.confirmationNote ?? "").replace(/\|/g, "\\|")} | ${arbitration} | ${(d?.arbitrationNote ?? "").replace(/\|/g, "\\|")} |`;
  });
  return `# Audit round-1 disposition record

Written by the orchestrator from the designer's \`DISPOSITION:\` lines after
the round-1 feedback window. This file — not the conversation — is what the
round-2 auditor verifies.

| Finding | Tier | Claim | Disposition | Rationale | Stakeholder confirmation | Confirmation evidence | Arbitration | Arbitration evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}
`;
}
