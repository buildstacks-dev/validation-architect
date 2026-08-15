# Checked policy and inheritance

Read during Phase 0 (module scope) and Phase 8 (all scopes).

The sole machine authority is the complete logical YAML set under
`validation-design/model/`. Policy is one part of that graph, not a separate
document with pointers to separately maintained catalogs.

## Required files

```text
validation-design/model/
  project.yaml       # product revision and exact package/method/schema versions
  owners.yaml        # stable owners and responsibilities
  sources.yaml       # doc, rambling, simulated, and proposed provenance
  structures.yaml    # journeys, invariants, boundaries, contracts, interfaces, sites, operations
  policy.yaml        # fail-closed lanes and inheritance behavior
  controls.yaml      # red-capable negative controls
  families.yaml      # traced validation obligations and planned tests/evidence
  backlog.yaml       # owned, sequenced implementation work
```

Every file declares `schema: validation-architect/model/<name>/v1`. Missing,
unreadable, partial, unsupported, or semantically invalid input fails before
generated views are accepted.

## Policy shape

```yaml
schema: validation-architect/model/policy/v1
default: blocking
inheritance: tighten-only
layers:
  - {id: L1, title: Invariant and contract, status: active}
  - {id: L2, title: Hermetic system, status: active}
  - {id: L3, title: Live sandbox, status: declared-empty, reason: No disposable target}
  - {id: L4, title: Eval qualification, status: declared-empty, reason: No model site}
  - {id: L5, title: Ops hardening, status: active}
  - {id: L6, title: Outcome acceptance, status: declared-empty, reason: No human-judged output}
lanes:
  - id: inner-loop
    title: Fast local checks
    kind: test
    status: active
    requirement: blocking
    triggers: [before-push]
    command: pnpm test -- --changed
  - id: per-commit
    title: Required deterministic checks
    kind: test
    status: active
    requirement: blocking
    triggers: [per-commit]
    command: pnpm test
  - id: triggered
    title: Separately authorized live evidence
    kind: evidence
    status: declared-empty
    requirement: blocking
    triggers: []
    reason: No disposable live target has been ratified
  - {id: release, title: Release evidence, kind: evidence, status: declared-empty, requirement: blocking, triggers: [], reason: No separate release obligation}
  - {id: scheduled, title: Recurring evidence, kind: evidence, status: active, requirement: blocking, triggers: [weekly]}
exceptions: []
```

`project.yaml` also records intended use, a ratified C0–C4 tier, and its reason;
structures may carry reasoned component overrides. Unknown gates fail closed.
All six layers and the five execution lanes are declared; empty entries carry a
reason. Active test lanes name the real command and active lanes name exact
triggers. C2–C4 designs keep L5 active. A family references an active lane and
layer, then records its oracle, risk, owner, provenance, controls, status, and
ticket. Evidence lanes require an honest
`complete | incomplete | inconclusive | unobserved` state and bounded artifact
path; evidence never excuses an ordinary test-lane family.

Waivers and provisional values live in `exceptions` with a target, owner,
reason, and `YYYY-MM-DD` expiry; provisional values also state the temporary
testable value. An optional `coexistence` block fixes the parallel-greenfield
isolated root, protected paths, read-only incumbent gates, additive opt-in CI,
and cutover evidence. Unsafe paths fail compilation.

When outcome acceptance (`L-ACC`, L6) applies, scored rubric axes use an
evidence lane; its mechanical campaign guardrails remain test-lane families at
L1–L2. When it does not apply, L6 is declared empty with a reason.

## Inheritance

`tighten-only` is semantic, not a file-copy convention. A module references
parent structure IDs rather than restating their meaning. It may add families,
activate a previously empty lane, add controls, or increase required coverage.
It may not remove a parent obligation, convert required work to optional work,
lower a ratified threshold, or reuse a retired ID.

Represent modules as owned structures and families in the same checked graph.
If an independently versioned child model is necessary, record its model path
and version as provenance and compile it explicitly; never merge YAML trees by
guess. A cross-model resolver must prove tighten-only behavior before either
bundle is accepted.

## Generated lifecycle

The compiler deterministically produces `case-catalog.md`,
`harness-backlog.md`, `owner-briefing.md`, `owner-backlog.md`,
`planned-trace.md`, and `compiler-report.json`. These are readable projections,
not editable inputs. Their generated notice and model identity make drift
visible; regeneration replaces drift rather than attempting a lossy merge.
Fresh readers receive only ephemeral copies of those projections plus the
compiler report and an identity manifest; authored and source artifacts are
excluded by the read sandbox.

Legacy `validation-policy.yaml`, `case-catalog.md` plus `case-catalog.yaml`, and
authored backlog tables are migration inputs only. Import requires an explicit
reviewed mapping for ownership, provenance, structures, negative controls, and
planned tests. Reading old artifacts never upgrades or rewrites them.

## Audit interop

The audit compiles the model first, then joins an adapter-observed test
inventory and exact-revision evidence. It checks lane use, status honesty,
negative-control links, ownership, provenance, forward/backward closure, and
generated-view identity. Design, inventory, and evidence keep distinct
identities throughout.
