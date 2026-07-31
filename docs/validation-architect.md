# Validation Architect — re-architecture of the validation-design-agent

Status: **direction ratified by the owner 2026-07-31** (chat decision, Operon
workstream). This document is the decision record; implementation is tracked in
the GitHub issues that reference it. Until an issue lands, treat the current
code and README as the accurate description of behavior — this document
describes where the system is going, not where it is.

## The decision in one paragraph

The validation-design-agent (VDA) is re-scoped from a **design agent** to a
**validation architect**: one identity that owns the full validation lifecycle
of a product repo — it **designs** the harness, **enables** its implementation
by whatever coding agent the repo uses, and **verifies** that what was built is
what was designed. The metaphor is load-bearing: an architect does not lay
bricks, but does produce the blueprints, the building codes the contractors
must follow, and the site inspections. The architect never writes product or
test code.

## Why the re-scope

Three observations from the first production campaign (`operon-2026-07-31`,
against the Operon repo) drove this:

1. **The lifecycle has no owner.** The design corpus is produced once, then
   the product repo's coding agents implement it over weeks under AGENTS.md
   routing. Nothing owns the arc between them: a design revision that renames
   case families must move the manifest, the conventions, the coding-agent
   prompts, and the audit criteria together — today each of those is a
   separate, unowned hand-off. (Issue #1 diagnosed the repo-anchoring half of
   this; the architect vision generalizes it.)

2. **Traceability exists as convention, not as mechanism.** The Operon
   implementation follows consistent conventions — test directories named by
   case-family ID, file headers citing family + backlog ticket + contract
   sections — so the design→implementation trace is reconstructible by grep.
   But nothing *breaks* when it goes stale: delete a spec file and the backlog
   still says LANDED, and no gate turns red. The information exists; the
   enforcement does not.

3. **Mechanical tracing cannot see fidelity.** Even a perfect trace checker
   proves *closure* (every family has a citing test; no orphans; status claims
   verified), not *faithfulness*. A test can cite `CF-INV-001`, run green, and
   assert a strawman — a weakened case wearing the right ID label. Judging
   "does this assertion actually falsify the ratified seed?" requires judgment,
   and the agent least qualified to render it is the coding agent that wrote
   the test. That is the same uncorrelated-blind-spots reasoning the design
   skill (and Operon's builder ≠ reviewer pairing) already encodes; the
   architect is the uncorrelated reviewer for the harness itself.

## The three legs

### 1. Design (exists today)

The campaign machinery as-is: designer/stakeholder relay, hard stops, reader
tests, gated audit, ratification package. Plus issue #1's developer journey:
anchored to the product repo, artifacts delivered as a branch/PR,
`harness-revision` mode by default when a corpus already exists.

### 2. Enable (new — mostly artifacts, not agent work)

The blueprints made executable by *others*. The architect ships, per designed
repo:

- **A machine-readable case-catalog manifest** (`case-catalog.yaml` or a
  section of `validation-policy.yaml`): family IDs, layers, risk tiers,
  prune/blocked status, owning backlog ticket. The markdown catalog stays the
  human artifact; the manifest is what tools consume.
- **Naming and traceability conventions** in the AGENTS.md contribution:
  test directories named by family ID; backlog ticket cited in file headers;
  every non-pruned, non-blocked family owns ≥1 spec or a declared pending
  wave.
- **A trace CLI** — deterministic, product-agnostic, run by the product
  repo's own CI on every commit. Three closure checks, all fail-closed:
  *forward* (every implementable family has tests or a declared pending
  wave), *backward* (no orphan tests citing unknown families), *status
  honesty* (a ticket annotated LANDED whose families lack tests is red).
  It also renders the human-facing trace report (below).
- **Skills/prompts/commands for the coding agent** — e.g. an
  `implement-harness-ticket` skill that teaches any coding agent (Cursor,
  Codex, Claude Code — deliberately vendor-neutral) the workflow: read the
  catalog row, resolve the seeds/failure modes/clauses in the upstream
  artifacts, land red-then-green with negative controls at the assigned
  layer, update traceability in the same change.
- **Owner-facing documents** (issues #2 and #3): `owner-briefing.md` at the
  ratification moment, `owner-backlog.md` as the living follow-along
  companion, and the generated trace report ("what exists today"), which
  reuses the companion's plain-language ticket names so its rows read like
  "Agents can't grant themselves authority — 5 files, 56 tests, landed"
  rather than ID soup. All three are non-normative by construction:
  generated from the ratified artifacts; on disagreement the artifact wins.

### 3. Verify (extends the existing audit)

Two tiers, deliberately different in kind — the harness-design skill's own
rule ("guardrails enforce; evals measure") applied recursively to the harness
itself:

- **Deterministic tier — tool, per-commit, enforcing.** The trace CLI in the
  product repo's CI. Certain, cheap, fail-closed. Agent judgment never
  substitutes for it: an agent audit is periodic and probabilistic; the
  linter is constant.
- **Judgment tier — agent, periodic or per-wave, reviewing.** The
  **fidelity audit**: the architect samples catalog rows, reads the citing
  tests against the ratified seeds/clauses, and judges whether the
  implementation encodes the design intent — is the negative control real,
  is the oracle the one the row demands, was the case quietly narrowed.
  This is the existing vendored `validation-harness-audit` skill's charter
  ("measures what was actually built") run at a new, smaller cadence:
  per-wave or per-PR, scoped to just-landed tickets, alongside the existing
  campaign-scale audit. Output is **findings only** — issues filed against
  the product repo, never fixes.

## Boundaries (what keeps the architect honest)

1. **The architect never writes product or test code.** It writes designs,
   manifests, skills, tooling, findings, and owner documents. The moment it
   fixes a test it found deficient, the uncorrelated-reviewer property is
   lost and it has become a second builder. Findings route back to the
   product repo's coding agents.
2. **Enforcement lives in the product repo's CI, not in the architect.** The
   architect ships the trace CLI and lane config; the repo runs them. A
   fleet of repos cannot depend on an agent being awake to know their traces
   are intact.
3. **Modes stay distinct.** Design, enablement-refresh, and audit are
   separate entries with separate outputs (the same discipline as the design
   skill's `harness-revision` mode). One identity, never one blurry session
   that designs and grades its own design.

## Division of labor

| Kind | What |
| --- | --- |
| Exposed artifacts (built per design, consumed by others) | design corpus · catalog manifest · conventions in AGENTS.md contribution · trace CLI + CI lane config · `implement-harness-ticket` skill · owner-briefing / owner-backlog / trace report |
| Agent work (judgment, per-invocation) | design + revision campaigns · fidelity audits (per-wave and campaign-scale) · interpreting drift the deterministic tier can't classify |
| The product repo's job (never the architect's) | implementing tickets · running CI · fixing findings |

## Fleet scale: the per-repo registry

The owner operates many repos; the architect must answer "which repos run a
stale design, and which have never had a fidelity audit?" The `runs/` folder
is already per-campaign; it is lifted to a per-repo ledger recording, per
target repo: installed design revision, last campaign, last fidelity audit,
open findings. This extends issue #1's single-repo journey to fleet scale.

## Naming

"Validation architect" replaces "validation design agent" as the concept name:
"design agent" undersells two of the three legs, and "architect" correctly
implies blueprint authority plus inspection duty without implying
construction. Repo/package renaming is a cosmetic decision deferred to the
owner; nothing in this document depends on it.

## Reconciliation with the existing tracker

- **#1 (developer journey / repo anchoring)** — becomes the repo-integration
  leg of Design and the substrate for Enable (artifacts must land in the
  product repo before conventions/CI can bind to them). Unchanged in content;
  re-framed as part of this architecture.
- **#2 (owner-briefing)** and **#3 (owner-backlog companion)** — become the
  owner-communication deliverables of Enable. Unchanged in content.
- New issues (filed with this document): catalog manifest + conventions;
  trace CLI + trace report; `implement-harness-ticket` skill; fidelity-audit
  cadence; per-repo registry.

**Pilot:** Operon. Its harness already conforms to the conventions by agent
habit, so the first trace-CLI run should mostly confirm rather than fix —
the cheapest possible proof of the mechanism. The Operon-side CI wiring is an
Operon-repo ticket (a natural extension of its HB-006 policy-pin lane), not a
VDA issue.
