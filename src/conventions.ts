/**
 * Normative traceability conventions for the AGENTS.md contribution
 * (issue #4). The designer must include this block in
 * `agents-md-contribution.md` so every coding agent — Cursor, Codex, Claude
 * Code — lands specs the `validation-trace` CLI can close against.
 *
 * These are building codes, not taste. The product repo's CI runs the
 * trace CLI against them; a silent rename or an unowned family turns the
 * gate red.
 */
export const TRACEABILITY_CONVENTIONS = `**Traceability conventions** (normative — the separate \`Validation Trace\` check enforces deterministic closure):

1. **The checked YAML model is authority.** The complete \`validation-design/model/*.yaml\` set owns structures, families, owners, provenance, controls, lanes, statuses, and backlog facts. Generated Markdown is navigation only.
2. **Repository facts stay injected facts.** The host adapter emits exact-revision test inventory and evidence records with explicit family/control links; tests and artifacts never redefine design meaning.
3. **Every implementable family has an observed implementation and evidence link.** Absence is a trace red even when a ticket is honestly pending. A \`LANDED\` ticket with no implementation is additionally a status-honesty failure.
4. **Negative controls remain paired.** Every selected detector family keeps its declared control, and impact advice keeps both control implementations and always-run safety checks. A missing mapping widens to the full applicable suite.
5. **Traceability updates land with tests.** Adding, moving, or deleting a test updates adapter inventory. If planned paths, family meaning, control links, or status change, edit \`model/families.yaml\`, \`controls.yaml\`, or \`backlog.yaml\` in the same change and recompile.
6. **Compile after model changes.** The compiler regenerates \`case-catalog.md\`, \`harness-backlog.md\`, owner views, \`planned-trace.md\`, and \`compiler-report.json\` from one identity. Hand-edited or stale projections are rejected.
7. **Use \`implement-harness-ticket\`.** Resolve ticket → family → product structure/enumeration → red-then-green implementation. Structural gaps re-enter design revision; fidelity remains a separate judgment.
8. **Legacy headers are adapter syntax, not authority.** Hosts still using \`validation-trace --manifest\` keep family-named directories and first-comment CF/HB citations for that explicit legacy token/header inventory adapter. New checked-model facts do not live in those tokens.
9. **Outcome campaigns require fresh human authorization.** Implementing fixtures and mechanical preflights is ordinary ticket work; running a live layer-6 campaign names its target, scenario set, spend/time ceiling, and permitted effects. Incomplete inputs remain \`inconclusive\`.
10. **Non-test lanes declare honest evidence.** \`model/families.yaml\` records \`evidence: {state, path}\`; incomplete, inconclusive, unobserved, missing, stale, or structural-only artifacts remain visibly partial and cannot become product green.`;
