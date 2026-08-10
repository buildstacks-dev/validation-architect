# Validation Harness Design

A reusable Agent Skill for designing — and redesigning — the validation surface of a product or module **at design time**: before code exists on first entry, and re-entered whenever the architecture moves or the harness itself proves wrongly shaped.

The output is not an exhaustive test-case list. It is the set of durable artifacts from which cases are derived for the life of the product: a reconciled system map, falsifiable invariants, a boundary map, per-boundary contracts, LLM eval plans with committed golden sets, outcome-acceptance artifacts when applicable, a risk-weighted allocation across six validation layers, a traced case catalog, a tooling decision, and a machine-readable `validation-policy.yaml` that a later audit can diff conformance against.

## The skill pair

This skill is one half of a lifecycle pair:

- **validation-harness-design** (this skill) — designs the harness that does not exist yet, or reshapes one that no longer fits (`harness-revision` mode).
- **[validation-harness-audit](https://github.com/buildstacks-dev/validation-harness-audit)** — later measures what was actually built against the declared policy and the criticality the system actually carries, and issues a scoped, evidence-backed release verdict.

The loop is **design → build → audit → revise**. The audit routes case-level gaps to its own `harden` mode and structural findings back to this skill's `harness-revision` mode. Both skills share the C0–C4 criticality scale; the audit's `references/criticality-model.md` is the canonical rubric.

## The stance

**Teach, then elicit, then synthesize.** The human is the domain expert, but domain expertise is not fluency in validation vocabulary. Every concept (invariants, boundaries, contracts, eval layers, risk tiers) runs a four-beat loop — frame, ground, elicit, synthesize — so the human's own thinking is the primary input and anything the skill originates is labeled `PROPOSED` and requires confirmation. The human owns product truth and risk acceptance; the agent owns disciplined derivation and returns unknown expected behavior instead of silently inventing it.

Elicitation is differentiated by who holds the knowledge: for concepts that encode business consequence (invariants, risk tiers) the human thinks first and the agent structures; for concepts derivable from written architecture (boundaries, contracts) the agent may draft and the human corrects. The full **Division of labor** protocol in `SKILL.md` runs from joint system-mapping through agent-autonomous case derivation to human spot-review by risk tier — the artifacts are the compression of human judgment; case derivation is decompression.

## Two maps before claims

Before proposing invariants, reconcile:

- the **behavioral view** — actor → stimulus → journey → state transition → effect → observation, including CLI/API/UI/MCP and autonomous entry or observation surfaces; and
- the **structural view** — components → state ownership → dependencies → consistency and independent failure domains.

Interfaces are adapters around behavior, not duplicated behaviors. Journeys reveal which seams are crossed; architecture determines where the seams actually are.

## The six validation layers

Every check the skill designs lands in one of six layers, each defined by the question it answers — never by the technology inside it:

| # | Layer | Question it answers |
|---|---|---|
| 1 | Invariant / contract | Can the machinery lie? |
| 2 | Hermetic system | Can composition lie? |
| 3 | Live system (sandbox) | Can the real world break the seams? |
| 4 | Eval / qualification | Can the model be wrong while the machinery is right? |
| 5 | Ops hardening | Can time, load, or an adversary hurt you? |
| 6 | Outcome acceptance (`L-ACC`) | Given realistic input, is the output work a human would accept? |

Lanes may be declared empty with a reason, never left silently absent. Layer 6 uses a human-ratified rubric and is inconclusive by default; its mechanical campaign guardrails stay at layers 1–2 and its grader is calibrated at layer 4.

## Scope modes

- `product` — whole system, no parent harness.
- `module-of-built-parent` — a subsystem of a product whose harness already exists in code and policy.
- `module-of-designed-parent` — a subsystem of a product whose harness has been designed but not yet built.
- `harness-revision` — surgical re-entry into an existing design because the architecture moved or an audit surfaced structural findings.

Any mode may declare a `parallel-greenfield` coexistence posture: build under one isolated root while incumbent tests, evaluation assets, gates, and CI remain read-only until an explicit, reversible, equivalence-backed cutover.

## Deliverables

1. `system-map.md` — behavioral, structural, and reconciliation views.
2. `invariants.md` — falsifiable, namespaced, enforcement-classified.
3. `boundary-map.md` — seams, journey intersections, failure modes, per-boundary honest-fake column, controlled/live placement.
4. `contracts/` — one file per boundary, plus journey acceptance criteria.
5. `llm-eval-plan.md` + `golden-sets/` scaffolds.
5b. `acceptance/` — for active `L-ACC`: rubric, realistic scenarios, sealed-plant policy, and campaign invariants.
6. `validation-policy.yaml` — the contract a future audit diffs against.
7. `case-catalog.md` + `case-catalog.yaml` — human and machine-readable risk/layer trace surfaces.
8. `harness-backlog.md` — ticket-shaped, starting with the walking skeleton.
9. `elicitation-log.md` — provenance of every accepted item.
9b. `harness-state.yaml` — machine-written source revision, staleness, inventory, and ratification state.
10. `agents-md-contribution.md` — a proposed `AGENTS.md`/`CLAUDE.md` section that routes every future coding agent to these artifacts: consult contracts and acceptance criteria on feature changes, deposit cases per the derivation grammar, never weaken a gate, re-enter `harness-revision` on structural mismatch.
11. `owner-briefing.md` + `owner-backlog.md` — non-normative owner-facing ratification and progress companions.

## Files

```text
validation-harness-design/
├── SKILL.md
└── references/
    ├── concept-primers.md
    ├── question-bank.md
    ├── llm-eval-patterns.md
    ├── policy-and-inheritance.md
    └── tooling-menu.md
```

## Install for Claude Code

Repository-scoped:

```bash
mkdir -p .claude/skills
git clone https://github.com/buildstacks-dev/validation-harness-design \
  .claude/skills/validation-harness-design
```

User-scoped:

```bash
mkdir -p ~/.claude/skills
git clone https://github.com/buildstacks-dev/validation-harness-design \
  ~/.claude/skills/validation-harness-design
```

Invoke with:

```text
/validation-harness-design
```

## Install for Codex

```bash
mkdir -p .agents/skills   # or ~/.agents/skills for user scope
cp -R /path/to/validation-harness-design .agents/skills/validation-harness-design
```

Invoke explicitly with a prompt such as:

```text
Use $validation-harness-design. Design the validation harness for the learning-loop module of this product.
```

## Invocation examples

- `Use $validation-harness-design. We're starting a new multi-tenant billing service — design the harness before we write code.`
- `Use $validation-harness-design in module-of-built-parent scope for the new scheduler subsystem.`
- `Use $validation-harness-design in harness-revision mode. The audit flagged the boundary map as stale after the queue migration.`
- `How should I test this agentic system? What evals do I need?`

## Standalone use

`SKILL.md` is self-sufficient as a bare prompt: without the bundled reference files, the skill derives primers, question patterns, and templates from the phase descriptions and states the derived formats explicitly in the deliverables.
