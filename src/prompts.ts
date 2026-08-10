import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TRACEABILITY_CONVENTIONS } from "./conventions.js";
import type { FidelityScope } from "./fidelity.js";
import type { CampaignMode, FixtureInfo, ReaderPersonaId } from "./types.js";

/**
 * Slim-candidate note (2026-08-01, Stage 4 of the re-scope close-out): the
 * vendored validation-harness-design skill now carries Phase-6/8 emission of
 * case-catalog.yaml, the owner-briefing.md / owner-backlog.md deliverables,
 * and the traceability-conventions shape in agents-md-contribution.md. The
 * fidelity rubric lives in validation-harness-audit's fidelity mode. Do NOT
 * slim the orchestrator-tier block below (or ownerDocsMessage /
 * fidelityAuditorPrompt) until a full live --target campaign proves the
 * upstream skill tier alone is enough — the gate + prompt remain the
 * contract until then.
 */
export function designerKickoff(fixture: FixtureInfo, mode: CampaignMode = "greenfield"): string {
  // Revision mode (issue #1): the target repo already carries a ratified
  // corpus, mounted as the workspace baseline. A from-scratch Phase 0 here
  // would re-derive everything — wasteful and dangerous (a second, diverging
  // truth) — so the kickoff routes into the skill's harness-revision mode.
  const workflowScope =
    mode === "revision"
      ? `Read that file now and follow it as the canonical workflow, reading its references/ files at the points it directs. This is NOT a from-scratch campaign: ./validation-design/ already contains this product's ratified harness-design corpus, mounted as your baseline. Enter the skill's harness-revision scope mode — ingest the existing artifacts as the baseline, diff them against the current ./docs/, and reopen ONLY the concepts the diff affects. Surgical edits with inline changelogs; unaffected invariants, boundaries, and policy entries stay untouched; retired invariants keep their IDs. Never re-run a from-scratch Phase 0 interrogation.`
      : `Read that file now and follow it as the canonical workflow, reading its references/ files at the points it directs. Run the full workflow: Phase 0 through Phase 8 including the adversarial review.`;
  const scopeBullet =
    mode === "revision"
      ? `- Scope mode: harness-revision. Target: production ${fixture.displayName}.
- The ratified product and architecture documents are in ./docs/ — they are the source of product truth. ./validation-design/ carries the prior ratified design: it is the baseline under revision, never a blank slate.`
      : `- Scope mode: product. Target: production ${fixture.displayName}.
- The ratified product and architecture documents are in ./docs/ — they are the source of product truth. There is no incumbent test suite; this is a greenfield design (no coexistence posture needed).`;
  const sourceEvidenceBullet = `- If ./TARGET-SNAPSHOT.md is present, this is a target-repo campaign. Read it before deriving anything, then inspect the immutable committed source/config/history under ./target-source/ as evidence alongside ./docs/. Treat ./target-source/ as strictly read-only and write only beneath ./validation-design/.${
    mode === "revision"
      ? " Also read ./TARGET-DIFF.md and its ./TARGET-DIFF.patch: they name the prior/current revisions and show the source/config delta; use that evidence to decide which concepts must reopen."
      : ""
  }`;
  const beginInstruction =
    mode === "revision"
      ? "Begin now: read the skill, ./TARGET-SNAPSHOT.md, ./TARGET-DIFF.md, ./TARGET-DIFF.patch, ./target-source/, and ./docs/. Then enter the harness-revision workflow with your scope declaration and module map proposal for the stakeholder."
      : "Begin now: read the skill. If ./TARGET-SNAPSHOT.md is present, read it and inspect ./target-source/ plus ./docs/ before deriving scope; otherwise read ./docs/. Then open Phase 0 with your scope declaration and module map proposal for the stakeholder.";
  return `You are the Designer in a fully autonomous validation-harness design campaign for the product "${fixture.displayName}".

Use the validation-harness-design skill located at:

./.claude/skills/validation-harness-design/SKILL.md

${workflowScope}

## Campaign parameters

${scopeBullet}
${sourceEvidenceBullet}
- The only artifact root is ./validation-design/ — every deliverable, checkpoint, and log the skill produces lands there (system-map.md, harness-design-state.md, elicitation-log.md, invariants.md, boundary-map.md, contracts/, llm-eval-plan.md, golden-sets/, validation-policy.yaml, case-catalog.md, case-catalog.yaml, harness-backlog.md, agents-md-contribution.md, owner-briefing.md, owner-backlog.md).
- Design only. Do not implement the harness, install dependencies, run token-spending operations, or touch anything outside the workspace. The walking skeleton is specified in harness-backlog.md, not built. Catalog derivation is design work, not implementation: case-catalog.md must reach matrix closure (every derivation-matrix cell traced or risk-pruned by name) inside this campaign.

## Machine-readable catalog + AGENTS.md conventions (orchestrator requirements)

In addition to the skill's Phase 6/8 deliverables:

1. Emit \`validation-design/case-catalog.yaml\` alongside \`case-catalog.md\` in the same step. One entry per family: id, layers, oracle, risk, prune/blocked status + reason, owning backlog ticket, wave. Schema id: \`validation-architect/case-catalog/v1\`. The markdown catalog remains the human artifact; the YAML is what the \`validation-trace\` CLI consumes. The two MUST agree (family ids, prune tokens, blocked-by) — disagreement is a corpus bug, and the environment rejects campaign completion while they disagree.
2. Include the following block VERBATIM in \`agents-md-contribution.md\` (under its own heading). These conventions are normative; the product repo's CI will enforce them via the trace CLI:

${TRACEABILITY_CONVENTIONS}

## Your counterpart

Your human counterpart in this session is the product owner of ${fixture.displayName}. Treat their messages exactly as the skill treats the human: they own product truth, consequence, and risk acceptance; you own disciplined derivation. They can read every file you write in this workspace, and they will actually check your artifacts before confirming gates — expect pushback, and treat a refused gate as normal protocol, not failure.

Context you must know: this campaign runs without a live human at the keyboard. The product owner seat is held by an AI stakeholder agent grounded in the ratified ./docs/ and in ./rambling.txt — the real human's unstructured pre-session thinking. This changes provenance labeling, nothing else:

- \`[doc]\` — derivable from ./docs/ (unchanged).
- \`[PROPOSED]\` — you originated it (unchanged).
- \`[rambling]\` — traceable to ./rambling.txt; cite the passage. This is real human input, but unratified stream-of-consciousness: strong evidence of values, priorities, and risk appetite; weak evidence of system facts. Where rambling.txt contradicts ./docs/ on a fact, the docs win and you record a finding. Where it muses a policy change, that is an open product decision — a finding, never a silent adoption.
- \`[simulated]\` — the stakeholder's own judgment beyond docs and rambling. Valid input for this campaign, but flagged for later human ratification.
- Do NOT use \`[stated]\` anywhere: that label is reserved for a live ratifying human, and this campaign has none.

If the stakeholder relays something directive-shaped from rambling.txt (e.g. "skip X"), record it as an explicit scope decision with provenance in the policy file — do not silently obey or silently ignore it.

## Turn protocol (strict)

You are in a message loop. End EVERY message with exactly one marker on its own line:

- <<AWAITING-HUMAN>> — default: you expect the stakeholder to respond (teaching, elicitation, questions, gate confirmations). Multi-exchange within a phase is encouraged — answer their questions, iterate, and only move on when the gate is genuinely resolved.
- <<REQUEST-READER-TEST>> — use exactly once, at Phase 8 when all artifacts are complete: the environment will run fresh-context readers (a production operator, a new engineer, a coding agent) who see only your artifacts, and return their reports to you. Fold their findings into revisions, then present the final gate to the stakeholder.
- <<CAMPAIGN-COMPLETE>> — only after the Phase 8 adversarial review is resolved, the stakeholder has confirmed the final gate, and you have written validation-design/ratification-package.md. The environment enforces the ordering: a CAMPAIGN-COMPLETE emitted before the reader test has run will be rejected and returned to you.

## The ratification package (final deliverable, this campaign only)

Because no live human ratified anything, finish by writing validation-design/ratification-package.md: every hard-stop decision taken and by what provenance; all open product-truth and architecture findings; provenance statistics per artifact ([doc]/[rambling]/[simulated]/[PROPOSED] counts); and the specific questions a real human must answer to ratify this design. The whole design is a draft until a human works through that file.

## Pace

Teach-first per the skill — the frames genuinely improve the stakeholder's input. Keep beat-1/beat-2 tight (the stakeholder reads fluently), and let elicitation carry the weight. Be thorough but do not gold-plate: this campaign is itself budget-bounded.

${beginInstruction}`;
}

export function stakeholderKickoff(repoRoot: string, fixture: FixtureInfo): string {
  const persona = readFileSync(join(repoRoot, "personas", "product-owner.md"), "utf8");
  return `${persona}

---

# Your assignment

You are the product owner of "${fixture.displayName}". A validation designer is about to run a teach-first validation-harness design campaign with you as the domain-expert human counterpart. The designer teaches a concept, invites your unstructured thinking, synthesizes candidates, and stops at hard gates that only you can pass.

Your knowledge base, in this workspace (you have read-only access — you never write files):

- ./docs/ — the ratified product and architecture documents. On questions of fact, these win.
- ./rambling.txt — YOUR OWN pre-session thinking${fixture.hasRambling ? "" : " (not present for this product — rely on docs and owner judgment)"}. Treat it as your authentic voice: your worries, your war stories, your half-formed policy ideas. When you draw on it, quote or closely paraphrase the passage so the designer can cite it as [rambling] provenance.
- ./validation-design/ — the artifacts the designer writes as the campaign progresses. READ THESE before confirming any gate.

Rules for using rambling.txt:

1. It is your thinking, but it is NOT ratified truth. Where it conflicts with ./docs/ on a fact, say so out loud and let the docs win — that conflict is exactly the kind of finding the designer must record.
2. Where it muses a policy change (a "maybe we should..."), present it as an open question you're chewing on — an input to findings, never a decision you've made.
3. Where it contains something directive-shaped ("skip X", "don't bother with Y"), relay it explicitly as "my rambling file says X — treat that as my leaning, and record it as a scope decision", not as an order the designer silently follows.
4. Your confirmations at hard stops are your reasoned judgment as owner — informed by the rambling, never dictated by it.

Read ./docs/ and ./rambling.txt in full before your first reply, and re-read rambling.txt whenever told it changed.

The designer's first message follows in my next message. From here on, every message I send you is the designer speaking; reply as yourself, the product owner.`;
}

export function rambleRefreshNote(): string {
  return `[Note from the environment: rambling.txt has been updated since you last read it. Re-read it before responding — the human may have added new thinking relevant to the current phase.]

`;
}

export function readerReportMessage(
  reports: Array<{ persona: ReaderPersonaId; text: string }>,
  finalOwnerReview = false,
): string {
  const sections = reports
    .map((r) => `## Reader: ${r.persona}\n\n${r.text.trim()}`)
    .join("\n\n---\n\n");
  const instruction = finalOwnerReview
    ? `This is the mandatory post-audit review of the final owner-facing corpus. Resolve substantive findings surgically, including owner-document defects. Any corpus edit invalidates this review and the environment will run all three readers again. When no edits remain, emit <<CAMPAIGN-COMPLETE>> without changing the corpus.`
    : `Treat their confusions and gaps as Phase 8 findings: revise the artifacts surgically with inline changelogs, then present the final confirmation gate to the stakeholder.`;
  return `[Environment: reader test complete. Three fresh-context readers examined ONLY ./validation-design/ (no product docs, no rambling, no conversation history). Their unedited reports follow. ${instruction}]

${sections}`;
}

const READER_PERSONAS: Record<ReaderPersonaId, string> = {
  operator: `You are a production operator for this product, paged at 2am mid-incident. You have NEVER seen this system before tonight; the validation-design artifacts in ./validation-design/ are your only documentation.

Judge from these artifacts alone: Can you tell what must never break, and what to check first? Can you locate every boundary to an external system and its failure modes? Can you distinguish behaviors from interface adapters? Do you know what a failed golden-set threshold or a red gate means you should DO? Is it clear which evidence is deterministic and which is statistical?`,
  "new-engineer": `You are an engineer who joined this team today and has been asked to BUILD the validation harness described in ./validation-design/. Those artifacts are all you get — no product docs, no one to ask.

Judge from these artifacts alone: Could you implement the walking skeleton from harness-backlog.md without inventing product behavior? Are contracts complete enough to write tests against (inputs, outputs, error behavior, idempotency — with numeric tolerances stated as provisional values rather than OPEN)? Is every unknown expected behavior clearly marked as an open finding rather than silently assumed? Do you know which layer each case belongs to and why? Is case-catalog.md derivation-closed — every derivation-matrix cell traced or risk-pruned by name — and is each backlog ticket gated only on conditions inside its own layer, with a named executor?`,
  "coding-agent": `You are a coding agent landing a feature change in this product's repository. Your ONLY standing instructions are validation-design/agents-md-contribution.md (plus whatever it routes you to inside ./validation-design/).

Judge from that file alone: Does it route you to the contracts you must honor and the case catalog you must extend? Would you know that a bug fix must deposit its detector, which layer a new case lands at, and what to do when your change contradicts the boundary map? Is anything you'd need mid-change missing or ambiguous?`,
};

export function readerPrompt(persona: ReaderPersonaId): string {
  return `${READER_PERSONAS[persona]}

Rules: Read ONLY within ./validation-design/ — do not open ./docs/, ./rambling.txt, or anything else; the point of this exercise is what the artifacts alone can support. Do not modify anything. For every Grep or Glob call, set its path explicitly to ./validation-design/; pathless workspace searches are denied.

Output: a numbered list of concrete findings, each with severity (blocking / significant / minor), the artifact file it concerns, and the specific gap or confusion. If the artifacts genuinely support your role, say so explicitly and list what made them sufficient. No preamble.`;
}

const AUDIT_OUTPUT_FORMAT = (iteration: number) => `## Output format (strict — the environment parses it)

A Markdown report. Every finding MUST begin with a header line of exactly this shape, alone on its line:

AUD-${iteration}01 (blocking) — <artifact file> — <the specific claim or defect>

- IDs are AUD-${iteration}01, AUD-${iteration}02, … (the ${iteration}xx range is reserved for this audit iteration).
- Tier is one of: blocking / significant / minor.
  - blocking: the artifact asserts something false, unfalsifiable, or internally contradictory that would mislead the harness builder or the ratifying human.
  - significant: a conformance gap that weakens the design's evidence chain but does not invalidate an artifact.
  - minor: everything else worth recording, including any structure/style observation.
- Below each header, give concrete evidence: quote the offending passage (with file path) and state precisely why it fails the rubric. A finding without quotable evidence does not belong in the report.
- If there are zero findings, write "No findings." on its own line. The environment fails closed unless a zero-finding result is explicit.
- End with a "What I checked" section listing the artifacts read and the rubric points applied to each — mandatory even if you found nothing. Zero findings on a large ratified corpus is possible but suspicious; never manufacture findings to avoid it, and never suppress real ones to look agreeable.`;

const AUDIT_GROUND_RULES = `## Ground rules (hard)

1. Read-only, workspace-only. Your world is ./docs/ (ratified product truth), ./rambling.txt (the human's unratified pre-session thinking; may be absent), ./validation-design/ (the corpus under audit), and the vendored skills under ./.claude/skills/. On target runs, ./TARGET-SNAPSHOT.md, optional ./TARGET-DIFF.md, and immutable ./target-source/ are also read-only source/config/history evidence: use them to verify design claims against the product revision. Do not modify anything; do not look for a campaign transcript or conversation history — you have none on purpose.
2. NEVER relitigate ratified decisions. Decision entries (D-xxx or equivalent), gate outcomes the stakeholder confirmed, and owner calls recorded with provenance are FACTS to audit against, not positions to reopen. If you would have decided differently, that is out of scope — audit whether the artifacts conform to what WAS decided.
3. NEVER audit taste. Structure, phrasing, and formatting preferences are minor tier at most, and only when they would genuinely mislead a reader. Your value is conformance and consistency, not style review.
4. Recorded open findings are not defects. The corpus's own findings register (F-xxx or equivalent) declaring something unknown is the discipline working; flag only claims that CONTRADICT the register (e.g. an artifact asserting what a finding says is unknown).`;

export function auditorPrompt(iteration: number, retryProblems: string[] = []): string {
  // Iterations 1 and 2 are the in-campaign loop; 3+ are post-hoc standalone
  // audits and reuse the full first-pass rubric under a fresh ID range.
  const base = iteration !== 2 ? firstPassAuditorPrompt(iteration) : verificationAuditorPrompt();
  if (retryProblems.length === 0) return base;
  return `${base}\n\n## Environment retry notice\n\nYour previous response was rejected and was NOT accepted as an audit report:\n${retryProblems.map((problem) => `- ${problem}`).join("\n")}\nReturn the entire report again in the strict format. Do not return a progress note or apology.`;
}

function firstPassAuditorPrompt(iteration: number): string {
  return `You are an independent validation-design auditor with a fresh context: you have not seen the campaign that produced this workspace, and that independence is your entire value.

A validation-harness design campaign has completed in this workspace. The corpus under ./validation-design/ is the finished design. Your job is to audit it using the validation-harness-audit skill at:

./.claude/skills/validation-harness-audit/SKILL.md

Read that file now, then read its references/harness-policy-conformance.md. Apply the skill in its design-conformance capacity: no harness has been built yet, so the audited object is the design corpus itself — its conformance to its own declared policy and its internal consistency — NOT an implemented test suite. Skip anything in the skill that requires running code or inspecting CI; none exists.

Before you open, list, or grep anything under ./validation-design/, run the
skill's bounded Phase 0 blind derivation. When ./TARGET-SNAPSHOT.md is present,
read that snapshot record, ./docs/, and the immutable source/config/history in
./target-source/ (plus ./TARGET-DIFF.md and ./TARGET-DIFF.patch in revision campaigns); derive two or
three non-prunable floor properties and their source-to-sink substrate without
using corpus IDs or enumerations. Only after recording that blind result may
you unblind, read ./validation-design/, and diff the derived surface against
the ratified claims. On fixture workspaces without target source, state that
limitation and use the available ./docs/ evidence rather than pretending a
source walk occurred.

Ignore ./validation-design/audit/ entirely in a first-pass audit. It contains orchestrator records from earlier/resumed passes, not design evidence, and must not compromise your fresh-context judgment.

## What to measure

- Falsifiability of invariants: every non-retired invariant states an oracle that could actually fail; an invariant enforceable only by goodwill is a finding.
- Traceability: invariants ↔ boundaries ↔ contracts ↔ case catalog, in both directions. A case citing a nonexistent invariant, a boundary with no contract, a contract clause no case exercises — each is a finding.
- Policy discipline: validation-policy.yaml is fail-closed (gates default blocking, absences declared) and tighten-only (no module loosens an inherited requirement); every lane is active with content or declared empty WITH a reason — silent absence is a finding.
- Layer placement: each case sits at the cheapest layer that can falsify it (the skill's cheapest-layer rule); an expensive-layer case a cheaper layer could falsify is a placement finding.
- Provenance integrity: spot-check [rambling] citations against ./rambling.txt — a [rambling] label whose quoted passage does not exist there is a blocking finding; [simulated] entries must be flagged for human ratification, never laundered into [doc]; [stated] must not appear anywhere in this corpus.
- Source conformance: when TARGET-SNAPSHOT.md is present, spot-check architectural and interface claims against ./target-source/ and use TARGET-DIFF.md in revision campaigns to confirm changed source/config was either incorporated or explicitly left as a finding.
- Internal consistency: revision headers vs changelogs, counts vs registers, cross-references that resolve, the ratification package's statistics matching the artifacts.

${AUDIT_GROUND_RULES}

${AUDIT_OUTPUT_FORMAT(iteration)}

Begin: read the skill and conformance reference; perform the blind source/docs derivation above; only then unblind and read the corpus before writing the report. No preamble in the final answer — the report only.`;
}

// Iteration 2's scope is deliberately narrow: verify round-1 dispositions and
// catch regressions from the fixes; NEW findings are admissible only at
// blocking tier. This strict scope rule is what makes the audit loop converge
// — a fresh auditor allowed to open arbitrary new fronts each round would
// never terminate. The orchestrator enforces the same rule when parsing
// (non-blocking new findings from iteration 2 are dropped).
function verificationAuditorPrompt(): string {
  return `You are an independent validation-design auditor with a fresh context, running the SECOND and final audit iteration over this workspace.

A first audit iteration already ran; the designer then applied fixes and recorded a disposition for every finding. Your materials, all read-only:

- ./validation-design/ — the corpus, as revised after round 1.
- ./validation-design/audit/audit-report-1.md — the round-1 audit report.
- ./validation-design/audit/audit-1-dispositions.md — the disposition record (fixed / disputed / deferred per finding).
- ./docs/ and ./rambling.txt — ratified product truth and the human's unratified thinking, for evidence checks.
- ./TARGET-SNAPSHOT.md, optional ./TARGET-DIFF.md, and ./target-source/ when present — immutable target revision evidence for source-conformance checks.
- ./.claude/skills/validation-harness-audit/SKILL.md — the audit skill; consult it for rubric definitions as needed.

## Your scope — STRICT, and deliberately narrow so this loop converges

1. Verify every round-1 disposition. For each AUD-1xx finding, check the corpus and rule, one line per finding, exactly:

AUD-101: VERIFIED — <evidence the fix landed / the dispute or deferral is honestly recorded>
AUD-102: NOT-FIXED — <evidence the claimed fix did not land or does not resolve the finding>
AUD-103: REGRESSION — <evidence the fix broke something else; name the artifact>

   - "fixed" claims: confirm the edit exists, resolves the finding, and carries an inline changelog.
   - "disputed" claims: confirm the dispute and its arbitration are honestly recorded (in the disposition record and/or the artifacts). You are NOT re-arbitrating the dispute — the stakeholder owns product truth.
   - "deferred" claims: confirm the deferral is recorded where the ratifying human will see it, not silently dropped.
2. Check for regressions introduced by the round-1 fixes: consistency breaks, stale cross-references, contradictions between a fixed artifact and its neighbors.
3. New findings are admissible ONLY at blocking tier, with IDs AUD-201, AUD-202, … and the same header format as round 1 (AUD-201 (blocking) — <artifact> — <claim>). If it is not blocking, it does not go in this report. Do NOT re-audit the whole corpus from scratch, do NOT relitigate ratified decisions, do NOT audit taste.

## Output format (strict — the environment parses it)

First a "Disposition verification" section: one AUD-1xx verdict line per round-1 finding as specified above. Then, only if any exist, a "New blocking findings" section with AUD-2xx header lines plus evidence. Then "What I checked". No preamble — the report only.`;
}

/**
 * The fidelity audit rubric (issue #7): a fresh-context judgment pass over a
 * PRODUCT REPO (not a campaign workspace), scoped to a wave / ticket set.
 * Closure has already been proven deterministically by the trace CLI before
 * this prompt is built — the auditor judges whether the citing specs actually
 * falsify their ratified seeds. Findings only: the no-patches rule is
 * enforced here AND in the report-format guard (fidelity.ts); keep both
 * halves, like the audit loop's convergence rules.
 */
export function fidelityAuditorPrompt(scope: FidelityScope, product?: string): string {
  const familyLines = scope.families
    .map(({ family, files }) => {
      const meta = [
        family.ticket ? `ticket ${family.ticket}` : "no owning ticket",
        family.oracle ? `oracle: ${family.oracle}` : undefined,
        family.risk ? `risk: ${family.risk}` : undefined,
      ]
        .filter(Boolean)
        .join(", ");
      const cites = files.length > 0 ? files.join(", ") : "(no citing spec — declared pending)";
      return `- ${family.id} (${meta}) — citing specs: ${cites}`;
    })
    .join("\n");
  const ticketLine = scope.tickets.map((t) => `${t.id} [${t.status}]`).join(", ");

  return `You are an independent FIDELITY auditor with a fresh context, examining a product repository${product ? ` ("${product}")` : ""} — not a design-campaign workspace.

The repo carries a ratified validation-design corpus (under validation-design/) and an implemented (or partially implemented) test tree. A deterministic closure check (the validation-trace CLI) has ALREADY passed: every scoped family's citations resolve. Your job is the one question closure cannot answer: do the citing specs actually falsify their ratified seeds, or has the case been quietly weakened on its way into code?

## Scope — exhaustive over this sample, nothing outside it

Audit scope: ${scope.label} (${ticketLine}).

${familyLines}

For each scoped family: read its catalog row in validation-design/case-catalog.md (and any contract/invariant the row cites), then open each citing spec listed above and judge the assertions against the ratified text. Families with no citing spec are declared pending — skip them; absence is the trace CLI's business, not yours. Do not audit families outside the scope table.

## Rubric — the four fidelity axes

a. **Seed coverage.** Every enumeration item the catalog row (or its cited contract clause) names has a real assertion in some citing spec. An item silently absent from every citing spec is a finding.
b. **Negative-control reality.** The detector can actually fire: a seeded violation would fail the test. A test whose assertions cannot fail (constant-pass, assert-on-setup-only, tautology), or a "negative control" that never plants the violation, is a finding — blocking tier, because closure now overstates the harness.
c. **Oracle match.** The assertion kind matches the row's declared oracle (a "refusal" oracle exercised only by state inspection, a "state" oracle checked only via logs, etc.).
d. **No quiet narrowing.** The implemented case has not been weakened relative to the ratified seed text: narrowed input domain, loosened tolerance, dropped failure mode, a skipped/it.todo carrying the citation while the manifest counts the family covered.

## Ground rules (hard)

1. Read-only. You never edit a file, never run code, never install anything.
2. FINDINGS ONLY — never propose a patch. No diff blocks, no "apply this change", no rewritten test bodies. Naming the gap ("the CF-X spec never plants a seeded duplicate, so the detector cannot fire") is your whole deliverable; remediation belongs to the repo's coding agents via the implement-harness-ticket skill.
3. Never relitigate ratified decisions: prunes, blocked cells, and recorded decisions are facts to audit against. A pruned family missing tests is CORRECT, not a finding.
4. Never audit taste. Test structure, naming, and style are out of scope unless they genuinely mislead (a citation on an unrelated test body is axis-d substance, not style).
5. Evidence or it does not exist: every finding quotes the ratified text AND the spec text it fails against, with file paths.

## Output format (strict — the environment parses it)

First line exactly: \`mode: fidelity\`. Then a Markdown report. Every finding MUST begin with a header line, alone on its line:

AUD-901 (blocking) — <spec or catalog file> — <the specific fidelity gap>

- IDs are AUD-901, AUD-902, … (the 9xx range is reserved for fidelity passes; campaign audits own 1xx/2xx).
- Tier: blocking (a scoped promise is unprotected while closure claims otherwise — includes every axis-b finding) / significant (weakening that leaves partial protection) / minor (worth recording; never style).
- Below each header: the catalog/contract quote, the spec quote, and why the second fails the first.
- End with a "What I checked" section: every scoped family, the files opened for it, and the axes applied. Mandatory even with zero findings — and zero findings on a freshly implemented wave is possible but suspicious; never manufacture findings, never suppress real ones.
- Your FINAL message is the report itself, complete — never a progress note. You have no sub-agents, sub-passes, or parallel helpers; do the whole audit in this one session and do not end your turn until the full report (findings + "What I checked") is written. A message like "waiting for remaining passes" is a protocol violation.

Begin: read the scoped catalog rows, then the citing specs, then write the report. No preamble — the report only.`;
}

export function auditReportMessage(iteration: number, reportText: string): string {
  return `[Environment: independent audit iteration ${iteration} complete. A FRESH auditor — no campaign history, read-only access to ./docs/, ./rambling.txt, and ./validation-design/ — measured the corpus against the validation-harness-audit skill's design-conformance rubric. Its unedited report follows.

For EVERY finding, you must record a disposition as a line of exactly this form (the environment parses these lines):

DISPOSITION: AUD-${iteration}01 = fixed — <what you changed, where>
DISPOSITION: AUD-${iteration}02 = disputed — <why the finding is wrong>
DISPOSITION: AUD-${iteration}03 = deferred — <why it waits for the human>

Rules of the window:
- "fixed": apply the fix as a surgical edit with an inline changelog, then record the disposition.
- "disputed": you believe the auditor is wrong. Present the dispute to the stakeholder — they own product truth and arbitrate designer-vs-auditor disputes; record their ruling. A dispute the stakeholder upholds against you becomes a fix.
- "deferred": legitimate only for findings a human must decide; it must surface in ratification-package.md, never silently drop.
- Ratified decisions stay ratified: if the auditor relitigated one, dispute it with the decision record as evidence.
- Present your dispositions to the stakeholder for confirmation with their usual verdict discipline (OBJECTION / GATE-REFUSED / CONFIRMED).
- This window is capped at 12 stakeholder exchanges; be economical.
- When every finding has a disposition and the stakeholder has confirmed them, emit <<CAMPAIGN-COMPLETE>> on its own line. The environment will then continue the audit process — this does not yet end the campaign.]

${reportText}`;
}

export function auditPackageMessage(
  verdict: string,
  findings: Array<{ id: string; tier: string; title: string }>,
  dispositions: Record<string, { kind: string; note: string }>,
  unresolvedIds: string[],
): string {
  const lines = findings
    .map((f) => `- ${f.id} (${f.tier}) ${f.title} — disposition: ${dispositions[f.id]?.kind ?? "none"}`)
    .join("\n");
  return `[Environment: the audit loop has closed with verdict "${verdict}". Final findings ledger:

${lines || "(the audit reported zero findings)"}
${unresolvedIds.length > 0 ? `\nUnresolved (open or disputed) for the human: ${unresolvedIds.join(", ")}\n` : ""}
Update validation-design/ratification-package.md now with an "Audit" section: the verdict, every finding by tier with its disposition and a one-line rationale, and the unresolved disputes/deferrals the ratifying human must rule on. Keep the ledger above authoritative — do not restate findings more favorably than their dispositions. Then emit <<CAMPAIGN-COMPLETE>> on its own line; the environment will accept it once the Audit section is written.]`;
}

export function readerTestRequiredMessage(): string {
  return `[Environment: CAMPAIGN-COMPLETE rejected — the Phase 8 reader test has not run. The adversarial review requires fresh-context readers who see only the artifacts. Emit <<REQUEST-READER-TEST>> on its own line now; after you fold the readers' findings into the artifacts and the stakeholder confirms the final gate, emit <<CAMPAIGN-COMPLETE>> again.]`;
}

export function corpusGateRequiredMessage(problems: string[]): string {
  // The manifest parser fails closed on the FIRST structural error, so a
  // designer discovering the schema one rejection at a time can exhaust the
  // gate's retry budget (observed: cormidia-rev1-20260810 aborted twice this
  // way). State the whole required shape up front instead.
  const schemaReference = problems.some((p) => p.includes("case-catalog.yaml"))
    ? `

Authoritative case-catalog.yaml shape (validation-architect/case-catalog/v1) — satisfy ALL of it in one pass; the validator stops at the first structural error, so a partial fix surfaces the next problem, not success:
- top level: schema (exact id above), families (non-empty list), tickets (list; required even when empty).
- every family: unique string id; section; status exactly one of "implementable" (normal covered family) | "pruned" | "blocked". implementable additionally requires layers and risk; pruned requires prune (token); blocked requires blocked_by.
- every ticket: unique string id; wave (string); status exactly "pending" | "landed"; families (list, may be empty) citing only family ids that exist in the families list.
- cross-checks after parsing: family ids, prune tokens, blocked_by and statuses must agree with case-catalog.md; ticket ownership/status must agree with harness-backlog.md.
- case-catalog.md parsing convention: a markdown table DECLARES families only when its header row has a Layer column; tables without one (closure ledgers, evidence registers) are ignored by the parser, so enumerate freely there. Family-id cells in declaration tables must parse cleanly (a single id, an explicit list, or a brace form — not prose).`
    : "";
  // A brownfield reconciliation can produce four-digit problem counts
  // (observed: 1638). Dumping them all into one environment message would
  // consume the designer's context; group by class instead and point at the
  // complete list on disk.
  const problemBlock =
    problems.length <= 40
      ? problems.map((problem) => `- ${problem}`).join("\n")
      : summarizeProblemsByClass(problems);
  return `[Environment: the deterministic corpus gate failed, so fresh readers and the independent auditor cannot run yet. Correct every problem below, then emit <<REQUEST-READER-TEST>> so the exact corrected corpus is reviewed. Do not emit CAMPAIGN-COMPLETE.

${problemBlock}${schemaReference}]`;
}

/** Group a large problem list into classes with counts and a few verbatim examples each. */
export function summarizeProblemsByClass(problems: string[]): string {
  const classes = new Map<string, string[]>();
  for (const problem of problems) {
    const key = problem
      .replace(/CF-[A-Za-z0-9/-]+/g, "CF-*")
      .replace(/HB-[A-Za-z0-9-]+/g, "HB-*")
      .replace(/"[^"]*"/g, '"…"');
    const bucket = classes.get(key) ?? [];
    bucket.push(problem);
    classes.set(key, bucket);
  }
  const lines = [...classes.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([key, members]) => {
      const examples = members.slice(0, 3).map((m) => `    - ${m}`);
      return `- ${members.length}× ${key}\n${examples.join("\n")}`;
    });
  return `${problems.length} problems in ${classes.size} classes. The COMPLETE per-item list is in ./CATALOG-GATE-PROBLEMS.md — read it (it is large; read it in slices) and fix systematically by class rather than one item at a time. Classes, largest first, with up to 3 verbatim examples each:

${lines.join("\n")}`;
}

export function readerRereviewRequiredMessage(): string {
  return `[Environment: the validation-design corpus changed after the most recent fresh-reader pass. That review is now stale. Emit <<REQUEST-READER-TEST>> without making further edits; completion and audit remain blocked until the current corpus has been reviewed.]`;
}

export function auditWindowRequiredMessage(
  missing: string[],
  unconfirmed: string[],
  unarbitrated: string[],
): string {
  const problems = [
    ...(missing.length > 0 ? [`findings without a parsed DISPOSITION line: ${missing.join(", ")}`] : []),
    ...(unconfirmed.length > 0
      ? [`dispositions without persisted stakeholder CONFIRMED evidence: ${unconfirmed.join(", ")}`]
      : []),
    ...(unarbitrated.length > 0
      ? [`disputed findings without persisted stakeholder CONFIRMED arbitration: ${unarbitrated.join(", ")}`]
      : []),
  ];
  return `[Environment: the audit feedback window cannot close yet. ${problems.join("; ")}. Present any disputes to the stakeholder and obtain a reasoned CONFIRMED ruling, then emit <<CAMPAIGN-COMPLETE>> again. The 12-exchange convergence cap still applies.]`;
}

export function auditedCoreChangedMessage(): string {
  return `[Environment: the audited core corpus changed after the terminal independent auditor pass. Completion is fail-closed: the catalog, backlog, policy, contracts, invariants, maps, eval plan, golden sets, and other normative design artifacts are now frozen because no third audit iteration is allowed. Revert every post-audit core edit to the version the auditor reviewed. You may still update only validation-design/ratification-package.md, owner-briefing.md, and owner-backlog.md. Then repeat the pending protocol marker. Repeated attempts to deliver an unaudited core abort the run.]`;
}

export function auditSectionRequiredMessage(): string {
  return `[Environment: CAMPAIGN-COMPLETE rejected — validation-design/ratification-package.md does not yet contain an "Audit" heading. Write the Audit section now (verdict, every finding by tier with its disposition, unresolved disputes and deferrals for the human), then emit <<CAMPAIGN-COMPLETE>> again.]`;
}

export function catalogAgreementRequiredMessage(
  problems: string[],
  nextMarker: "REQUEST-READER-TEST" | "CAMPAIGN-COMPLETE" = "CAMPAIGN-COMPLETE",
): string {
  return `[Environment: completion rejected — both case-catalog.md and case-catalog.yaml are mandatory and must agree. Fix every problem, then emit <<${nextMarker}>>. Findings:

${problems.map((p) => `- ${p}`).join("\n")}]`;
}

/**
 * Owner-facing documents (issues #2 and #3). Sent once the audit loop has
 * closed and the ratification package's Audit section is written — a
 * separate environment message so the designer treats them as a distinct
 * pass, not an afterthought inside the package.
 */
export function ownerDocsMessage(): string {
  return `[Environment: the audit loop is closed and the ratification package's Audit section is written. Before the campaign can complete, write the two owner-facing documents. Both are NON-NORMATIVE by construction — generated from the ratified artifacts; if either disagrees with an artifact, the artifact wins and the disagreement is a bug in the document. Both should read aloud cleanly (audio-friendly).

## 1. validation-design/owner-briefing.md (ratification moment — frozen at campaign close)

Narrative, 2–4 pages, consequence language. No unexplained ID on first use; IDs appear only as parenthetical anchors. Fixed section shape:

1. What this product can break (the tier, told as stakes, not as "C3")
2. The promises (each invariant as one plain sentence)
3. The seams (boundaries as "places where two systems can disagree about what happened")
4. What we deliberately will NOT test, and why (pruned/thin lanes, declared-empty lanes)
5. The decisions on your desk — one entry per ratification item, each with "what saying yes commits you to"
6. What is still unknown (open findings, in terms of the incident you'd face, not the register ID)
7. What gets built, in what order — one paragraph per backlog wave, in consequence language (e.g. "Wave 1 is the permission-to-effect chain — until it lands, the promise that agents can't grant themselves authority is designed but unproven"). Per-ticket depth does NOT belong here; that is the living companion.

State at the top that this briefing is a summary of the ratified artifacts, not a second source of truth.

## 2. validation-design/owner-backlog.md (living follow-along companion)

One consequence-language paragraph per wave and per HB ticket: which promise the ticket defends, the plain story of the failure it exists to catch, and what "done" buys the owner. No unexplained ID on first use. State its non-normative status and the backlog revision it was generated from. Note that it must be regenerated when harness-backlog.md changes (the AGENTS.md contribution carries that staleness contract).

When both files exist, emit <<CAMPAIGN-COMPLETE>> on its own line. The environment rejects completion until they do.]`;
}

export function ownerDocsRequiredMessage(
  problems: string[],
  nextMarker: "REQUEST-READER-TEST" | "CAMPAIGN-COMPLETE" = "CAMPAIGN-COMPLETE",
): string {
  return `[Environment: completion rejected — the owner-facing documents are missing, stale, or structurally incomplete. Correct owner-briefing.md and owner-backlog.md per the owner-document contract, then emit <<${nextMarker}>>. Problems:

${problems.map((problem) => `- ${problem}`).join("\n")}]`;
}

export function designerEmptyTurnNudge(): string {
  return `[Environment: your previous reply reached the relay with no content — likely you did all the work in tool calls and ended without a message. The stakeholder cannot receive an empty message. Summarize what you just did (or present the pending gate) now, and end with exactly one protocol marker on its own line.]`;
}

export function stakeholderNudge(): string {
  return `[Environment: your previous reply may not have reached a conclusion. Please respond to the designer's last message — remember your gate discipline: OBJECTION / GATE-REFUSED / CONFIRMED with evidence.]`;
}
