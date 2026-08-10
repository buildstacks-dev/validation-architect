# Changelog

## 0.6.0

Derived from a blind-derivation experiment against a brownfield product (Cormidia, 2026-08-09): the same invariants were re-derived from source by an agent with no access to the ratified answer, and the results were verified against the code. Two invariants produced an order of magnitude more falsification surface than their ratified seed lists, including live holes in a non-prunable invariant. Every change below traces to something that experiment surfaced.

- **Layer 6 — outcome acceptance (`L-ACC`).** The taxonomy's generator is amended from two axes to three: layers 1-5 all have mechanical oracles, and a scored outcome against a human-ratified rubric cannot be folded into a pass/fail lane. Extracted from a product that hit this wall and built the lane itself. Adds ten design obligations (ratified rubric, realistic input as a controlled variable, sealed answer key, per-axis grader independence in code, the self-report rule, campaign invariants in their own registry, staged arms with an intermediate gate, preflight refusals, a declared release relationship, hard boundaries) and the `acceptance/` deliverable.
- **Two new layer rules.** *Guardrails are not lane work* — anything a scan or exit status can falsify lands at layer 1/2 with a negative control, never in the expensive lane. *The instrument is measured a layer down* — a layer-6 grader's quality is a layer-4 judge-calibration site.
- **Invariant violation surfaces move from Phase 2 to Phase 6.** Phase 2 now sketches two or three violation paths as a falsifiability check on the *statement* and explicitly forbids treating them as the case list. The exhaustive derivation is agent-alone, source-grounded, and gains a method: choose and defend the counting unit, walk source to sink, and close over the substrate with an inventory. The human ratifies the statement and its tier; enumerating how the code can make it false is not where human attention pays.
- **Coverage verdicts carry a mechanism and a considered-flag.** `enforced` names its mechanism or it is `unclear`; a gap distinguishes an oversight from a deliberate documented tradeoff, which is a product-truth finding rather than a defect.
- **Sourcing channel 4 — substrate drift.** When a new instance of an already-enumerated class appears, every inventory over that class is re-derived and every enumerating guard re-checked. The only channel triggered by the shape of the change rather than by a human or an incident noticing.
- **The module map becomes a commitment.** Per-module status (`deep-pass-done` / `deep-pass-pending` / `deliberately-shallow`), and closure is reported as *complete-at-product-granularity* while any pass is pending. Adds the derive-at-substrate-granularity / ratify-at-module-granularity split.
- **Execution lanes per case family** (`inner-loop` / `per-commit` / `triggered` / `release` / `scheduled`), with the layer supplying the default and the inner-loop lane naming an actual command.
- **Re-entry and steady state.** Interaction mode is detected from whether a ratified policy exists, not asked; a steady-state run does not re-teach or re-confirm settled decisions. Run state moves to `harness-state.yaml`, separate from the ratified policy; staleness comes from a source diff rather than a calendar; and a re-run against an unchanged product converges to zero changes and zero questions.
- **Operating rule 18 — rollups are derived, never authored.** A hand-written total drifts from its own table and always in the flattering direction.

## 0.5.0

Enablement promotions from the validation-architect re-scope (2026-08-01), so the skill carries what the orchestrator previously enforced alone.

- Phase 6 + deliverable 7: emit `case-catalog.yaml` (schema `validation-architect/case-catalog/v1`) alongside `case-catalog.md` at matrix closure; the two must agree; regenerate when the markdown catalog or backlog family claims change.
- Phase 8 deliverables 11–12: `owner-briefing.md` (ratification-moment narrative, fixed section shape) and `owner-backlog.md` (living consequence-language companion per wave/ticket); both non-normative by construction. Adversarial reader test extended to cover them.
- Deliverable 10 (`agents-md-contribution.md`): routes coding agents to update both catalog surfaces, lists the normative traceability conventions the `validation-trace` CLI enforces, and names the `implement-harness-ticket` skill as the standard implementation path.

## 0.4.0

Rightsizing revision, derived from the first full brownfield application (Operon, 2026-07-29/30, `parallel-greenfield`): the campaign produced strong artifacts and found two real C3 production defects, but stalled at 74 executable tests because a single global expansion gate froze catalog growth behind out-of-layer conditions (live target, eval threshold, CI authorization).

- **Derivation ≠ implementation.** Phase 6 now separates catalog *derivation* (design work, completes inside the campaign, needs no fixtures or authorization) from case *implementation* (build work, gated per layer by the walking skeleton). New completeness criterion: **matrix closure** — every cell (source artifact × derivation row) carries a traced case or a named risk-pruning reason; a silent empty cell is a finding, like an undeclared-absent lane. Deliverable 7 no longer says "scaffold and seed now, expand after the skeleton."
- **Expansion gates are scoped per layer** (deliverable 8): a gate may only reference conditions inside the layer it gates; a missing live target or unauthorized CI parks its own layer's tickets, never layer-1/2 implementation.
- New rule 16 — **every detector ships its negative control**: red-then-green against a seeded violation, walking-skeleton tests included.
- New rule 17 — **the harness is itself a tested artifact**: fixture self-tests, scanners that fail on an empty walk, policy loaders and CI config pinned by tests.
- **Additive CI is walking-skeleton scope under `parallel-greenfield`**: the isolated root's own lane is required from the first skeleton ticket; only integration with the incumbent's pipelines stays opt-in until ratified cutover (Phase 0 + `policy-and-inheritance.md`).
- **Provisional tolerances** (Phase 4): a contract parameter awaiting tuning gets a `PROPOSED` provisional value with owner and expiry (`provisional_values:` in the policy, waiver shape) instead of `OPEN`; `OPEN` is reserved for undecided semantics. An expired provisional is an active finding.
- **Backlogs name their executor**: every ticket carries an owner (human, standing coding agent, or scheduled build campaign) — a backlog without owners is a designed stall.
- Adversarial-review reader test extended: readers must be able to tell which derivation-matrix cells are covered, pruned, or still open.

## 0.3.0

Merges two revisions of 0.1.0 that were developed in parallel — the 0.2.0 structural revision below and a protocol revision ratified in a 2026-07-28 design session — into one line.

- New **Division of labor** section: a seven-step standing human↔agent protocol — align the system picture together; agent proposes boundaries and contracts, human corrects; human thinks first on invariants and risk weighting, agent structures; human confirms the assembled artifact set; agent alone builds the walking skeleton, then derives cases exhaustively; human spot-reviews by risk tier — framed as *artifacts are the compression of human judgment; case derivation is decompression*.
- **Differentiated elicitation** loop control: beat 3 is strictly human-first for the concepts that encode business consequence (invariants, risk tiers); a propose-then-correct variant is permitted after beats 1–2 for concepts derivable from written architecture (boundaries, contracts).
- **Expanded grounding** option in beat 2: when the human says examples unlock their thinking, grow the grounding set to 3–5 worked derivations plus one near-miss, with explicit anti-anchoring guards so the example set never becomes the candidate list.
- **Stimulus taxonomy** as a structural rule: user events and time events are case-matrix rows; adversity events (crash, kill, restart, partition) are modifiers applied at every flow step via the failure-mode checklist, never rows of their own. Wired into the Phase-1 behavioral view and the Phase-6 case derivation grammar.
- Interface-adapter rule extended with one **cross-surface agreement check** that all adapters expose the same operations with the same semantics; vocabulary unified on "adapters".
- Invariant **sorting test** (names a specific operation → that operation's contract; must survive every operation → invariant) plus the compression rationale for keeping the invariant set small.
- `crash-mid-step` added to the boundary failure-mode checklist, named as the mechanical complement to flow-walk intuition — it yields the mid-flow cases (crashed after the write, before the acknowledgment) journey intuition skips.
- Honest-fake verdict recorded as a per-boundary **column** in `boundary-map.md` carrying the controlled-seam specification; doubles must expose scriptable failure modes ("this call 500s twice, then succeeds"); one fake↔real **conformance drift suite** runs against both the double and the real dependency.
- Walking-skeleton-before-mass-derivation ordering made explicit in the harness backlog: cases authored before the fixtures exist get written to what is convenient to test rather than what the contracts require.
- Skill description rewritten to cover the merged surface while restoring the 0.1.0 trigger phrasings.
- New deliverable `agents-md-contribution.md`: a proposed section for the repo's agent-instructions file (`AGENTS.md`/`CLAUDE.md`) that routes every future coding agent to the harness artifacts — consult the journey's acceptance criteria and the affected boundary's contract on feature changes, deposit cases per the derivation grammar into `case-catalog.md`, deposit each bug fix's detector in the same change, never weaken gates (tighten-only), and re-enter `harness-revision` mode on structural mismatch. The adversarial review gains a third reader (a coding agent with only the repo's standing instructions), and ongoing case sourcing names this routing as the mechanism that makes the three channels fire.

## 0.2.0

- Added a Phase-1 system-mapping pass that reconciles behavioral flows (`actor → stimulus → journey → state transition → effect → observation`) with structural state ownership, consistency, dependencies, and independent failure domains.
- Distinguished interfaces and event sources from the underlying behavior so shared journeys are validated once and CLI/API/UI/MCP or event adapters receive focused conformance coverage.
- Made the human-agent authority split explicit: humans own product truth, consequence, and risk acceptance; agents own derivation and return unknown expected outcomes for resolution.
- Added `parallel-greenfield` coexistence for isolated replacement harnesses, with protected incumbent paths, additive opt-in CI, and explicit equivalence/rollback/cutover requirements.
- Moved controlled-seam specification into boundary design: hermetic composition is not a fake layer, boundary doubles declare simulated and unproven semantics, and every unproven real behavior retains a live-sandbox obligation.
- Added a risk-pruned case derivation grammar and the `system-map.md` and `case-catalog.md` deliverables while preserving the walking-skeleton-before-expansion rule.
- Extended `validation-policy.yaml` guidance with artifact locations and machine-readable coexistence constraints.

## 0.1.0

Initial release.

- Teach-first, elicit-before-synthesize design workflow (four-beat concept loop) over invariants, boundaries, contracts, LLM eval layers, and risk tiers.
- Five-layer validation taxonomy (invariant/contract, hermetic system, live sandbox, eval/qualification, ops hardening) with the four layer rules.
- Four scope modes: product, module-of-built-parent, module-of-designed-parent, harness-revision.
- Deliverables: invariants, boundary map, contracts, LLM eval plans with golden-set scaffolds, `validation-policy.yaml`, harness backlog, elicitation log.
- Policy-as-data with distributed files, `extends:` inheritance, tighten-only rule, expiring waivers, fail-closed defaults.
- Aligned with companion skill validation-harness-audit: shared C0–C4 criticality scale, policy schema owned here and consumed by the audit, structural findings returned via harness-revision mode.
- Reference set: concept primers, question bank, LLM eval patterns, policy and inheritance, tooling menu.
