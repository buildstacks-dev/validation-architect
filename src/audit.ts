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

/** A finding neither fixed nor explicitly disputed-and-arbitrated is open. */
function isOpen(audit: AuditState, f: AuditFinding): boolean {
  const d = audit.dispositions[f.id];
  return !d || d.kind === "deferred" || d.kind === "reopened";
}

/**
 * Exit verdict, fail-closed:
 * - any blocking finding still open (no disposition, deferred, or reopened
 *   by the iteration-2 auditor) → "reservations";
 * - else any blocking/significant finding disputed, or any significant
 *   finding left open/deferred (escalated to the human via the ratification
 *   package) → "clean-with-disputes";
 * - else "clean". Minor findings never move the verdict.
 */
export function computeVerdict(audit: AuditState): AuditVerdict {
  const graded = audit.findings.filter((f) => f.tier !== "minor");
  if (graded.some((f) => f.tier === "blocking" && isOpen(audit, f))) return "reservations";
  const contested = graded.some(
    (f) => audit.dispositions[f.id]?.kind === "disputed" || isOpen(audit, f),
  );
  return contested ? "clean-with-disputes" : "clean";
}

export function renderDispositionRecord(audit: AuditState): string {
  const rows = audit.findings.map((f) => {
    const d = audit.dispositions[f.id];
    return `| ${f.id} | ${f.tier} | ${f.title.replace(/\|/g, "\\|")} | ${d?.kind ?? "none"} | ${(d?.note ?? "").replace(/\|/g, "\\|")} |`;
  });
  return `# Audit round-1 disposition record

Written by the orchestrator from the designer's \`DISPOSITION:\` lines after
the round-1 feedback window. This file — not the conversation — is what the
round-2 auditor verifies.

| Finding | Tier | Claim | Disposition | Rationale |
| --- | --- | --- | --- | --- |
${rows.join("\n")}
`;
}
