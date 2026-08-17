# Harness Policy Conformance

Read this reference when the repository carries `validation-design/model/` or legacy artifacts produced by **validation-harness-design**. Compile all eight logical YAML files before reading generated views or joining the repository's actual tests.

**Evidence-cited families.** An evidence-lane family records `evidence: {state, path}` in `model/families.yaml`. Confirm the artifact exists, its state is honest, its lane genuinely cannot be asserted from the test tree, and every non-`complete` state remains visible partiality. An ordinary test-lane family still requires a citing spec.

**Intent provenance.** When the campaign host records `derived-from-repo`,
every owner judgment beyond literal docs remains `simulated` and any
`rambling` source is blocking, even if a file appeared later. When it records
`human-rambling`, the file must remain present and every such source must
resolve to an exact location or passage. Never infer a different source from
the filesystem after kickoff.

The compiler-clean model identity is the declared harness. Generated Markdown is navigation, never another authority. Test inventory and exact-revision evidence remain separate inputs. The design skill's `references/policy-and-inheritance.md` owns the producer layout; this file describes the consuming side.

The joined relationship graph uses the single chain `changed path → product
structure → validation family → test → evidence`. Query it in both directions,
keep every unresolved hop and partial evidence state visible, and bind author,
architect, Reviewer, and operator projections to the same graph identity.
Deterministic closure is not oracle fidelity.

Changed-path plans use that graph rather than another mapping authority.
Unknown, uncertain, corrupt, stale, ambiguous, or structural mappings expand to
the full applicable lane; paired negative controls and always-run checks cannot
be pruned. Treat selection as advisory even after zero-miss generated,
historical, corruption-negative, and independently reviewed shadow benchmarks.
The full required CI suite remains authoritative and appears exactly once.

Before interpretation, compare the exact package, method, model, compiler,
policy, result, and golden-set bundle plus source/model identity. Pre-1.0 has no
legacy compatibility promise. On a stable line, ordinary reads accept current
only; the immediately previous major enters solely through a named, reviewed
migration that clones its input and writes a new integrity-bound artifact.
Reject mixed or older bundles, silent read-time mutation, in-place writes,
partial output, failed validation, and hash mismatch before provider work.

## 1. The six-layer taxonomy

Every check the design skill places lands in one of six validation layers, defined by the question each answers — never by the technology inside it:

| # | Layer | Question it answers | Verdict | Spend / side effects | Cadence |
|---|---|---|---|---|---|
| 1 | Invariant / contract | Can the machinery lie? | Deterministic | None | Every commit |
| 2 | Hermetic system | Can composition lie? | Deterministic | None | Every commit |
| 3 | Live system (sandbox) | Can the real world break the seams? | Nondeterministic, binary | Real, bounded, disposable | Pre-merge / pre-release |
| 4 | Eval / qualification | Can the model be wrong while the machinery is right? | Statistical, threshold over N runs | Token cost, separately authorized | Prompt/model change · nightly · release qualification |
| 5 | Ops hardening | Can time, load, or an adversary hurt you? | Mixed | Production-shaped | Pre-GA, then recurring |
| 6 | Outcome acceptance (`L-ACC`) | Given realistic input, is the output work a human would accept? | Multi-axis scored against a ratified rubric; inconclusive by default | Real, bounded by per-campaign human authorization | Triggered only |

"Hermetic" means sealed against **all** nondeterminism — clock, randomness, network — not merely mocked externals; locally controlled real software (a containerized database) can be inside the seal, a vendor API never is. "Sandbox" means everything is real but disposable and spend-bounded.

Layers 1-5 all have mechanical oracles; layer 6's oracle is a human-ratified rubric, which is why a scored outcome cannot be folded into a pass/fail lane. Layer 6 is also the lane most often silently absent — a harness can conform across layers 1-5 and still have no answer to whether the output is any good.

The six layer rules the audit enforces:

1. **Prove it a layer down.** A check placed at an expensive layer that a cheaper layer could falsify is a placement finding.
2. **Lanes may be empty, never silently absent.** A declared-empty lane with a reason is a decision; an undeclared-absent lane is a finding.
3. **Evidence is not a regression suite.** A green live run or eval campaign proves that run. Every deterministic defect it surfaced must have deposited a layer-1/2 detector in the same change.
4. **Security is split.** Security invariants (tenancy, authorization, deny-by-default) are layer-1 content from day one; layer 5 holds the assurance half (threat model, secret handling, abuse surfaces).
5. **Guardrails are not lane work.** Anything about a layer-6 campaign that a scan, a set comparison, or an exit status can falsify belongs at layer 1/2 with a negative control. A scored axis in the lane that a mechanical check could have settled is a placement finding.
6. **The instrument is measured a layer down.** A layer-6 grader's quality is a layer-4 judge-calibration site. An uncalibrated grader emitting a score is a blocking finding.

## 2. What each artifact is

- `model/project.yaml` records intended use, criticality with rationale, product revision, and package/method/schema versions.
- `owners.yaml` and `sources.yaml` make responsibility and provenance explicit; a `finding` source (VA-ENF-007) records a manual/exploratory finding with its issue locator and exact triggering input, and a fix ticket citing it via `finding_ref` must own the family it deposits.
- `structures.yaml` holds namespaced journeys, invariants, boundaries, contracts, interfaces, model sites, and operations with their protected meaning.
- `policy.yaml` declares all six layers, executable test/evidence lanes and triggers, exceptions, and optional coexistence constraints under fail-closed, tighten-only semantics.
- `controls.yaml`, `families.yaml`, and `backlog.yaml` link red-capable controls, traced obligations, planned tests/evidence, status, ownership, and implementation order.
- `case-catalog.md`, `harness-backlog.md`, `owner-briefing.md`, `owner-backlog.md`, and `planned-trace.md` are compiler projections. `compiler-report.json` binds them to one model identity.
- Authored rationale, golden sets, `acceptance/`, and agent instructions may supplement the graph but must not duplicate its fact tables.
- The observed test inventory and run evidence are repository facts joined after compilation; they never rewrite model status or meaning.

## 3. Policy semantics the audit must honor

- **Inheritance.** Modules reference parent structure IDs rather than restating them. Any cross-model resolution is explicit and versioned.
- **Tighten-only.** A module may add obligations, activate a lane, or strengthen coverage; it may never remove or weaken an inherited obligation.
- **Exceptions expire.** Any waiver or provisional value lives as an owned, reasoned, expiring model fact. Silence is never a waiver, and `OPEN` is not a substitute for a testable provisional.
- **Fail-closed.** Unknown, missing, or unresolved policy facts block compilation or conformance; they do not become optional work.
- **ID stability.** Claim IDs in the audit's traceability matrix reuse the design artifacts' namespaced IDs. Do not mint a parallel ID space for claims the design already names; new claims the design missed get new IDs in the audit's own namespace and are reported back as candidate design additions.
- **Coexistence (`parallel-greenfield`).** When the policy declares a `coexistence:` block, its `isolated_root` is the only writable harness location and the `protected_paths` plus incumbent gates are read-only — for this skill's `harden` mode too. `ci_integration: additive_opt_in` forbids redirecting existing required commands or gates; it constrains integration with the incumbent's pipelines only — the isolated root's own additive CI lane is walking-skeleton scope, and its absence is a finding. Cutover is a separate human-ratified change that must satisfy every declared `cutover_requires` item (equivalence evidence, rollback plan, ratification). Any weakening, deletion, or redirection of an incumbent gate before ratified cutover is a finding; so is an executed cutover missing its declared evidence.

## 4. Conformance checklist

Run these checks in Phase 4 whenever the artifacts exist; each failure is a finding with normal severity mapping:

1. **Layer and lane presence.** Every one of the six layers and five execution lanes is active with obligations or declared empty with a reason. The inner loop is an active test lane with an actual command. Undeclared absence is a finding. The policy also names its smoke journey (`smoke_journey_ids`, deterministic since VA-ENF-003: a journey structure covered by an implementable per-commit family); audit the reality half — that the designated journey's family actually runs on merge in CI and stays green, and that the designated path is still the product's real first-value walk.
2. **Gate reality.** Every gate the policy marks blocking actually blocks in CI at the declared frequency, on the audited revision. Compare policy against actual CI configuration and recent runs, not against intention. Compare each lane's declared `max_duration_seconds` budget against observed CI durations on recent runs: a breached budget is a finding against the harness (VA-ENF-004), exactly like a red — a lane that overruns its budget is a lane that gets skipped or routed around.
3. **Frequency drift.** Declared cadences (per-commit, prompt-change, nightly, pre-release) match what actually triggers. A nightly eval that has not run in a month is a finding even if its config exists.
4. **Invariant enforcement.** Each non-retired invariant has its classified enforcement in place: a test that would fail on violation, a fail-closed runtime guardrail, or both. An invariant enforceable only by model goodwill is a finding. For contracts, the declaration half is deterministic since VA-ENF-005 — the compiler rejects a contract without typed `error_criteria` — so audit the reality half: whether each declared error clause (invalid input, typed error, idempotency under retry) is actually exercised by a family's tests.
5. **Boundary coverage.** Each boundary's enumerated failure modes — including crash-mid-step — have layer-2 coverage; each unfakeable seam has its named disposable layer-3 target and spend bound. The declaration half is deterministic since VA-ENF-001: the compiler rejects a boundary mode with no `covers_failure_modes` citation and no named prune (`MODEL_FAILURE_MODE_UNCOVERED`), and the generated `planned-trace.md` coverage table shows what covers or prunes each mode. Audit what the compiler cannot see: whether the citing family's tests genuinely exercise the cited mode, and whether prune reasons still hold.
6. **Evidence-deposit rule.** Sample defects surfaced by layer-3/4 runs and confirm a layer-1/2 detector landed in the same change.
7. **Eval discipline.** Golden sets committed before prompt tuning (check history), thresholds stated over N runs, judge meta-evals present for LLM-judging-LLM sites, model-swap deltas gated on the golden set.
8. **Tighten-only and waivers.** No module loosens an inherited requirement; all waivers are owned and unexpired.
9. **Tier map honesty.** The policy's declared tiers still match the system's actual deployment shape, data, and privileges. Challenge, don't inherit blindly.
10. **Staleness.** The system map, boundary map, and invariants still describe the current architecture. Drift here is a structural finding, not a documentation nit.
11. **Honest-fake integrity.** Each fakeable boundary's double reproduces its declared failure semantics as scriptable behavior — a fake that can only return success is a finding — and the fake↔real conformance drift suite exists and has actually run against the real dependency at its declared cadence. Every unproven real behavior in the controlled-seam specification retains its named live-sandbox obligation.
12. **Adapter conformance.** Where several interfaces expose one behavior: the core behavior is validated once at the cheapest falsifying layer, each adapter has focused conformance coverage (parsing, auth, serialization, error mapping, exit codes), and the cross-surface agreement check exists. A full behavioral suite cloned under multiple adapters is a placement finding.
13. **Model-to-inventory traceability.** Join compiled families to the adapter-observed test inventory and diff both directions: unimplemented families are gaps; orphan tests are candidates for reviewed design changes, never silently adopted. Confirm the generated catalog matches the same model identity first.
14. **Agent routing.** The repository's standing agent instructions (`AGENTS.md`, `CLAUDE.md`, or equivalent) route coding agents to the harness artifacts as `agents-md-contribution.md` proposed. A routing section that was designed but never landed is a finding — the ongoing case-sourcing channels cannot fire if the agents doing the work never see the artifacts. The channels themselves are policy data since VA-ENF-006 (`policy.yaml` `sourcing`, all four declared with resolved owners — the compiler enforces the declarations); audit the reality half: the named owners still hold the responsibility, active triggers actually fire (sample a closed incident and confirm its regression test landed before the fix merged), and a declared-empty channel's reason still holds.
15. **Coexistence integrity.** Under a declared `parallel-greenfield` posture: protected paths are untouched, incumbent gates are unredirected and unweakened, CI integration with the incumbent stayed additive and opt-in, the isolated root's own additive CI lane exists and runs, and no cutover occurred without its declared `cutover_requires` evidence (§3).
16. **Derivation closure.** The case catalog reaches matrix closure: every derivation-matrix cell (source artifact × derivation row) carries a traced case or a named risk-pruning reason. A silent empty cell is a finding. An expansion gate that references conditions outside the layer it gates — a catalog or layer-1/2 implementation frozen behind a missing live target, an unpassed eval threshold, or unauthorized CI — is a **structural** finding: the harness has designed itself into a stall.
17. **Negative controls.** Sample detector families and confirm each proves it can fire: a seeded violation (mutated fixture, planted defect, misbehaving double script) that the detector catches, landed red-then-green. A detector with no negative control anywhere in its family is a finding; walking-skeleton tests are not exempt. The cheaper half of this check is deterministic and already fail-closed in `validation-architect check`: a declared control of a landed test-lane family implemented by no inventory test is the red `CONTROL_UNIMPLEMENTED` diagnostic, and the same gap under a pending/blocked/parked owner ticket stays visibly partial (`CONTROL_IMPLEMENTATION_PENDING`). Do not re-derive that closure by hand — audit what the tool cannot see: whether the implemented control genuinely makes the detector fire, and whether evidence-lane controls (which live outside the test inventory) are exercised by their lane's evidence.
18. **Harness self-testing.** The harness's own machinery is under test: fixtures have self-tests, scanners and sweeps fail on an empty walk rather than passing, and policy loaders, CI configuration, and dispatch/registry surfaces are pinned by tests. A load-bearing guard with no test of its own is a finding.
19. **Outcome-acceptance integrity.** For active `L-ACC`: the rubric is human-ratified and tighten-only; every scored row maps to a rubric axis and every mechanical guardrail maps down to a layer-1/2 detector with a negative control; scenario input is realistic and held constant; planted answers are unreachable from producer and grader; per-axis producer↔grader disjointness is enforced in code; self-report is a scored subject, never evidence; campaign invariants are separate from product invariants; the intermediate gate is durably resolved before downstream spend; preflight runs pre-mutation/pre-spend; each live run has fresh human authorization and no irreversible effect; the release relationship is explicit; and ceiling exhaustion, skipped work, missing calibration, or an unratified threshold yields `incomplete` / `inconclusive`, never pass. An uncalibrated grader emitting a score is blocking.
20. **Intent-source integrity.** Apply the recorded kickoff source, not current file presence: `derived-from-repo` admits no `rambling` source and keeps repo-derived owner judgment `simulated`; `human-rambling` requires the file and exact citations. Any switch or laundering is blocking.

## 5. Findings routing

Tag every finding **case-level** or **structural**; the distinction decides where remediation happens.

- **Case-level** — the harness shape is right but incomplete: a missing test, a weak oracle, an uncovered failure mode, a skipped gate, an expired waiver. Remediate in this skill's `harden` mode; traceability ties each fix to its claim ID.
- **Structural** — the declared shape no longer fits reality: the system map or boundary map contradicts the architecture, a lane is mis-placed or wrongly declared empty, invariants describe a system that no longer exists, behavioral suites are cloned under multiple interface adapters instead of validated once, the module policy tree does not match the module tree. Route to validation-harness-design's `harness-revision` mode, which reopens only the affected concepts and records why. Do not remediate structural findings by piling cases onto the wrong shape.

Two prohibitions bind both skills: never rewrite audit corpora or holdouts to match fixes, and never author golden sets after prompt tuning. Either act invalidates the evidence chain it touches.
