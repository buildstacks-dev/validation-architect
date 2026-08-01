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
export const TRACEABILITY_CONVENTIONS = `**Traceability conventions** (normative — the \`validation-trace\` CLI enforces them in CI):

1. **Test directories are named by case-family ID.** Specs for \`CF-INV-001\` live under a directory whose name contains \`cf-inv-001\` (case-insensitive); likewise for every other family. Helpers and fixtures that are not family-scoped may sit beside them.
2. **Spec file headers cite the family and the owning backlog ticket.** The first comment block of every \`*.test.*\` / \`*.spec.*\` file names the \`CF-…\` family it exercises and the \`HB-…\` ticket that owns it (plus the contract/invariant section it binds to). A citation the catalog does not know is an orphan — the trace CLI turns red.
3. **Every implementable family owns ≥1 citing spec, or is declared pending with its wave.** Non-pruned, non-blocked families without a citing spec must appear on a backlog ticket whose status is not LANDED. A LANDED ticket whose families lack specs is a status-honesty failure.
4. **Traceability updates in the same change as the tests.** Adding, moving, or deleting a citing spec updates \`case-catalog.yaml\` (and the markdown catalog it must agree with) and the backlog's status annotations in the same change — never a follow-up.
5. **The machine-readable catalog is authoritative for tools.** \`case-catalog.yaml\` is the companion of \`case-catalog.md\`; disagreement between them is a corpus bug. The markdown catalog remains the human artifact.`;
