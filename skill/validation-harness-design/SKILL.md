---
name: validation-harness-design
description: Teach-first workflow for designing or revising a validation harness before implementation. Reconciles journeys and interfaces with state ownership and failure domains, then records product structures, policy, validation families, controls, ownership, provenance, and backlog facts in the checked validation-design/model YAML corpus. Use when planning tests/evals for a product, feature, module, or agentic system; defining invariants, boundaries, contracts, or acceptance criteria; placing checks across invariant/contract, hermetic, live, eval, ops, and L-ACC layers; preparing model swaps; designing an isolated replacement harness; or revising a harness after architecture drift. Complements validation-harness-audit, which measures what was built against this design.
---

# Validation Harness Design

Design — and redesign — the validation surface for a product or module **at design time**: before code exists on first entry, and re-entered whenever the architecture moves or the harness itself proves wrongly shaped. The durable contract is the versioned YAML model under `validation-design/model/`; catalog, backlog, owner, and planned-trace Markdown are deterministic projections of it. Narrative rationale may remain authored prose, but it never restates machine-fact tables as a second authority. Case-level evolution happens continuously through the sourcing channels; structural revision happens by re-entering this skill in `harness-revision` mode — a harness that can only grow, never be reshaped, calcifies around its first mistake.

**Stance: teach, then elicit, then synthesize.** The human is the domain expert, but domain expertise is not the same as fluency in validation vocabulary. Do not open a phase by presenting candidate invariants or boundaries for review — that turns a design session into a review task and silently hands you the framing power. Every concept is taught before it is applied, and the human's own unstructured thinking is the primary input to synthesis. Anything you originate is labeled and requires confirmation. The human owns product truth, consequence, and risk acceptance; the agent owns disciplined derivation and must return every unknown expected behavior to the human rather than silently inventing it.

## Operating rules (apply to every phase)

1. **Teach before elicit; elicit before synthesize.** Never present a candidate list for a concept the human has not yet been given a frame for and a chance to think inside. The four-beat concept loop below is mandatory for invariants, boundaries, contracts, eval layers, and risk tiers.
2. **Socratic before generative.** Derive candidates from the architecture doc and the human's answers first. Anything you originate — including patterns imported from comparable systems — is labeled `PROPOSED` and requires explicit confirmation before entering a deliverable.
3. **Falsifiability gate.** An invariant is accepted only if stated as something a test could violate. "The system should handle payments reliably" is rejected; "no charge exists without exactly one order" passes. Rewrite or discard anything that fails.
4. **The boundary test.** Every proposed boundary must answer: *can side A be down while side B is up?* If the human can't answer, that is an architecture gap — record it as a finding rather than papering over it. External systems (payment APIs, LLM providers, third-party tools) are boundaries by definition.
5. **Guardrails enforce invariants; evals measure quality.** Never let an invariant depend on model goodwill or probabilistic behavior. Invariants get runtime enforcement (fail-closed) plus tests of the *guardrail*; evals measure quality statistically, offline.
6. **Evals before prompt iteration.** Golden sets are authored and committed before any prompt tuning, or validation is circular. Same discipline for classic code: adversarial cases are derived from invariants before implementation.
7. **Risk weighting is a human decision.** You propose probability × cost tiers; the human confirms them. Business consequence is not fully encoded in any doc.
8. **Harness before cases.** The skeleton (one real mechanical detector per active layer through real CI, plus an executable but never implicitly authorized campaign skeleton for layer 6) is the upfront investment; cases accumulate through the four sourcing channels forever after.
9. **Policy-as-data, fail-closed, tighten-only.** Decisions land in `validation-design/model/policy.yaml`, not prose. Missing gates default to blocking-absent findings, never silence. A module policy may narrow an inherited requirement; a module policy that loosens one is a policy violation, not a merge.
10. **Inherit, never restate.** In module scope, parent invariants and contracts are referenced by ID. Duplicating them into the module's files creates two truths that drift.
11. **Hard stops are hard.** Scope confirmation (Phase 0), tier confirmation (Phase 1), risk-tier confirmation (Phase 6), tooling selection (Phase 7), and the adversarial review (Phase 8) require explicit human go-ahead. Do not proceed on silence.
12. **Every check lands at the cheapest layer that can falsify it.** The six-layer taxonomy below governs placement; its six layer rules (prove it a layer down, no silent absence, evidence deposits a detector, security is split, guardrails are not lane work, the instrument is measured a layer down) carry the same rank as the rules above.
13. **Map behavior and structure before deriving claims.** Reconcile the behavioral view (actor → stimulus → journey → state transition → effect → observation) with the structural view (components → state ownership → dependencies → consistency and failure domains). Interfaces are entry and observation adapters, not duplicated behaviors; journeys alone do not define boundaries.
14. **Completeness is not quantity.** Seek a complete scoped map and a compact durable invariant set, not the largest list. Boundaries must be complete for the declared scope; contracts and cases become progressively more numerous beneath them.
15. **Design controlled seams early; implement them after contracts.** A hermetic system is real composition with nondeterminism controlled, not a "fake layer." Specify what each boundary double must simulate during boundary design, finalize it with the contract, and build it in the walking skeleton. Preserve a named live obligation for every real behavior the double cannot prove.
16. **Every detector ships its negative control.** A check proves it can fire before it proves the system passes: each detector family lands red-then-green against a seeded violation — a mutated fixture, a planted defect, a double scripted to misbehave. The walking skeleton's per-layer tests carry theirs from day one. A detector that has never seen the defect it exists to catch is an assumption, not a guard.
17. **The harness is itself a tested artifact.** Fixtures get self-tests; scanners and sweeps assert their walk found subjects (an empty walk fails, never passes); policy loaders, CI configuration, and dispatch/registry surfaces are pinned by tests of their own. A guard nobody guards is a silent absence — treat it exactly like an undeclared-empty lane.
18. **One machine authority; derived rollups.** Product structures, policy, families, owners, controls, statuses, provenance, trace links, and backlog facts exist only in the logical YAML model. Markdown projections and every count or rollup are compiler-generated. A hand-written duplicate is not accepted input.
19. **One relationship graph; four generated views.** Trace and explain walk the compiled changed-path → structure → family → test → evidence graph in both directions. Author, architect, Reviewer, and operator projections share one exact graph identity; unresolved hops remain visible. Deterministic closure never claims oracle fidelity.
20. **Unknown impact expands.** Changed-path planning is advisory. Missing, uncertain, corrupt, stale, or structural mappings widen to the full applicable lane; negative controls and always-run safety checks stay paired. The full required CI suite remains authoritative and runs exactly once.
21. **Versions never migrate on read.** Pin exact package, method, model, compiler, policy, result, and golden-set versions plus source/model identity. Pre-1.0 accepts only the current clean schema. A future previous-major corpus enters only through a named, reviewed migration that writes a new artifact; unknown or mixed bundles fail before provider work.

## The layer taxonomy

Every check this skill designs lands in one of six validation layers. A layer is defined by **the question it answers** — "what can be false?" — never by the technology inside it, so the same six names serve a CRUD app and an autonomous agentic system. Three axes generate the taxonomy: *is the verdict deterministic?*, *does the test touch the real world?*, and *is the oracle mechanical or human?* Layers 1–5 all have mechanical oracles — a clause, a composition, a boundary check, a statistical threshold, a load measurement. Layer 6 is the only lane whose oracle is a human-ratified rubric, which is why a scored outcome can never be folded into a pass/fail lane: doing so forces you either to weaken that lane's pass semantics or to report a score as if it were a clause. Teach it in Phase 1 (frame and ground beats only — it is a fixed frame, not an elicited concept); primer: `references/concept-primers.md#layer-taxonomy`.

| # | Layer | Question it answers | Verdict | Spend / side effects | Cadence |
|---|---|---|---|---|---|
| 1 | **Invariant / contract** | Can the machinery lie? | Deterministic | None | Every commit |
| 2 | **Hermetic system** | Can composition lie? | Deterministic | None | Every commit |
| 3 | **Live system (sandbox)** | Can the real world break the seams? | Nondeterministic, binary | Real, bounded, disposable | Pre-merge / pre-release |
| 4 | **Eval / qualification** | Can the model be wrong while the machinery is right? | Statistical, threshold over N runs | Token cost, separately authorized | Prompt/model change · nightly · release qualification |
| 5 | **Ops hardening** | Can time, load, or an adversary hurt you? | Mixed | Production-shaped | Pre-GA, then recurring |
| 6 | **Outcome acceptance** (`L-ACC`) | Given realistic input, is the output work a human would accept? | Multi-axis scored against a ratified rubric; **inconclusive is the default state** | Real, bounded by per-campaign human authorization | Triggered only — never scheduled, never casual |

Layer 6 is the only lane that asks a **validation** question rather than a verification one, and it is the one most often missing from a harness that looks complete. Place a check by asking what it would prove: layer 3 asks whether a seam behaves as its contract says (deterministic, per boundary); layer 4 asks whether the model can be wrong while the machinery is right (statistical, per call site, against a golden set); layer 6 asks whether **everything can be right and the output still be worthless** (scored, end to end, against a human rubric). A system can pass every one of layers 1–5 and produce work no user would accept. Most products that emit *work product* rather than *values* have a layer-6 question; for an agentic system the honest default is non-empty.

The economic thesis is simple: rapid iteration comes from the **cheapest trustworthy answer**, not the largest suite. If every composition question requires a live environment, the harness is slow regardless of case count.

The six layer rules:

- **Prove it a layer down.** Each layer exists to cover the blind spot of the one below; before a check lands at an expensive layer, ask whether a cheaper layer could falsify it. Layer 2 is where most composition risk dies — the only place composition meets determinism, which is what makes iteration cheap. Layer 3 is reserved for seams that cannot be faked honestly (vendor auth handshakes, CI, OS schedulers, vendor behavior that has burned you before).
- **Layers may be empty, never silently absent.** `model/policy.yaml` declares all L1–L6 layers and all five execution lanes. A product with no model call sites declares L4 empty with a reason. A future audit treats a declared-empty entry as a decision and an undeclared absence as a finding. This rule is what lets one taxonomy scale from a throwaway tool to an autonomous system.
- **Evidence is not a regression suite.** Layers 3–4 produce evidence; every deterministic defect they surface deposits a layer-1/2 detector in the same change. A green live run proves that run, nothing more.
- **Security is split, not a layer.** Security invariants (tenancy, authorization, deny-by-default, no silent overwrite) enter layer 1 from day one via Phase 2; layer 5 holds only the assurance half (threat model, secret handling, abuse surfaces).
- **Guardrails are not lane work.** Everything about a layer-6 campaign that a scan, a set comparison, an exit status, or an authorship walk can falsify is a mechanical guardrail: it lands at layer 1/2 with a negative control, never in the expensive lane. Only the rubric's *scored axes* are layer-6 rows. A lane that absorbs its own guardrails stops being affordable and stops being falsifiable — this is "prove it a layer down" applied to the most expensive lane, where it matters most.
- **The instrument is measured a layer down.** A layer-6 grader's *quality* is a layer-4 judge-calibration site; its *transport* reuses the boundary contract the product already has for that provider. Layer 6 never certifies its own instrument, and an uncalibrated grader produces `inconclusive`, not a score.

## The concept loop

Apply these four beats to **each** concept in Phases 2–6. Read the concept's entry in `references/concept-primers.md` before beat 1.

**Beat 1 — Frame.** State what the concept is, why it exists, and what it is commonly confused with. Give 2–3 canonical examples drawn from domains *other* than the human's. Keep it to a few short paragraphs — this is orientation, not a lecture.

**Beat 2 — Ground.** Walk one worked example out of the human's own architecture doc, showing the derivation. Label it explicitly: *this is an illustration of the shape, not a proposal, and not a boundary on your thinking.* To limit anchoring, draw the example from a **different subsystem than the one under design** wherever the doc allows, and never give more than two — unless the human says examples are what unlocks their thinking for this concept (most common with invariants). Then expand the grounding set to 3–5 worked derivations spanning the concept's categories, each showing *why* it passes the acceptance gate, plus one near-miss that fails it (e.g. a contract masquerading as an invariant). Expanded grounding stays teaching material: draw from subsystems away from the human's current focus, label every item an illustration, and after the human's beat-3 ramble ask what the examples made them think of that the examples themselves don't cover — the example set must never quietly become the candidate list.

**Beat 3 — Elicit.** Hand the floor over. Invite unstructured thinking — rambling, half-formed, out of order, in whatever register the human prefers. Do not supply a template, a numbered list to fill, or a candidate set. Ask at most one focusing question. Then stop and wait; do not answer your own prompt.

**Beat 4 — Synthesize.** Combine, in this order: (a) what the human said, (b) what the architecture doc supports, (c) patterns from comparable systems, labeled `PROPOSED`. Present the structured candidate set with provenance marked per item — `[stated]`, `[doc]`, or `[PROPOSED]`. Apply the concept's acceptance gate (falsifiability, boundary test, contract completeness). Treat an unknown expected outcome as a product-truth finding, not an invitation to choose for the human. Confirm before moving on.

**Loop controls:**

- **Depth.** Teach-first is the default. If the human signals fluency ("skip the framing", "I know what an invariant is", "go fast"), collapse beats 1–2 into a two-sentence recap for that concept only — never silently across the whole session. Ask once at Phase 0 whether any concept should run in fast mode.
- **Differentiated elicitation.** Beat 3 is strictly human-first for the concepts that encode business consequence — **invariants and risk tiers**: never open them with a candidate list; the human rambles, you structure. For concepts derivable from the architecture doc — **boundaries and contracts** — a propose-then-correct variant is acceptable after beats 1–2: present a doc-derived draft (every item marked `[doc]` or `[PROPOSED]`) and elicit corrections. The reason for the split: a plausible-looking invariant list gets approved while the one thing only the human knows never surfaces; a boundary list is checkable against written architecture.
- **Backflow.** Concepts are not independent: boundaries routinely reveal invariants, and contracts reveal missing boundaries. When a later beat invalidates an earlier artifact, say so explicitly, reopen that concept, and note the revision — do not quietly patch it.
- **Elicitation log.** Capture the human's beat-3 input close to verbatim in `elicitation-log.md`. It is the provenance trail for every `[stated]` item and the record of what was considered and dropped.
- **Checkpoint.** After each concept completes beat 4, write current state to `harness-design-state.md` (scope, tier, concepts completed, open findings, pending confirmations) so an interrupted session resumes without re-interrogation.

## Division of labor

The phases below run inside a standing human↔agent protocol. Its premise: alignment produces artifacts that are checkable without the human — **the artifacts are the compression of human judgment; case derivation is decompression.** Where an artifact encodes business consequence, the human thinks first; where it is derivable from the docs, the agent drafts first.

1. **Human + agent align the picture** — the reconciled system map: architecture, interface surfaces, flows, and events (Phases 0–1).
2. **Agent proposes, human corrects:** boundary map with its honest-fake column, and per-boundary contracts (Phases 3–4).
3. **Human rambles, agent structures:** invariants and risk weighting (Phases 2 and 6) — the inverted step; see Differentiated elicitation.
4. **Human confirms the assembled artifact set** — the last heavyweight alignment point.
5. **Agent alone: walking skeleton** — the honest fakes plus one real detector per mechanical layer through real CI and, when `L-ACC` is active, its campaign manifest/rubric loader/preflight path with negative controls at layers 1–2. The live outcome campaign remains unrun until separately authorized. This lands *before* mass case implementation (catalog derivation is never deferred — Phase 6).
6. **Agent alone: exhaustive derivation** — the case derivation grammar (Phase 6) applied over the ratified artifacts to matrix closure (every cell traced or risk-pruned by name), each case landing at the cheapest layer that can falsify it (rule 12), every unknown expected outcome returned to the human.
7. **Human spot-reviews by risk tier** — audit the top-tier paths, smoke-check the rest; never line-by-line.

Two structural rules the protocol depends on:

- **Stimulus taxonomy.** Enumerate stimuli in two families of matrix rows — *user events* (each interface operation) and *time events* (each scheduled tick). *Adversity events* (crash, kill, restart, partition) are never rows: they are modifiers applied at every flow step via the failure-mode checklist. Treating "process restart" as one event yields one test; treating it as a modifier yields the mid-flow cases intuition misses.
- **Interfaces are adapters, not surfaces to re-test.** When a product exposes several interfaces (CLI, API, MCP, UI) over one core, core behavior is validated once at the cheapest layer that can falsify it; each interface gets thin adapter coverage only — parsing, auth, serialization, error mapping, exit codes — plus one cross-surface agreement check that all adapters expose the same operations with the same semantics (rule 13). A behavioral re-run per interface is a framework failure, not thoroughness.

## Phase 0 — Scope declaration and parent ingestion

Establish the scope before anything else. Four modes:

- **`product`** — whole system, no parent harness.
- **`module-of-built-parent`** — a subsystem of a product whose harness already exists in code and policy.
- **`module-of-designed-parent`** — a subsystem of a product whose harness has been designed but not yet built.
- **`harness-revision`** — re-entry into an existing harness design (this skill's own artifacts), whether because the architecture moved, a layer was mis-designed, an audit surfaced structural findings, or simply because it is time to re-run. Ingest the existing artifacts as the baseline, diff them against the current source and architecture doc, and reopen **only** the affected concepts — surgical edits with inline changelogs (Phase 8 revision style), never a wholesale redesign. Unaffected invariants, boundaries, and policy entries stay untouched; every reopened artifact records why it was reopened. Retired invariants keep their IDs (`retired: <date, reason>`) so historical audit findings stay traceable. **Re-entry is the normal case, not the exceptional one** — see "Re-entry and steady state" below.

For module modes, ingest the parent before eliciting anything. Locate and compile the parent `validation-design/model/*.yaml`, then read its generated views, narrative rationale, existing test inventory, and CI config. If the model is missing, ask for its path or require an explicit legacy import; never infer current authority from Markdown. Do not invent the parent's invariants.

Then establish, and confirm:

- **ID namespacing.** Parent and module invariants/contracts carry distinct prefixes (`ACME-INV-003`, `LL-INV-007`) so a later audit can trace which layer a conformance failure belongs to.
- **Inheritance set.** Which parent invariants constrain this module. These are referenced, not restated (rule 10). The module may add new ones or tighten inherited ones; it may never weaken one.
- **The parent seam is a mandatory boundary.** The interface between module and the rest of the product is enumerated in Phase 3 without exception, and is usually the single highest-value boundary in the map — it carries the module's contract to everything else.
- **Contradiction handling.** If the module's design conflicts with a parent invariant or contract, record it as a finding and escalate to the human. Never resolve it silently in either direction.

For **`product`** scope on a large system, go deliberately broad and shallow: produce a module map naming each subsystem, its criticality, and whether it warrants its own later deep pass with this skill. Product-level artifacts should cover cross-cutting invariants and inter-module boundaries — not attempt every module's internals in one sitting.

**The module map is a commitment, not a recommendation.** Represent each module as owned product structures plus families whose status and rationale show `deep-pass-done`, `deep-pass-pending`, or `deliberately-shallow`. While any module is pending, generated closure language is **complete-at-product-granularity**, never complete. A module map whose entries carry no obligation is the easiest way for a large product to look closed while covering everything shallowly and nothing deeply.

**Derive at substrate granularity; ratify at module granularity.** These are different resolutions, and coupling them fails in both directions. The agent derives against every store, channel, and effect site it can find (Phase 6); the human ratifies a module's invariants, tier, and risk appetite. If Phase 6's inventory for a single invariant spans clusters of substrate under different owners, the module map was too coarse and the derivation just proved it — reopen the map rather than absorbing the excess into a flat catalog. Phase 0 proposes the decomposition cheaply from the architecture; Phase 6 corrects it from evidence. Note the cost honestly when proposing: each module pass is its own ratification session, so decomposition trades owner attention per session against total attention, and for a solo owner that can be a net loss.

**Existing-harness coexistence posture.** Scope mode and implementation posture are separate decisions. When the user wants a clean-room or replacement harness beside an incumbent suite, declare `parallel-greenfield`, name one isolated harness root, and mark the incumbent tests, evaluation assets, gates, and CI as read-only. Inspect them only to understand claims and compatibility unless the user narrows that further. Do not weaken, delete, redirect, or replace incumbent gates until a later explicit migration decision with equivalence criteria, rollback, and ownership. New checks and artifacts stay under the isolated root. CI has two halves under this posture: an additive lane running only the isolated root is walking-skeleton scope — required from the first skeleton ticket, because an unenforced harness enforces nothing — while any integration with the incumbent's pipelines (shared commands, required checks, gate redirection) stays opt-in until ratified cutover.

**HARD STOP.** Confirm scope, mode, parent artifact set, coexistence posture and protected paths when applicable, and (for product scope) the module map.

## Re-entry and steady state

A harness is not designed once. It is re-derived against the product for as long as the product lives, and **the second run and the twentieth must cost far less than the first.** Two things follow.

**Interaction mode is detected, never asked.** If no compiler-clean current `validation-design/model/*.yaml` exists for this scope, the run is **onboarding** or an explicit migration: teach-first, every hard stop, the full concept loop. If one exists, the run is **steady-state** and the stance inverts — do not re-teach a concept the owner has already ratified against, do not re-elicit a settled decision, and do not re-present the artifact set for confirmation. Open with what *changed* and what that implies.

**Run state is separate from the design contract.** The logical model says what must be true and records the exact product and method versions. Campaign checkpoints, source fingerprints, compile status, and ratification progress are machine-written run state, never model facts. Test inventory and run evidence are also separate domains: the compiler may join them for queries, but neither can rewrite the design.

**Staleness comes from a diff, not a calendar.** On re-entry, compute what changed in the product since the recorded revision and reopen only what that touches: a changed architecture doc stales the system map; a changed boundary participant stales that contract; a changed enumerating guard (an allow-list, a path regex, a matcher) stales the inventory it belongs to; a **new instance of an enumerated class** is substrate drift and fires sourcing channel 4. Everything the diff does not touch is not reopened and not re-confirmed.

**Convergence is a property, and the tool asserts it on itself.** A re-run against an unchanged product produces **zero artifact changes and zero questions**. If an unchanged tree yields proposed edits, either the derivation is nondeterministic or the staleness diff is wrong — both are defects in the harness tooling, not noise to be tolerated. This is the same discipline rule 17 applies to fixtures, aimed at the campaign itself.

**What a steady-state run may do unattended:** re-derive substrate inventories, propose families against existing structure, record drift, compile generated views, and re-check that enumerating guards still cover their class. **What still stops for a human:** a new invariant, a new boundary, a tier change, a newly opened product-truth finding, a rubric change, and any loosening of anything. The model records accepted facts; run state records when and how they were ratified.

## Phase 1 — Inputs, system map, and criticality tier

Require an architecture document (or any written system description — design doc, spec, README-driven sketch). If none exists, build a one-page system brief through interview first: components, state each owns, external dependencies, user journeys, deployment shape (single-install two-user tool vs multi-tenant SaaS — this parameterizes scale testing later).

Before proposing invariants, build and reconcile two views. Read `references/concept-primers.md#system-mapping`, frame the distinction, invite the human to walk the product in their own words, then synthesize:

- **Behavioral view:** actors and initiating systems; commands, requests, events, signals, time and recovery stimuli; journeys and outcomes; state transitions; durable or external effects; observations; and every supported entry/observation surface. Treat CLI, API, UI, MCP, webhooks, timers, and OS signals as adapters or stimuli around behavior, not as separate copies of the behavior. Enumerate stimuli per the stimulus taxonomy (Division of labor): user events and time events are the rows; adversity is a modifier, not a row.
- **Structural view:** components, deployment units, exact state owners and writers, external dependencies, consistency changes, version-skew possibilities, and independent failure domains.
- **Reconciliation view:** for each journey, identify which components and state owners it crosses, which effects are irreversible, and where observed behavior or ownership is unknown. Record unknowns as architecture or product-truth findings.

Write the result to `system-map.md`. This working map does not replace the architecture document; it makes the derivation surface explicit. Do not proceed from a list of interfaces alone, and do not wait for perfect documentation — validation design is allowed to expose gaps.

Teach the layer taxonomy here — frame and ground beats only, since it is a fixed frame rather than an elicited concept. The tier and deployment shape decide how heavy layers 3–6 must be; the taxonomy gives every later phase its placement vocabulary.

Propose a criticality tier on the C0–C4 scale shared with validation-harness-audit, whose `references/criticality-model.md` is the canonical rubric for both skills — **C0** experimental/throwaway, **C1** limited (local or bounded internal use, reversible consequences), **C2** production (customer-facing or persistent production data — money, customer data, reputation), **C3** high-consequence (serious financial, privacy, regulatory, or broad operational harm), **C4** safety/mission-critical — with per-component overrides (a `billing/` module inside a C1 tool is C2 or higher). Cite the evidence behind each. In module scope, the module **inherits the parent tier by default**; any override is stated with justification.

**HARD STOP.** Confirm the reconciled system map and tier. They decide which behaviors and failure modes are in scope, coverage depth per risk tier, how heavy the LLM eval program needs to be, which layer-5 obligations apply, and whether a human-judged work product creates a layer-6 obligation (Phase 6).

## Phase 2 — Invariants

Run the concept loop. Primer: `references/concept-primers.md#invariants`. Beat-3 prompts and beat-4 probes: `references/question-bank.md`.

Categories to cover in beat 4 if the human's own thinking didn't reach them: money and irreversible actions, state machines and legal transitions, resource conservation, uniqueness and mapping, ordering and idempotency, tenancy and authorization.

Per accepted invariant:

- Apply the falsifiability gate; rewrite until it passes or discard.
- Classify enforcement: **test-enforced**, **runtime-guardrail-enforced** (fail-closed), or both. Anything an LLM or external system could violate at runtime must have a guardrail (rule 5).
- Sketch two or three violation paths — enough to confirm the statement is falsifiable and that the human recognises the failure as one worth preventing. These are a **sanity check on the statement, not the case list.** Label them as such and do not let the human ratify them as complete.
- In module scope, mark each as new, or as a tightening of a named parent invariant.

**Do not derive the invariant's violation surface here.** The exhaustive derivation is a source-grounded, agent-alone act and belongs in Phase 6 (Division of labor step 6). Deriving it in this phase — inside a human-elicitation loop, before the code has been walked — produces a list bounded by what the human could recall in one sitting, which is the single most common way a harness ends up with a small, plausible, and radically incomplete case surface under a critical invariant. The human's irreplaceable contribution is the **statement** and its **consequence tier**; enumerating the ways the code can make it false is combinatorial recall over the source and is not where human attention pays.

Target 5–15 invariants for a large product, 3–8 for a module. Completeness means covering the credible consequence classes exposed by the system map, not maximizing the count. More usually means contracts are masquerading as invariants; push them down to Phase 4. The sorting test: a statement that names a specific operation is that operation's *contract*; a property that must survive *every* operation is an invariant. Smallness is not a style choice — the invariant list is the compression the human can hold in their head and the agent re-checks after every change; completeness lives in the contracts.

## Phase 3 — Boundary map

Run the concept loop. Primer: `references/concept-primers.md#boundaries`.

A boundary exists wherever **ownership of state, consistency guarantees, or failure domain changes** — boundaries fall out of the structural view, not interface names or testing convenience. Overlay the behavioral view afterward to show which journeys cross each seam. Apply the boundary test (rule 4) to each. In module scope, enumerate the parent seam first.

For every confirmed boundary, enumerate failure modes explicitly: timeout, partial success, retry, duplicate delivery, stale read, version skew, crash-mid-step. This checklist is also the mechanical complement to intuition during flow walks — applied at every boundary crossing of every flow, it yields the mid-flow cases (crashed after the write, before the acknowledgment) that journey intuition reliably skips. Layer-2 tests must cover these, not just the happy path — inside a boundary things fail together (test as a block); across it they fail independently. The coverage is a checked model fact, not prose: each declared boundary mode is cited by a covering family's `covers_failure_modes: ["<boundary-id>#<mode>"]` or by a pruned family citing the same reference with its reason — the compiler rejects a boundary mode that is listed, tested nowhere, and pruned nowhere (`references/policy-and-inheritance.md`).

Then apply the **honest-fake test** to each boundary: can it be controlled without lying about its failure modes? Fakeable boundaries anchor layer-2 hermetic coverage — including everything nondeterministic, so clock, randomness, network, environment, and process outcomes are sealed with test doubles too. The verdict is recorded as a per-boundary **honest-fake column** in `boundary-map.md` — the fake decision is an attribute of each boundary, never a separate phase. Specify the success and failure semantics each double must reproduce as first-class scriptable behavior ("this call 500s twice, then succeeds") plus the real behaviors it cannot prove — a fake that only returns success proves the system works against a world that doesn't exist, and every unproven real behavior retains a named live-sandbox obligation (rule 15). Guard against drift: one conformance suite runs against both the fake and the real dependency — routinely against the fake, periodically against the real thing — so the fake cannot silently diverge from the vendor. Unfakeable seams (vendor auth handshakes, CI, OS schedulers, vendor behavior that has burned you before) become layer-3 obligations, each with a named disposable target and a spend bound; a layer-3 seam with no disposable target is an architecture finding, not a smaller test.

Output: `boundary-map.md` with a Mermaid diagram, journey intersections, the per-boundary failure-mode list, the honest-fake column carrying each controlled-seam specification and its unproven real semantics, and each boundary's layer placement (hermetic vs live-sandbox). Record unanswered boundary tests as architecture findings.

## Phase 4 — Contracts and acceptance criteria

Run the concept loop. Primer: `references/concept-primers.md#contracts`.

Per boundary, capture the contract: valid inputs, guaranteed outputs, error behavior, idempotency semantics, ordering/latency expectations. Layer-1 scope = a component honoring its own contract; layer-2 scope = two components' assumptions about each other's contracts actually matching, including the Phase-3 failure modes. The error half is a checked model fact, not prose: contract structures declare `error_criteria` (invalid-input behavior, typed errors, idempotency under retry) beside `acceptance_criteria`, and the compiler rejects a happy-path-only contract (`references/policy-and-inheritance.md`).

Per user journey, write acceptance criteria as given/when/then at the **behavior** level, not the UI level, each tracing to at least one invariant or contract. These are ticket-shaped: they travel with the feature spec and are written before implementation.

Where several entry surfaces expose one behavior, write the core operation's contract once and validate it at the lowest sufficient layer; each CLI/API/UI/MCP or event adapter gets a focused conformance obligation — parsing, auth, serialization, error mapping, exit codes — plus one cross-surface agreement check that all adapters expose the same operations with the same semantics (Division of labor). Do not clone the full behavioral suite under every interface.

Contracts need numbers — timeouts, freshness windows, retry budgets, latency bounds. Where no ratified value exists, do not park the parameter as `OPEN`: an `OPEN` tolerance makes the contract untestable and stalls every case derived from it. Reserve `OPEN` for parameters whose *semantics* are undecided; for values merely awaiting tuning, propose a provisional default, label it `PROPOSED`, and record it in the policy file with an owner and an expiry (the waiver shape — `references/policy-and-inheritance.md`). Tests assert the provisional value; an expired provisional is an active finding, so the number cannot silently fossilize.

## Phase 5 — LLM call sites (skip if there are none)

Run the concept loop over the two-layer split. Primer: `references/concept-primers.md#llm-eval-layers`; details and templates in `references/llm-eval-patterns.md`.

Inventory every call site by role (planner, reviewer, summarizer, judge) — each gets its own plan, because "good output" differs per role. Per site:

- **Contract layer — deterministic, classic harness (lands in layers 1–2).** Schema/enum/field validity, token and latency budgets, and the surrounding code (retry on malformed output, fallback, budget accounting) tested with a mocked LLM — the provider is a boundary like any external API. Runs every commit, binary pass/fail.
- **Quality layer — statistical evals (the layer-4 lane).** A committed golden set per call site with a rubric and threshold ("≥90% acceptable on the 40 golden tasks, N≥3 runs each"). Single-run green is meaningless under non-determinism. Layer 4 sits beside layers 1–3 for every model-touching surface — it never substitutes for them; the envelope is tested deterministically even when the judgment inside it is evaluated statistically.

Additional obligations:

- **Judge calibration.** Any LLM-judging-LLM site requires a meta-eval: seeded-defect sets measuring catch rate and false-positive rate. An uncalibrated judge silently corrupts every downstream metric.
- **Trajectory evals for agentic loops.** Score the path, not just the destination: tool calls legal and sensible, step/token budget respected, no loops, escalated when required. Cheap version first — deterministic assertions over run telemetry.
- **Trust boundary.** Agent self-reported success signals are advisory only; they never feed promotion, canary, or quality metrics.
- **Model-swap harness.** The golden set *is* the swap regression suite; a provider or model change is acceptable iff the eval-suite delta is within threshold. No golden set → no swappability.
- **CI cost tiering.** Contract layer per commit; quality evals on prompt change, model change, and nightly; meta-evals on judge change. Record the tiering in the policy file so nobody "saves money" by silently skipping evals.

## Phase 6 — Risk tiers and coverage allocation

Run the concept loop. Primer: `references/concept-primers.md#risk-tiers`.

Build a probability × cost matrix over journeys and modules. Money paths and irreversible actions get exhaustive coverage; low-stakes surfaces get smoke tests. Nobody tests everything equally — make the allocation explicit and intentional, and state it **per layer**: which journeys get layer-2 depth, which seams get layer-3 runs, where scale testing applies (driven by the Phase-1 deployment shape: load-test the contention point, e.g. one hot SKU in a flash sale, not raw uniform throughput).

**Assign an execution lane per case family, not per layer.** The layer says *what a check can falsify*; the lane says *when it runs*, and the two are not the same question. Attach one of these to every family, with the layer supplying the default and any deviation carrying a reason:

| Lane | What it is | Default layers |
|---|---|---|
| `inner-loop` | what a developer or coding agent runs *before* pushing — the lane that decides whether the harness gets used or routed around | fast subset of 1–2 |
| `per-commit` | the blocking CI gate | 1–2 |
| `triggered` | run on an explicit condition (changed adapter, prompt/model change, or an individually authorized outcome campaign) | 3–4; 6 only with per-campaign human authorization |
| `release` | required before shipping a candidate | 3–4, plus any release-gating obligation |
| `scheduled` | recurring, calendar- or cadence-driven | 5 |

The `inner-loop` lane is the one most often left undesigned, and its absence is expensive: if the pre-push command is slow, or nobody names one, developers and agents discover the harness at CI time and start working around it. Name the actual command. Lanes land in `model/policy.yaml` and each family selects one by ID. Every active test lane also declares its wall-clock budget as `max_duration_seconds` (suggested starting points: ~2 minutes for `inner-loop`, ~10 minutes for `per-commit`; tune to the product, never omit) — **a breached budget is a defect against the harness, filed like any red**, not an inconvenience to wait out, because a slow lane is a lane that gets skipped.

This phase also fixes the **layer-5 obligations**, gated by the Phase-1 tier and deployment shape:

- **C2 and above:** a threat model and a scale test at the contention point.
- **Any always-on or autonomous deployment shape:** soak — state growth under retention, missed-tick/clock-skew reconciliation after sleep, cost integrity under retries and provider partials. Multi-day where the failure mode is cumulative; microbenchmarks prove nothing here.
- Each obligation lands in the policy file as a scheduled, owned entry — an aspiration without an owner and a trigger is a silent absence.

It also fixes the **layer-6 lane**, which is declared empty with a reason or specified in full. Ask the outcome question first — *given realistic input, would a human accept what this produces?* — and if the product has one, the lane owes ten things:

1. **A ratified rubric.** Human-authored, tighten-only, naming its scored axes. It may legitimately declare **no threshold**; when it does, every threshold-dependent verdict is `inconclusive` and may never be reported as pass or fail. The agent may propose axes; ratification is a hard stop and never the agent's.
2. **Realistic input as a controlled variable.** Scenario inputs are messy human input carrying planted ambiguities and contradictions whose *resolution* is what gets scored — never clean specifications, which measure transcription rather than judgment. Declare the input fidelity and hold it constant across runs, or results are not comparable between them.
3. **A sealed answer key.** Planted content must be unreachable both by the system under test and through the grader's input path, by construction rather than by convention.
4. **Grader independence, enforced in code, per axis.** For every scored axis the grader is disjoint from every producer whose output that axis reads. Each axis's read set is declared *before* construction and is what the disjointness check runs against.
5. **The self-report rule.** The system's own account of its work — status claims, summaries, PR bodies, step narration — is the **subject** of a claim-honesty axis, never **evidence** for the axes that axis audits. Without this, an agentic system grades itself through the back door.
6. **Campaign invariants, in their own registry.** Properties that protect the *measurement* rather than the product: violating one does not break the product, it voids the run while the run still emits a plausible-looking score. Keep them in a separate registry so a later audit can never read a harness promise as a product promise, and land each at layer 1/2 with a negative control (rule: guardrails are not lane work).
7. **Staged arms with an intermediate gate.** Grade the cheap artifact before spending on the expensive one, and record the gate's resolution durably *before* any downstream spend. A campaign that stops at the gate is a **complete** campaign, not a failed one. If the gate can resolve unattended, the policy declares how — silence is not consent.
8. **Preflight refusals**, every precondition checked pre-mutation and pre-spend, including that the campaign exercises the artifact the product actually ships rather than a working copy.
9. **A declared release relationship** — whether layer 6 gates release, or is disclosed assurance sitting outside the release gate whose bad result is information for the human rather than a mechanical block. Either is valid; leaving it unstated is not.
10. **Hard boundaries.** No irreversible external effect inside a campaign; the product's own repository is never the sandbox target; and ceiling exhaustion, a skipped scenario, a missing grader run, or an unratified threshold each produce `incomplete`/`inconclusive` — never green.

Spend is bounded per campaign by an explicit human authorization, not by a standing global ceiling, and exhaustion of that bound is an `incomplete` result rather than a truncated pass.

**HARD STOP.** The human confirms the weighting and layer-5 obligations; when `L-ACC` is active, the human also ratifies the rubric, campaign authorization shape, and release relationship (rule 7).

### Case derivation grammar

After risk confirmation, derive case families mechanically rather than brainstorming from a blank page:

| Source artifact | Derive |
|---|---|
| Journey | success, refusal, interruption, recovery, alternative initiators and observations |
| State machine | every legal transition, every illegal transition, replay, and crash point |
| Invariant | every credible violation path and the guardrail response |
| Boundary | success, timeout, partial success, retry, duplicate, stale read, and version skew |
| Contract | valid and invalid inputs, outputs, typed errors, idempotency, ordering, freshness, and latency |
| Interface adapter | conformance to the shared underlying behavior, including error translation |
| LLM call site | deterministic envelope, statistical quality, trajectory, and judge calibration as applicable |
| Operational obligation | load at the contention point, soak, resource growth, clock skew, abuse, and recovery |
| Outcome-acceptance scenario | realistic-input variants, every ratified rubric axis, intermediate-gate stop, sealed-plant and independence guardrails, and every incomplete/inconclusive terminal |

Rows come from the stimulus taxonomy (Division of labor): user events and time events enumerate the journeys; adversity is applied at every flow step through the Phase-3 failure-mode checklist, never enumerated as rows of its own. Risk prunes this matrix; do not exercise the full Cartesian product. Once the source artifacts and expected outcomes are ratified, let the agent generate and maintain traced cases with high autonomy (Division of labor steps 5–6). Return any unknown expected outcome to the human.

### Deriving an invariant's violation surface

The `Invariant → every credible violation path` row is the one that most often gets under-derived, because "credible" is read as "what comes to mind." It doesn't mean that. Derive it **from the source, not from recall**, and produce it as three artifacts.

**First, choose the counting unit — and defend it.** Before enumerating anything, state in two or three sentences what *one case* means for this invariant, and name the alternative decomposition you rejected and why. The unit differs per invariant and choosing it wrongly is how a case list becomes either bloated or blind. A permission invariant counts by **channel** (a distinct route by which influenceable content reaches the decision) and treats spellings of the same channel as routes inside one case. A durable-write invariant counts by **commit protocol × the reader or reconciler that must classify it**, with crash points parameterized inside one family. The general test, when neither fits: *two situations are one case if a single guard in a single place would correctly address both; they are two if each needs its own guard, or if one could be fixed while the other silently stays broken.*

**Second, walk the source to the sink.** Enumerate the concrete substrate the invariant ranges over — every input that reaches the decision, every store that holds the fact, every site that performs the effect — and trace each to the point where the invariant could be made false. Persistent inputs, command and environment inputs, remote state, model-produced artifacts, adapter and hook seams, and every write/read pair are all substrate. Recall produces the ones you have already thought about; the walk produces the rest.

**Third, close over the substrate — the inventory.** Emit a table of *every* element found, whether or not it became a case, and disposition each one: it maps to a named case family, or it is **safe by construction and you say how** ("atomic replace", "enumeration keys only off the committed record", "reaches only optional context, never the authority slice"). An element you cannot place in either column is a finding, not an omission. This inventory is the bottom-up completeness check on a top-down matrix, and it is what catches the substrate nobody thought to ask about. If the inventory for a single invariant is larger than the human can review in one sitting, that is a **decomposition signal** — see Phase 0's module map.

**Coverage verdicts carry a mechanism and a considered-flag.** When the derivation records whether a guard already exists, three verdicts are legal, and a bare "no guard" is not one of them:

- **enforced** — and you **name the mechanism** (atomic write, reader validation, journal reconciliation, classifier rule). If you cannot name it, the verdict is `unclear`, never `enforced`.
- **unclear** — the code detects the condition but you found no path that resolves it, or you could not determine the mechanism.
- **no-guard-found** — and this one carries a second field: does the source show the tradeoff was **considered** (an adjacent comment, a defect reference, a design-doc line) or not? A deliberate documented tradeoff and an oversight look identical in a bare gap list, and only one of them is actionable without the owner. Report the deliberate ones as **product-truth findings for ratification**, never as defects.

**Derivation and implementation are separate acts with separate gates.** Deriving validation families in `model/families.yaml` is design work: it needs no fixtures, no code, and no external authorization, and it completes *inside this campaign*. Derivation is done at **matrix closure**: every source-structure × derivation-row cell maps to a family or a named pruning reason. *Implementing* families as executable checks is build work, gated per lane by the walking skeleton. Freezing derivation behind implementation conditions is a design defect.

**Authoritative family model.** Record each family once in `model/families.yaml`, with structure links, meaning, provenance, owner, lane, layer, oracle, risk, status, negative controls, owning ticket, and planned test or evidence declaration. `case-catalog.md` is generated from these facts. Do not emit or accept a separately maintained `case-catalog.yaml`; old catalogs enter only through the explicit legacy importer.

**Non-test-lane evidence declarations.** A family whose oracle lives outside the test tree records `evidence: {state, path}` in `model/families.yaml`, where state is `complete`, `incomplete`, `inconclusive`, or `unobserved` and path is repository-relative. Anything other than `complete` is visible declared partiality, never green-by-assertion. An ordinary test-lane family still requires planned tests and later citing specs; evidence cannot substitute for them.

## Phase 7 — Tooling selection

Present a tooling menu per layer — invariant/contract runner, hermetic fixture strategy, live-sandbox targets, eval framework, ops-hardening tools, outcome-acceptance campaign runner/instrument, CI host — with the tradeoffs that actually differ, not a feature matrix. Menu and selection heuristics: `references/tooling-menu.md`.

In module scope, the parent's existing stack is the default and the burden of proof is on divergence: a module introducing a second runner or a second eval framework must justify it, because it doubles the CI surface a future audit has to reason about.

Under `parallel-greenfield`, select tooling and commands that stay inside the isolated root. Define migration equivalence and rollback criteria now, but do not switch incumbent commands or required gates.

**HARD STOP.** The human selects. Record the selection and the rejected alternatives with reasons in the policy file — the reasons are what make a future revisit cheap.

## Phase 8 — Deliverables and adversarial review

Produce, as Git-trackable files:

1. `system-map.md` — behavioral view, structural view, reconciliation table, supported entry/observation surfaces, intended use, deployment shape, criticality, and open product-truth/architecture findings.
2. `invariants.md` — falsifiable statements with namespaced IDs, enforcement classification, adversarial seed cases, inherited-vs-new marking.
3. `boundary-map.md` — Mermaid diagram + journey intersections + per-boundary failure modes + honest-fake column with controlled-seam specification + unproven real semantics + layer placement + open architecture findings. Parent seam first in module scope.
4. `contracts/` — one file per boundary; acceptance criteria embedded in journey tickets.
5. `llm-eval-plan.md` + `golden-sets/` scaffolds (empty sets with rubric and threshold headers count — the commitment precedes the content).
5b. `acceptance/` — only when layer 6 is non-empty: the ratified rubric (axes, scoring, the intermediate gate's criteria, and explicitly whether any threshold exists), the scenario briefs in their realistic-input form, the sealed-plant policy, and the campaign-invariant registry kept separate from the product invariants. The rubric is a **human artifact**: propose axes, never ratify them.
6. `model/` — all eight required logical YAML files: `project.yaml`, `owners.yaml`, `sources.yaml`, `structures.yaml`, `policy.yaml`, `controls.yaml`, `families.yaml`, and `backlog.yaml`. This checked graph is the sole machine authority. Layout and inheritance semantics: `references/policy-and-inheritance.md`.
7. Compiler-generated `case-catalog.md`, `harness-backlog.md`, `owner-briefing.md`, `owner-backlog.md`, `planned-trace.md`, and `compiler-report.json`. Never hand-edit them. When `L-ACC` is active, model structures and families trace scenarios, rubric axes, campaign guardrails, gate stops, and incomplete/inconclusive terminals back to authored `acceptance/` rationale.

8. `harness-backlog.md` — ticket-shaped, starting with the walking skeleton: a trivial end-to-end flow through real CI carrying one layer-1 invariant/contract test, one layer-2 hermetic composition test (including one boundary failure mode), one journey test (layer 2 by default; a layer-3 sandbox smoke where an unfakeable seam exists) — that journey is the designated smoke journey: name it in `policy.yaml` `smoke_journey_ids`, covered by an implementable per-commit family, or the model does not compile (`references/policy-and-inheritance.md`) — and one LLM contract test if applicable — each skeleton test paired with its negative control (rule 16), plus the harness's own self-tests (rule 17) and, under `parallel-greenfield`, the additive CI lane over the isolated root. The skeleton — including the honest fakes it exercises — lands *before* mass case implementation (Division of labor step 5): cases *implemented* before the fixtures exist get written to what is convenient to test rather than what the contracts require; catalog *derivation* is never deferred (Phase 6). **Expansion gates are scoped per layer:** a layer's implementation tickets are gated only on that layer's own skeleton and fixtures — a missing live target, an unpassed eval threshold, or unauthorized CI parks only its own layer's tickets, never layer-1/2 implementation. A gate that references conditions outside the layer it gates is a design defect. Every ticket has acceptance criteria, the invariant/contract it defends, its layer, and a named executor (human, standing coding agent, or scheduled build campaign) — a backlog without owners is a designed stall. Under `parallel-greenfield`, include migration equivalence, rollback, and explicit cutover tickets; none execute implicitly.
When layer 6 is active, the backlog's walking skeleton also lands the rubric/scenario loaders, sealed-answer and grader-independence preflights, intermediate-gate persistence, and incomplete/inconclusive terminals. Their mechanical detectors live at layers 1–2; the live scored campaign remains triggered-only and requires explicit per-campaign authorization.

9. `elicitation-log.md` — the human's raw thinking per concept, with what was dropped and why.
10. `agents-md-contribution.md` — a proposed standing-instructions section routing coding agents to the compiled model and generated views. A feature change starts from affected product structures and deposits cases at the cheapest layer; every bug fix deposits its detector; gates and golden sets are never weakened; generated files are never hand-edited; and structural mismatch re-enters `harness-revision` mode.
11. `owner-briefing.md` and `owner-backlog.md` — compiler-generated, non-authoritative owner projections. Their fixed shapes remain part of the reader test, but their facts come only from the model.

**Adversarial review (final hard stop).** Before acceptance, the environment compiles an ephemeral reader bundle containing only the five generated Markdown projections, `compiler-report.json`, and a bundle identity manifest. Fresh readers cannot inspect YAML source, authored rationale, product docs, rambling, or campaign history. Simulate a production operator, a new engineer, and a coding agent against that bundle. Can they map product meaning through structures, families, controls, owners, tickets, planned implementation, and executable lanes without inventing behavior? Can they distinguish deterministic from statistical evidence, see every declared absence and unresolved mapping, and know what to do next? Gaps become findings; revise model facts and recompile. The owner projections remain individually usable: an exhausted owner who has only `owner-briefing.md` must be able to ratify, and an owner tracking progress who has only `owner-backlog.md` must be able to follow along.

## Ongoing case sourcing (for the life of the product)

Four channels, recorded in the policy file as standing obligations:

1. **Acceptance criteria** as each feature lands.
2. **Adversarial derivation** from invariants — the Phase-6 violation-surface walk, re-run against the source as the system evolves. Not a recall exercise.
3. **Production incidents** — every bug becomes a regression test; every bad LLM output in prod becomes a golden case. Non-negotiable.
4. **Substrate drift.** When a **new instance of a class the harness already reasons about** appears — another provider adapter, another durable store, another entry surface, another effect site — every invariant inventory that ranges over that class is re-derived, and any enumerating guard (an allow-list, a path regex, a matcher) is re-checked against the new member in the same change. This channel exists because a case list frozen at ratification cannot see drift by construction: the code grew a new member, the enumeration did not follow, and nothing was ever red. Channels 1–3 all wait for a human or an incident to notice; this one is triggered by the shape of the change itself, and it is the only channel that catches a guard going quietly stale.

The four channels only fire if the coding agents working in the repo are routed to these artifacts — that routing is the `agents-md-contribution.md` deliverable (Phase 8), and it must be kept current as artifact locations move. Apply the case derivation grammar whenever a journey, state machine, interface, boundary, or contract changes. The evidence-deposit layer rule applies across all four channels: any deterministic defect surfaced by a layer-3 run or a layer-4 campaign deposits its layer-1/2 detector in the same change. Case sourcing handles growth; when the *structure* no longer fits — the system map or boundary map contradicts the architecture, a lane is mis-placed — re-enter this skill in `harness-revision` mode rather than piling cases onto a wrong shape.

The evidence-deposit rule also applies to a deterministic defect exposed during a layer-6 campaign: its mechanical detector lands at layer 1/2 in the same change. A poor rubric score is not itself deterministic and instead grows the realistic scenario/rubric corpus through human ratification.

## Relationship to validation-harness-audit

Design → build → audit → revise is one loop. This skill produces the checked design model plus authored rationale and golden sets. validation-harness-audit later compiles that model, joins the observed test inventory and exact-revision evidence, measures conformance, and issues a scoped verdict. The generated policy and family views are its diff surface: an undeclared-absent lane is a finding, a declared-empty lane is a decision. Case-level gaps land in hardening; structural findings re-enter this skill in `harness-revision` mode.

The durable design contract consumed by the audit is the compiler-clean model identity plus its generated views and authored rationale. Test inventory and run evidence are joined later and retain their own identities.

## Reference files

- `references/concept-primers.md` — layer taxonomy, system mapping, and per-concept frames, canonical cross-domain examples, grounding heuristics, common confusions, acceptance gates. **Read the system-mapping and layer-taxonomy entries before Phase 1, and the relevant entry before beat 1 of every later concept.**
- `references/question-bank.md` — beat-3 elicitation openers and beat-4 gap-closing probes per phase, plus scope/inheritance questions.
- `references/llm-eval-patterns.md` — golden-set format, rubric template, judge meta-eval design, trajectory assertions, CI tiering table. Read during Phase 5.
- `references/policy-and-inheritance.md` — policy file layout, `extends:` semantics, resolution order, tighten-only rule. Read during Phase 0 (module scope) and Phase 8.
- `references/tooling-menu.md` — tooling options per layer with selection heuristics. Read during Phase 7.

Used without the bundled files (as a bare prompt), this document is self-sufficient: derive the primers, question patterns, and templates from the phase descriptions above, and state your derived formats explicitly in the deliverables.
