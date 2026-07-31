import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseDispositions, parseFindings } from "./audit.js";
import { readTranscript } from "./transcript.js";
import type { AuditDisposition, AuditFinding, RunState, TranscriptEntry } from "./types.js";

const VERDICT_RE = /^\s*(OBJECTION|GATE-REFUSED|CONFIRMED)\s*:\s*(.*)$/gm;

export interface VerdictCounts {
  objections: number;
  refusals: number;
  confirmations: number;
  lines: Array<{ kind: string; text: string; seq: number }>;
}

export function countVerdicts(entries: TranscriptEntry[]): VerdictCounts {
  const counts: VerdictCounts = { objections: 0, refusals: 0, confirmations: 0, lines: [] };
  for (const e of entries) {
    if (e.role !== "stakeholder") continue;
    for (const m of e.text.matchAll(VERDICT_RE)) {
      const kind = m[1] ?? "";
      const text = (m[2] ?? "").trim();
      if (kind === "OBJECTION") counts.objections++;
      else if (kind === "GATE-REFUSED") counts.refusals++;
      else if (kind === "CONFIRMED") counts.confirmations++;
      counts.lines.push({ kind, text, seq: e.seq });
    }
  }
  return counts;
}

function walkFiles(root: string): Array<{ path: string; bytes: number }> {
  if (!existsSync(root)) return [];
  const out: Array<{ path: string; bytes: number }> = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const name of readdirSync(dir)) {
      if (name === ".git" || name === "node_modules") continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) stack.push(p);
      else out.push({ path: relative(root, p), bytes: st.size });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function phaseTimeline(entries: TranscriptEntry[]): string[] {
  const seen: string[] = [];
  for (const e of entries) {
    if (e.role !== "designer") continue;
    const m = e.text.match(/Phase\s?[-–—]?\s?(\d+)/i);
    if (m) {
      const label = `Phase ${m[1]}`;
      if (seen[seen.length - 1] !== label) seen.push(label);
    }
  }
  return seen;
}

/**
 * The Audit section is derived from the transcript (auditor reports, designer
 * DISPOSITION lines) so post-hoc `vda audit` runs render identically to
 * in-campaign audit loops; the verdict and reopened-finding bookkeeping come
 * from state.audit when the in-campaign loop ran.
 */
function auditSection(state: RunState, entries: TranscriptEntry[]): string {
  const auditEntries = entries.filter((e) => e.role === "auditor");
  if (auditEntries.length === 0) {
    return state.status === "completed"
      ? "No audit recorded — this run predates the audit stage or skipped it. Run `vda audit " +
          state.runId +
          "` for a post-hoc audit."
      : "No audit recorded (campaign did not reach the audit stage).";
  }

  const iterationOf = (e: TranscriptEntry, idx: number): number => {
    const m = e.note?.match(/audit-iteration-(\d+)/);
    return m ? Number(m[1]) : idx + 1;
  };
  const perIteration = auditEntries.map((e, i) => {
    const iteration = iterationOf(e, i);
    return { iteration, seq: e.seq, findings: parseFindings(e.text, iteration) };
  });

  // Prefer the orchestrator's bookkeeping (it applies the iteration-2
  // admissibility rule and records auditor-reopened findings).
  const findings: AuditFinding[] = state.audit?.findings ?? perIteration.flatMap((p) => p.findings);
  const dispositions: Record<string, AuditDisposition> = state.audit
    ? state.audit.dispositions
    : Object.fromEntries(
        entries
          .filter((e) => e.role === "designer")
          .flatMap((e) => parseDispositions(e.text))
          .map((d) => [d.id, { kind: d.kind, note: d.note }]),
      );

  const tierCount = (fs: AuditFinding[], tier: string) => fs.filter((f) => f.tier === tier).length;
  const tierRows = perIteration
    .map((p) => {
      const admitted = state.audit ? findings.filter((f) => f.iteration === p.iteration) : p.findings;
      return `| ${p.iteration} (seq ${p.seq}) | ${tierCount(admitted, "blocking")} | ${tierCount(admitted, "significant")} | ${tierCount(admitted, "minor")} |`;
    })
    .join("\n");

  const ledger =
    findings
      .map((f) => {
        const d = dispositions[f.id];
        return `- \`${f.id}\` (${f.tier}, iter ${f.iteration}) ${f.title} — **${d?.kind ?? "no disposition"}**${d?.note ? `: ${d.note}` : ""}`;
      })
      .join("\n") || "(zero findings reported)";

  const verdict = state.audit?.verdict
    ? `**${state.audit.verdict}**`
    : "(none — post-hoc audit only, no feedback loop)";

  // Anti-rubber-stamp, audit edition: a first pass that finds NOTHING in a
  // 30+-exchange design corpus deserves suspicion, not celebration.
  const first = perIteration.find((p) => p.iteration === 1) ?? perIteration[0];
  const auditSuspect =
    first && first.findings.length === 0 && state.exchanges >= 30
      ? "\n> **⚠ AUDIT-SUSPECT:** the first audit pass reported zero findings on a " +
        state.exchanges +
        "-exchange design. Treat the audit verdict as unverified and consider re-running `vda audit` with a different auditor model.\n"
      : "";

  return `- **Audit verdict:** ${verdict}
- **Iterations run:** ${perIteration.length}
${auditSuspect}
| Iteration | Blocking | Significant | Minor |
| --- | --- | --- | --- |
${tierRows}

### Findings & dispositions

${ledger}`;
}

function sumUsage(entries: TranscriptEntry[], role: "designer" | "stakeholder") {
  let input = 0;
  let output = 0;
  let cost = 0;
  for (const e of entries) {
    if (e.role !== role || !e.usage) continue;
    input += e.usage.inputTokens ?? 0;
    output += e.usage.outputTokens ?? 0;
    cost += e.usage.costUsd ?? 0;
  }
  return { input, output, cost };
}

export function generateReport(runDir: string): string {
  const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) as RunState;
  const entries = readTranscript(runDir);
  const verdicts = countVerdicts(entries);
  const artifacts = walkFiles(join(state.workspace, "validation-design"));
  const phases = phaseTimeline(entries);
  const designerUse = sumUsage(entries, "designer");
  const stakeholderUse = sumUsage(entries, "stakeholder");
  const warnings = entries.filter((e) => e.role === "orchestrator" && e.note).map((e) => e.note as string);
  const readerReports = entries.filter((e) => e.role.startsWith("reader:"));
  const mode = state.rambleMtimeMs !== undefined || existsSync(join(state.workspace, "rambling.txt"))
    ? "human-amplified (rambling.txt present)"
    : "pure-simulation (no rambling.txt — declared, not silent)";

  const rubberStampWarning =
    verdicts.objections + verdicts.refusals === 0
      ? "\n> **⚠ RUBBER-STAMP SUSPECT:** the stakeholder confirmed every gate without a single OBJECTION or GATE-REFUSED. Treat every confirmation in this run as unverified.\n"
      : "";

  const md = `# Campaign report — ${state.fixture} (${state.runId})

- **Status:** ${state.status}${state.statusReason ? ` — ${state.statusReason}` : ""}
- **Mode:** ${mode}
- **Started:** ${state.startedAt} · **Last update:** ${state.updatedAt}
- **Exchanges (stakeholder turns):** ${state.exchanges} / ${state.config.maxExchanges}
- **Models:** designer ${state.config.designerModel} · stakeholder ${state.config.stakeholderModel} · readers ${state.config.readerModel}
- **Phase mentions observed:** ${phases.join(" → ") || "(none parsed)"}

## Gate discipline
${rubberStampWarning}
| Verdict | Count |
| --- | --- |
| OBJECTION | ${verdicts.objections} |
| GATE-REFUSED | ${verdicts.refusals} |
| CONFIRMED | ${verdicts.confirmations} |

${verdicts.lines.map((l) => `- \`${l.kind}\` (seq ${l.seq}): ${l.text}`).join("\n") || "(no structured verdicts found)"}

## Reader test

${readerReports.length > 0 ? `${readerReports.length} reader report(s) captured (see transcript seq ${readerReports.map((r) => r.seq).join(", ")}).` : "Reader test never ran — if the run completed, that is a protocol violation."}

## Audit

${auditSection(state, entries)}

## Usage

| Side | Input tokens | Output tokens | Cost (USD, if metered) |
| --- | --- | --- | --- |
| Designer | ${designerUse.input} | ${designerUse.output} | ${designerUse.cost.toFixed(2)} |
| Stakeholder | ${stakeholderUse.input} | ${stakeholderUse.output} | ${stakeholderUse.cost.toFixed(2)} |

## Artifacts (workspace/validation-design/)

${artifacts.length > 0 ? artifacts.map((a) => `- \`${a.path}\` (${a.bytes} B)`).join("\n") : "(none — campaign produced no artifacts)"}

## Orchestrator notes

${warnings.map((w) => `- ${w}`).join("\n") || "(none)"}

## Ratification

This design is a **draft until a human ratifies it**. Start from
\`workspace/validation-design/ratification-package.md\`${artifacts.some((a) => a.path === "ratification-package.md") ? "" : " (⚠ missing — the designer did not write it)"}, then spot-review by risk tier.
`;
  writeFileSync(join(runDir, "report.md"), md);
  return md;
}
