# Validation Harness Design

A reusable Agent Skill for designing — and redesigning — the validation surface of a product or module **at design time**: before code exists on first entry, and re-entered whenever the architecture moves or the harness itself proves wrongly shaped.

Machine facts live once in the versioned, compiler-checked YAML files under `validation-design/model/`. Catalog, backlog, owner, and planned-trace Markdown are deterministic projections. Narrative rationale and golden sets remain authored artifacts; the actual test inventory and exact-revision evidence remain separate repository facts.

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

1. `model/project.yaml`, `owners.yaml`, `sources.yaml`, `structures.yaml`, `policy.yaml`, `controls.yaml`, `families.yaml`, and `backlog.yaml` — the sole machine authority.
2. Compiler-generated `case-catalog.md`, `harness-backlog.md`, `owner-briefing.md`, `owner-backlog.md`, `planned-trace.md`, and `compiler-report.json`.
3. Authored rationale such as system-map explanation, contract detail, eval/golden-set material, acceptance rubrics, elicitation records, and ratification notes—without duplicate machine-fact tables.
4. `agents-md-contribution.md` — proposed standing instructions that route future coding agents to the model and generated views.

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
