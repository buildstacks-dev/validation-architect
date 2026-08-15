---
name: implement-harness-ticket
description: Vendor-neutral workflow for a product repo's coding agent to implement one harness-backlog ticket end to end. Resolve the HB ticket and its CF rows, expand each family's ratified enumeration from invariants, boundary failure modes, contracts, eval plans, or acceptance artifacts, land red-then-green specs with negative controls at the assigned layer, and update traceability in the same change. Use when routed to an HB-* ticket, landing specs against a ratified validation-design corpus, or asked to implement a catalog row. This is the builder's playbook for mechanical closure; validation-harness-design owns new families and validation-harness-audit judges fidelity.
---

# Implement Harness Ticket

**Stance: teach the workflow; the coding agent executes it.** This skill is the building code for harness implementation. It tells *you* — the product repo's coding agent — how to turn one backlog ticket into citing specs. The validation architect ships this skill, the design corpus, and the trace CLI; it **never** writes product or test code as the answer. If you are the architect running a design campaign, stop — use `validation-harness-design` instead. If you are auditing fidelity, stop — use `validation-harness-audit`. Your job here is implementation under ratified design.

## The four-level resolution chain

Every ticket implements **closure over ratified design**, not ad-hoc test ideas. Walk this chain in order; do not skip a level.

| Level | Source | What you resolve |
| --- | --- | --- |
| **1. Ticket** | `model/backlog.yaml` + generated `harness-backlog.md` | The `HB-*` entry: owned families, wave, status, owner, and dependencies. The YAML is authority; Markdown is the readable projection. |
| **2. Family** | `model/families.yaml` + generated `case-catalog.md` | Every `CF-*` ID the ticket owns, with protected meaning, structures, layer, oracle, risk, status, controls, planned tests/evidence, and exclusions. |
| **3. Enumeration** | `model/structures.yaml` plus authored rationale/golden material | The ratified seeds that define case count. Follow each family's structure and provenance IDs to the exact journey, invariant, boundary, contract, interface, model site, operation, or acceptance material. **Never invent cases** — a missing meaning or seed is a design-revision finding. |
| **4. Tests** | Product repo test tree | Spec files at the ticket's assigned layer, each binding one or more enumeration items, each with a real negative control. Directory + header conventions below so `validation-trace` stays green. |

**Case-count rule:** the number of implementable checks is the closure of level 3. A ticket that "feels done" with two tests when the enumeration has seven seeds is not done — it is a fidelity gap waiting for audit.

## Standing rules (bind every ticket)

These apply regardless of product or repo. They are the same discipline the design skill ratified; repeat them here so no ticket bypasses them.

1. **Cheapest falsifying layer.** Land each check at the lowest validation layer that can honestly falsify it (invariant/contract → hermetic system → live sandbox → eval → ops → outcome acceptance). Do not jump to live, eval, or `L-ACC` because it is easier to write. Layer-6 campaign guardrails remain layer-1/2 detectors; only human-rubric axes are layer-6 work.
2. **Red-then-green negative controls.** Every new detector family proves it can fire before it proves the system passes: seed a violation (mutated fixture, planted defect, double scripted to misbehave), expect red, then fix forward to green. A spec that has only ever been green is an assumption.
3. **Non-empty walks.** Scanners, sweeps, and property-test generators must assert they found subjects. An empty walk fails — never passes silently.
4. **Tighten-only.** No ticket weakens a gate, golden set, or oracle to make CI green. Narrowing scope requires a design revision, not a local edit.
5. **No green by absence.** Passing because nothing was exercised, because a stub returned success, or because a lane is undeclared-empty is forbidden. Declared-empty lanes belong in `model/policy.yaml` with a reason.
6. **Detector-deposit for defect fixes.** When implementation fixes a defect surfaced during this ticket, deposit the deterministic detector in the **same change** — the fix without a guard is incomplete.

The compiler-clean model is authoritative. On conflict with a generated view, fix the YAML source and recompile; do not improvise softer rules or patch the projection.

## Traceability conventions

Follow these so the trace CLI closes by construction. They mirror the AGENTS.md contribution block the design campaign emitted.

1. **Keep the model authoritative.** Tests implement family meaning; they do not define it. The repository adapter emits explicit family/control links at the exact revision.
2. **Match planned paths and controls.** Land every planned test/evidence artifact and the declared negative control. Always-run safety checks stay paired in impact advice.
3. **Keep status honest.** Every implementable family must be observed by the modern trace graph before a ticket becomes `landed`; absence is red, and false landed status is a second red.
4. **Update traceability in the same change.** If planned paths, meaning, control links, or status change, update `model/families.yaml`, `controls.yaml`, or `backlog.yaml` and recompile. Never hand-edit generated projections.

If a host still invokes the explicit legacy `--manifest` adapter, retain its
family-named directories and first-comment `CF-*` / `HB-*` citations. Those
tokens are inventory adapter syntax, not design authority.

Example header shape (adapt suffix/path to the repo's test runner):

```typescript
// CF-W01-R — duplicate widget id refuses pre-mutation (HB-001; INV-003 §2.1).
describe("CF-W01-R", () => {
  it("refuses a duplicate widget id", () => { /* … */ });
  it("negative control: seeded duplicate slips past store and detector fires", () => { /* … */ });
});
```

## Structural-change escalation

Stop implementation and escalate when the ticket **requires a shape the ratified corpus does not have**:

- A **new journey**, boundary, invariant, contract clause, or eval scenario that is not already enumerated (or explicitly marked `PROPOSED` / open finding) in the design artifacts.
- Renaming or splitting case families without a reviewed model revision and regenerated views.
- Moving a check to a different validation layer for convenience rather than falsifiability.

That is a **structural change**, not a backlog ticket. Do **not** pile ad-hoc cases onto the wrong shape or silently extend the catalog. Instead:

1. **Re-enter `validation-harness-design` in `harness-revision` mode** (or ask the human to schedule that campaign), **or**
2. **Stop and escalate to the human** with the gap spelled out: what you needed, which artifact lacks it, and which `F-PT-*` / open finding it resembles.

Mechanical closure (`validation-trace` green) is not permission to invent design.

## Corpus layout (where to read)

Standard campaign deliverables live under `validation-design/`:

| Artifact | Role in this workflow |
| --- | --- |
| `model/project.yaml` | Product revision and exact schema/method versions |
| `model/owners.yaml` + `sources.yaml` | Responsibility and provenance |
| `model/structures.yaml` | Journeys, invariants, boundaries, contracts, interfaces, sites, operations |
| `model/policy.yaml` | Fail-closed lanes and tighten-only inheritance |
| `model/controls.yaml` | Negative-control obligations |
| `model/families.yaml` | Authoritative family meaning, links, layer/oracle/risk, status, plans/evidence |
| `model/backlog.yaml` | Authoritative ticket ownership, wave, status, dependencies |
| `case-catalog.md` + `harness-backlog.md` | Generated readable projections |
| `planned-trace.md` + `compiler-report.json` | Generated planned closure and exact model identity |
| `acceptance/` | `L-ACC` rubric, realistic scenario briefs, sealed-plant policy, campaign-invariant registry |
| `agents-md-contribution.md` | Routing + traceability conventions for coding agents |

Owner-facing companions are compiler-generated, non-normative follow-alongs — on disagreement, the YAML model wins.

## Workflow (one ticket)

1. **Select the ticket.** Start from the `HB-*` entry routed to you. Read acceptance criteria, defended IDs, and layer assignment. If status is already `LANDED`, confirm the human intends rework; otherwise prefer pending tickets.
2. **Resolve families.** List every `CF-*` on the ticket. Read each authoritative family row and its generated catalog projection. Respect `pruned` and `blocked` status; implement only implementable rows.
3. **Expand enumerations.** For each family, open the upstream artifact and write down every seed/failure mode/clause you must bind. That list is your case checklist; its length is not negotiable.
4. **Place at layer.** Use the family's assigned layer and oracle from the model. Build hermetic doubles for fakeable layer-2 seams; reserve live/eval for declared evidence lanes. For `L-ACC`, keep scored axes human-rubric based and mechanical guardrails in layers 1–2. Never run a live campaign without explicit per-campaign human authorization.
5. **Land red-then-green.** For each detector family: failing seed → green fix. Include negative-control tests in the same spec file where the design expects them.
6. **Update traceability.** Same change: spec files, directory names, headers, and any affected model planned paths or ticket status. Mark `landed` only when every owned implementable family has citing specs, then recompile all generated views.
7. **Run closure.** Execute `validation-trace` against the repo root (see below). Fix every red before declaring the ticket done. Green closure does not replace fidelity audit — it proves the graph is wired, not that oracles match intent.

For evidence lanes, missing, stopped, stale, or unauthorized work remains
`incomplete` / `inconclusive`; it never becomes pass by omission.

## Verify with `validation-trace`

The architect ships a deterministic, product-agnostic CLI in the `validation-architect` package. Install the version pinned by the delivered enablement bundle as a product-repo dev dependency, then run it from the **product repo** on every harness change; wire the included CI template into the repo's own CI per the campaign's lane config.

```bash
pnpm add --save-dev --save-exact validation-architect@<pinned-version>
pnpm exec validation-trace . \
  --model validation-design/model \
  --tests <tests_root>
```

It fail-closes on:

- **Forward** — implementable family with no observed test/evidence
- **Backward** — inventory cites an unknown family (orphan)
- **Status honesty** — ticket marked `LANDED` but families lack specs
- **Relationship closure** — broken owner/source/control/planned/evidence links or identity mismatch
- **Generated drift** — a projection disagrees with the compiled model identity

Optional: `--out trace-report.md` for the human-facing trace report. Exit code `0` only when all checks pass.

**Boundary:** `validation-trace` proves **closure**, not **fidelity**. Whether your assertion actually falsifies the ratified seed is judgment work for the fidelity audit — still follow the enumeration here so you are not caught narrowing cases silently.

## What not to do

- Do not write tests that cite a `CF-*` ID without implementing its enumeration items.
- Do not mark `LANDED` before specs exist and trace is green.
- Do not add families, seeds, or clauses locally — that is design work.
- Do not weaken policy, delete negative controls, or skip red-then-green to save time.
- Do not treat this skill as permission for the architect persona to implement — the architect teaches and inspects; **you** implement.
