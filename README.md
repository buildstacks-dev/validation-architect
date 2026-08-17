# Validation Architect

*(Renamed from `validation-design-agent` 2026-07-31. The `vda` CLI name is kept
for now.)*

Two AI agents run a complete [validation-harness-design](skill/validation-harness-design/SKILL.md)
campaign end to end — no human at the keyboard, but with a dedicated channel
for the human's thinking — and an independent auditor verifies the result
before the campaign may close:

- **Designer** — Claude (Fable, via the Claude Agent SDK) drives the skill
  through Phases 0–8: teach, elicit, synthesize, hard stops, adversarial
  review, deliverables.
- **Stakeholder** — Codex (gpt-5.6-sol, via the Codex SDK) plays the product
  owner: the domain-expert human counterpart, grounded in the product's
  ratified docs plus the human's `rambling.txt` when one exists — and in
  intent derived from the repo's own material (README, specs, architecture,
  source) when it doesn't — mounted read-only over the shared workspace.
- **Auditor** — a FRESH Claude session per audit iteration (like the readers,
  not a persistent third seat) runs the
  [validation-harness-audit](skill/validation-harness-audit/SKILL.md) skill in
  its design-conformance capacity against the finished corpus. Read-only over
  the workspace (`docs/`, `rambling.txt` when present, `validation-design/`);
  it never sees the transcript — fresh perspective is the point.

Cross-provider on purpose: the two models have uncorrelated blind spots, the
same principle as builder ≠ reviewer in cross-provider code review. A
same-model self-play loop converges on agreement; this one is built to argue.
The auditor's independence comes from fresh context, not a different model
(override with `--auditor-model` if you want both).

## The loop

```
orchestrator
  ├─ prime stakeholder persona (docs + optional rambling.txt read-only)
  ├─ designer kickoff (skill + docs + provenance + marker protocol)
  ├─ relay loop:
  │    designer ──(strip markers)──▶ stakeholder ──▶ designer …
  │    meaningful model edits compile + regenerate before the next gated stage
  │    markers: <<AWAITING-HUMAN>> · <<REQUEST-READER-TEST>> · <<CAMPAIGN-COMPLETE>>
  │    Phase 8: three EPHEMERAL fresh-context readers (operator /
  │    new-engineer / coding-agent) see ONLY the artifacts and report gaps
  └─ audit stage (CAMPAIGN-COMPLETE is gated on it, max 2 iterations):
       fresh auditor → tiered findings (AUD-xxx) → designer dispositions
       (fixed / disputed / deferred) → stakeholder confirms & arbitrates
       → fresh auditor #2 verifies dispositions → verdict → the designer
       writes the ratification package's Audit section → completion accepted
```

Multi-exchange within a phase is expected — the stakeholder asks questions,
objects, and refuses gates; the designer revises. Every turn is checkpointed
(`state.json`), so a crashed or interrupted run resumes exactly where it
stopped: `pnpm vda resume <runId>`.

## Checked design model

All machine facts live under `validation-design/model/` in eight logical YAML
files: `project.yaml`, `owners.yaml`, `sources.yaml`, `structures.yaml`,
`policy.yaml`, `controls.yaml`, `families.yaml`, and `backlog.yaml`. The
compiler validates source-located schemas and links, ownership, provenance,
statuses, fail-closed lanes, negative controls, planned tests/evidence, safe
paths, and bidirectional family↔ticket/control relationships.
The checked policy also retains intended use and C0–C4 criticality, declares
all six validation layers and five execution lanes, requires real commands for
active test lanes, and models expiring exceptions and optional
parallel-greenfield protections.

From one canonical identity it generates `case-catalog.md`,
`harness-backlog.md`, `owner-briefing.md`, `owner-backlog.md`, and
`planned-trace.md`, plus `compiler-report.json`. The planned trace includes a
complete source-ID registry, so a fresh reader can resolve every provenance
kind, path, locator, and cited quote without access to the YAML authority. It
also renders every product structure's protected meaning, acceptance criteria,
failure modes, changed paths, provenance, and owner, with absent optional lists
shown explicitly.
These projections are never editable authority. A stale or missing view is
regenerated before review; an invalid model blocks readers, audit, completion,
and delivery. Narrative rationale remains authored prose, while the actual test
inventory and run evidence stay separate from design authority.

The public repository composition joins observed executable specs to current
families and controls by exact reviewed `planned_tests` path. One path may
implement several reviewed split families. Legacy first-comment CF/HB tokens
remain human-readable annotations; they cannot create or reject current model
facts, while an observed unplanned spec remains a red orphan.

Fresh readers are additionally confined to an ephemeral bundle containing only
those five generated views, the accepted compiler report, and a bundle identity
manifest. They cannot read YAML source, authored design prose, product docs,
rambling, or campaign history; all visible files are bound to one model identity.

This is an explicit pre-1.0 clean break. A legacy Markdown catalog/backlog is
accepted only by the public `migrate` entry point, whose caller must supply
reviewed ownership, provenance, product structures, negative controls, planned
tests/evidence, canonical family placement, actionable ticket splits, and the
complete target policy when the canonical fallback is insufficient. Composite
family outputs name their exact owner, provenance, and structures; they may
also carry distinct non-empty oracle and risk reviews, with omitted values
preserving the exact legacy family values. Legacy placement prose is never
parsed into current meaning. The migration
ledger accounts for every legacy family and ticket, including non-owning family
citations and historical tickets that cannot become empty actionable work. The
import preserves reviewed ticket dependencies, per-output split status (with
legacy status inherited when omitted), `LANDED` status, and
`EVIDENCE:complete|incomplete|inconclusive|unobserved:<path>` declarations,
but reading an old corpus never rewrites it or assigns a current schema by
guess. The prior EVIDENCE behavior from local commit `42e1918` is therefore
migrated, not stranded or weakened.

The provider-neutral result, startup/causality, relationship trace/explain, role
views, and conservative impact-planning contracts are summarized in
[docs/core-protocol.md](docs/core-protocol.md). They normalize compiler, trace,
campaign, audit, fidelity, prerequisite, and higher-lane outcomes without
treating those domain statuses as interchangeable.

## rambling.txt — the optional human channel

The real human's unstructured pre-session thinking, primarily for the
stakeholder. **Nobody has to write it** (issue #14): a product whose repo
already carries docs, specs, architecture records, and code needs no
hand-authored rambling file. When it exists it is input, **never ratified
truth** — and it keeps priority as the human's direct voice:

- **Docs win on facts, rambles win on values.** A doc-vs-ramble fact conflict
  becomes a recorded finding, never a silent resolution.
- **Rambles never ratify.** Gate confirmations are the stakeholder's reasoned
  judgment, informed by — not dictated by — the ramble.
- **Directives get surfaced.** "skip X" in a ramble becomes an explicit scope
  decision with provenance, not an obeyed order.
- **Provenance:** `[rambling]` (cited quote) · `[simulated]` (stakeholder's
  own judgment) · `[doc]` · `[PROPOSED]`. `[stated]` is reserved for a live
  ratifying human and never appears in autonomous runs.
- **Hot reload:** appended mid-run? The stakeholder is told to re-read at the
  next turn (mtime watch).
- **Absent file = derived-intent mode.** The owner seat derives its product
  intent from the repo's own material — README, `docs/`, specs, architecture
  records, and the committed source on target runs — and presents it as
  `[simulated]` owner judgment flagged for ratification; `[rambling]` may not
  appear at all (the auditor treats any occurrence as a blocking finding).
  Nothing is fabricated on disk: the campaign never writes a rambling.txt.
  The transcript and report record the run's intent source (`human-rambling`
  vs `derived-from-repo`), so a reviewer can always tell the human's voice
  from derived intent — declared, never silent.
- The source is fixed at kickoff. Appending an existing human file hot-reloads;
  adding or removing the file would change provenance, so the run stops before
  another provider call and must be restored or restarted.

## The audit stage

When the designer emits `<<CAMPAIGN-COMPLETE>>` (readers already enforced),
the orchestrator does not complete — it runs an independent audit loop first.

**Iteration 1.** A fresh auditor measures conformance and internal
consistency: falsifiability of invariants, invariant↔boundary↔contract↔case
traceability, policy fail-closed/tighten-only discipline, declared-vs-silent
absences, layer placement per the cheapest-layer rule, and provenance
integrity ([rambling] citations are spot-checked against `rambling.txt`). Two
hard rubric rules: ratified decisions are facts to audit against, never
positions to reopen; and taste is not auditable (structure/style is minor at
most). The report — tiered `AUD-xxx` findings with concrete evidence — lands
in the run dir and `workspace/validation-design/audit/`.

**Feedback window.** The findings go to the designer as an environment
message. The designer records `DISPOSITION: AUD-xxx = fixed|disputed|deferred`
per finding, applies fixes as surgical edits with inline changelogs, and the
stakeholder confirms dispositions with its usual verdict tags — it also
arbitrates designer-vs-auditor disputes, because it owns product truth.

**Iteration 2.** A NEW fresh auditor sees the corpus, `audit-report-1.md`,
and the orchestrator-written disposition record. Its scope is strictly:
verify each round-1 disposition (`VERIFIED` / `NOT-FIXED` / `REGRESSION`) and
catch regressions from the fixes; new findings are admissible only at
blocking tier.

**The two convergence rules** (without them the loop could run forever):

1. Each feedback window is capped at **12 stakeholder exchanges** — at the
   cap the orchestrator advances the audit machine with whatever dispositions
   exist, so the audit loop cannot eat the campaign budget.
2. Iteration 2 **verifies; it does not re-audit** — non-blocking new findings
   are inadmissible (enforced in the prompt and again in parsing), and there
   is never a third iteration.

**Exit.** All blocking findings fixed or explicitly disputed-and-arbitrated →
verdict `clean` (everything graded fixed) or `clean-with-disputes` (some
disputed, or a significant finding left open/deferred — escalated to the
human, listed in the package). A blocking finding still open after iteration
2 → verdict `reservations`; the run still completes, honestly labeled. A
zero-finding iteration 1 skips the window and iteration 2 (nothing to
verify) and is flagged **AUDIT-SUSPECT** in the report when the design took
30+ exchanges. Finally the designer writes an Audit section into
`ratification-package.md` (verdict, findings by tier and disposition,
unresolved disputes); the orchestrator rejects the closing
`<<CAMPAIGN-COMPLETE>>` until that heading exists.

## Anti-yes-loop design

Agent loops love agreeing with each other, which would make every hard stop
theater. Countermeasures:

1. The stakeholder persona ([personas/product-owner.md](personas/product-owner.md))
   carries a mandatory challenge discipline: gates require reading the actual
   artifacts and citing what was checked; unjustified "looks good" is a
   protocol violation; refusing gates is normal.
2. Structured verdict tags (`OBJECTION:` / `GATE-REFUSED:` / `CONFIRMED:`)
   make gate discipline auditable.
3. The run report counts them — a campaign with zero objections is flagged
   **RUBBER-STAMP SUSPECT** in its own report.
4. Phase 8's reader test runs in fresh contexts that owe the designer
   nothing.
5. The audit stage mirrors the philosophy: a first-pass audit with ZERO
   findings on a 30+ exchange design is flagged **AUDIT-SUSPECT** — treat
   its verdict as unverified.

The final safeguard is scope: everything the agents produce is a **draft**.
`validation-design/ratification-package.md` collects every hard-stop
decision, all open findings, and the questions only a real human can answer.

## Usage

**Prerequisites.** pnpm is pinned by `packageManager` in `package.json`, and corepack is what makes that pin take effect. Node 25+ no longer bundles corepack, so it is one install per Node version:

```bash
npm install -g corepack && corepack enable
```

Without it your ambient pnpm runs instead of the pinned one, and the two disagree about `pnpm-workspace.yaml` — the pinned pnpm 11 requires a `packages:` key that older pnpm does not, so the same repo works on one machine and fails on another. `pnpm --version` should report the version `packageManager` names.

```bash
pnpm install
pnpm test          # offline suite, no tokens
pnpm typecheck

# the production journey: anchor to a product repo (see "Developer journey")
pnpm vda run --target ~/code/myproduct            # greenfield or auto-revision
pnpm vda run --target ~/code/myproduct --fresh    # force from-scratch (warns)
pnpm vda deliver <runId>                          # re-deliver the corpus branch

# fixture campaigns — the test/demo path for exercising the skill surface
# (spends real subscription quota on both sides)
pnpm vda run lumen-webapp
pnpm vda run relay-backend
pnpm vda run docsmith-agent

# loop-mechanics smoke (4 exchanges, then aborts by design)
pnpm vda run lumen-webapp --smoke

pnpm vda list
pnpm vda resume <runId>       # continue an aborted/crashed/interrupted run
# old unversioned pre-1.0 state only; named recovery preserves pending
pnpm vda resume <runId> --recover-core-state adopt-current-pre1-after-compiler-validation
# legacy target state only: offline, explicit re-anchor on current clean HEAD
pnpm vda resume <runId> --recover-target-base current
pnpm vda resume <runId>       # inspect first, then start the live reconciliation
pnpm vda audit <runId>        # one post-hoc audit iteration of a COMPLETED
                              # run: fresh auditor, no feedback loop; writes
                              # audit-report-N.md, updates report.md
pnpm vda report <runId>       # regenerate report.md

# fidelity audit (spends Claude quota, one fresh session): do the citing
# specs actually falsify their ratified seeds? Scoped per wave / ticket set;
# REFUSES when validation-architect check is red (fix closure before asking judgment);
# also refuses a dirty checkout, audits a detached captured HEAD/tree, and
# invalidates the result if the checkout moves; findings only — no patches.
pnpm vda fidelity <target-repo> --wave 1
pnpm vda fidelity <target-repo> --tickets HB-014,HB-015 --out fid.md

# fleet ledger (offline): which repos run a stale design, which were never
# fidelity-audited, which have findings open. Written only by the campaign/
# delivery/fidelity completion paths — never hand-maintained. An absent
# entry is UNKNOWN, loudly — no green by absence.
pnpm vda repos                          # every registered target
pnpm vda repos ~/code/myproduct         # explicit query (UNKNOWN if absent)
pnpm vda repos --stale-days 7

# in a product repo: the packed/released packages run compiled JavaScript and
# have no runtime dependency on tsx or this source checkout
pnpm add --save-dev --save-exact validation-architect@0.4.7
pnpm exec validation-architect check .            # the CI gate (result/v1)
pnpm exec validation-architect compile . --write  # author findings + views
```

Before a registry release, replace `validation-architect@0.4.7` with the exact
`.tgz` produced by `pnpm pack`; the same clean-target smoke covers that path.

**Two lockstep packages** (VA-PKG-001). This repository publishes a pair that
version together:

- **`validation-architect`** (this root) — the provider-neutral core: the nine
  public entry points (`compile`/`check`/`explain`/`plan`/`ingest`/`render`/
  `migrate`/`design`/`resume`), the three ports and conformance fakes, six
  schema assets under `schemas/`, the three skill trees, the enablement
  handoff, and the `validation-architect` CLI. Its only runtime dependency is
  `yaml`; no provider SDK ever ships with it.
- **`validation-architect-design`** (`design/`) — the provider-bound local
  composition: read-only fs/git repository adapter, atomic file-backed
  campaign store, one concrete TurnPort over the Claude Agent SDK and Codex
  SDK (same confinement pattern as the in-repo campaign host), and the
  `validation-architect-design` CLI. Depends on the core at the exact same
  version. Run standalone campaigns with
  `npx validation-architect-design@<exact> . --profile C2`; optional
  `--intake-file intake.md` augments intent derived from repository docs.
  Its repository adapter binds the latest product-source commit while allowing
  only `validation-design/` to differ, so committing the corpus cannot stale
  its own embedded revision. Its local turn ledger replays locally settled
  keys; an ambiguous provider/local crash boundary fails closed without a
  second provider call because neither bundled SDK offers native settlement
  reconciliation.

**Deprecated alias.** `validation-trace` remains a bin of the core package
through 0.x as a deprecated alias for `validation-architect check`: every
invocation prints one deterministic warning line on stderr, and it is removed
at 1.0. The alias alone carries one bounded cutover bridge for consumers that
still invoke `--manifest`/`--tests`: with no checked-model file it runs the
retained legacy closure; once any checked-model file exists it selects
checked-model authority without fallback, ignores `--manifest`, and maps
`--tests` to `--tests-root`. A partial or corrupt model therefore fails closed.
Without those legacy flags, exit codes and output remain identical to `check`.
The former `generate` subcommand is superseded by
`validation-architect compile`.

Flags: `--max-exchanges N` (default 60) · `--wall-minutes N` (default 300) ·
`--designer-model` / `--stakeholder-model` / `--reader-model` ·
`--auditor-model` (default: the designer's model) ·
`--claude-auth subscription|api-key` · `--codex-auth chatgpt|api-key` ·
`--run-id ID`.

Post-hoc audit iterations number from 1 but skip 2 — the `AUD-2xx` id range
and the verification rubric are reserved for the in-campaign iteration 2.

**Auth is subscription-first on both sides**: the Claude side uses the
`claude` CLI login (ANTHROPIC_API_KEY is stripped unless `--claude-auth
api-key`), the Codex side uses the ChatGPT login from `codex login`
(`--codex-auth api-key` switches to OPENAI_API_KEY).

## Developer journey

The product repo is first-class; VDA is a tool invoked against it. Install
once, then:

1. **First run (greenfield).** `pnpm vda run --target <product-repo>`. The
   target must be a clean Git checkout with a committed `docs/` tree.
   `rambling.txt` is optional — write one when you want your own voice in the
   campaign; without it the owner seat grounds itself in the repo's docs,
   README, specs, and source (derived-intent mode, recorded in the run's
   transcript and report). VDA
   pins its HEAD and tree digests, clones that exact revision without a
   remote under the campaign workspace, and exposes source, configuration,
   docs, and readable history to the confined designer/auditor. The campaign
   therefore cannot silently move to a newer checkout while it runs. It runs
   under `runs/<runId>/` as usual, but
   on completion the durable spec — the whole `validation-design/` corpus —
   and its `validation-design/enablement/` handoff are **delivered to the product repo** as a branch
   (`validation-design/<runId>`), committed via a temporary worktree so your
   checkout is never touched. Campaign residue (transcript, `state.json`,
   `report.md`) stays VDA-local.
2. **Ratify & land.** Review the branch like any change — open a PR from it;
   the ratification package is a natural PR description. Merging is the
   human ratification moment.
3. **Iterate (revision).** Re-running `vda run --target` against a repo that
   already carries `validation-design/model/project.yaml` auto-detects
   the corpus, mounts it as the baseline, and kicks the designer off in the
   skill's `harness-revision` mode. A legacy `validation-policy.yaml` also
   selects revision mode but must take the explicit import path. Every delivery embeds
   `source-provenance.json`; the next revision receives the prior/current
   SHAs, a source/config path summary, and a unified diff, then reopens only
   affected concepts with surgical edits and retired IDs preserved — never a
   from-scratch Phase 0. `--fresh` opts out, with a warning that it creates a
   second, diverging design.
4. **Install enablement, then use agents as callers.** Follow the delivered
   `validation-design/enablement/INSTALL.md`: pin this package (which supplies
   `validation-architect check` and its deprecated alias), install the bundled
   `implement-harness-ticket` skill in the repo's supported skill location,
   land the ratified `agents-md-contribution.md`, and review/copy the included
   CI template. The delivery branch does not silently rewrite a product
   package manifest, standing agent instructions, or active CI workflow.
   Those instructions route structural changes back into VDA's
   `harness-revision` mode. Installing enablement never authorizes a live
   `L-ACC` campaign.

If startup fails because the target is dirty, commit or stash its changes
before spending live quota. If delivery later fails (for example, the pinned
commit is unavailable), the campaign record is still intact — fix the repo
and `pnpm vda deliver <runId>`;
re-delivery idempotently updates the same branch. Fixture runs (`vda run
<fixture>`) skip delivery entirely: fixtures exercise the skill surface,
they are not the production journey.

State files from before immutable target snapshots are never silently bound to
whatever HEAD happens to be current. If a legacy workspace already contains a
valid no-remote `target-source/` plus `TARGET-SNAPSHOT.md`, `resume`/`deliver`
recover that exact identity automatically. Otherwise commit or stash the
target, then run `pnpm vda resume <runId> --recover-target-base current`. This
first command is offline: it leaves the old workspace untouched, creates a new
frozen workspace at current HEAD, preserves the legacy corpus/ramble and prior
pending turn, removes stale audit/owner final surfaces, resets provider
sessions plus reader/audit evidence, and reopens even a formerly completed
run. Inspect it, then run ordinary `pnpm vda resume <runId>` to perform the
mandatory source-grounding reconciliation. A recovered delivery uses a new
`validation-design/<runId>-recovered-<sha>` branch rather than rewriting an
incompatible legacy branch.

## Fixtures

Three synthetic products of deliberately different shapes, so the skill's
whole surface gets exercised:

| Fixture | Shape | Exercises |
| --- | --- | --- |
| `lumen-webapp` | C2 multi-tenant web app (expenses, Stripe payouts) | money paths, state machines, UI-as-adapter, Phase 5 declared empty |
| `relay-backend` | C3 delivery daemon (webhooks, ordering, DLQ) | failure domains, leader failover, time events, no UI at all |
| `docsmith-agent` | C3 agentic LLM product (triage, drafts, judge) | Phase 5 in full: evals, judge calibration, trajectory, guardrail-vs-eval |

Each synthetic fixture ships ratified `docs/`, a `rambling.txt` with **seeded
doc-vs-ramble conflicts** (a fact conflict the docs must win, a values
conflict that must surface as an open finding, and a directive that must be
recorded rather than obeyed), and a `fixture.yaml` holding expected outcomes
for our own checks — fixture.yaml never reaches the agents. Real targets are
never checked in as fixtures: a real product is a path passed to
`vda run --target`, and a live target must not carry an answer key.

## Run layout

Runs live beside this checkout. `VDA_RUNS_ROOT` relocates that ledger — the
acceptance tests use it to drive the real CLI without touching your runs.

```
runs/<runId>/
  state.json           # resumable checkpoint (session ids, pending message,
                       # audit machine: iteration/phase/findings/dispositions)
  transcript.jsonl     # every turn: both sides + readers + auditor reports
  report.md            # gate discipline, phases, audit section, usage, artifacts
  audit-report-N.md    # each audit iteration's report (also copied below)
  workspace/           # the shared world
    .claude/skills/validation-harness-design/   # design skill, copied in for the run
    .claude/skills/validation-harness-audit/    # audit skill, copied in for the run
    docs/  rambling.txt (optional)               # stakeholder's ground truth
    validation-design/                           # the designer's artifacts
      model/                                     # sole YAML machine authority
      compiler-report.json                       # source spans + exact model identity
      case-catalog.md  harness-backlog.md         # generated views
      owner-briefing.md  owner-backlog.md         # generated owner views
      planned-trace.md                            # generated planned-link closure
      audit/                                     # audit reports + disposition record
```

## Repo map

| Path | What |
| --- | --- |
| `src/orchestrator.ts` | the relay loop, markers, readers, audit stage, checkpointing |
| `src/designer.ts` · `src/stakeholder.ts` · `src/readers.ts` · `src/auditor.ts` | provider adapters |
| `src/audit.ts` | AUD-xxx / DISPOSITION / verification parsers + verdict rules |
| `src/model.ts` · `src/model-compiler.ts` · `src/model-views.ts` | versioned design graph, deterministic compiler, generated views |
| `src/model-inventory.ts` · `src/workspace-compiler.ts` · `src/legacy-model-import.ts` | separate inventory join, atomic workspace compilation, explicit legacy import |
| `src/catalog.ts` · `src/trace.ts` | legacy catalog/trace internals retained for repository compatibility |
| `src/fidelity.ts` | fidelity audit: scope resolution, closure preflight, findings-only guard |
| `src/registry.ts` | per-repo fleet ledger + staleness flags behind `vda repos` |
| `src/target.ts` | target-repo anchoring: loading, revision-mode detection, branch delivery |
| `src/conventions.ts` | normative AGENTS.md traceability conventions the designer emits |
| `src/enablement.ts` · `enablement/` | materialized product-repo handoff: builder skill, compiled-CLI install, CI template, exact conventions |
| `src/prompts.ts` | kickoffs, persona assembly, reader personas, auditor rubrics |
| `src/report.ts` | report.md + verdict counting + rubber-stamp & audit-suspect flags |
| `personas/` | stakeholder persona (grumpy-engineer mandate) |
| `skill/` | this repo's design + audit skills, plus `implement-harness-ticket` (Enable leg) |
| `fixtures/` | three synthetic products (the deterministic offline corpus) |
| `test/` | offline suite (fake adapters, no tokens) |
| `src/core-cli.ts` · `src/cli-local-repository.ts` | the `validation-architect` CLI: public api composed over a CLI-only read-only fs/git repository |
| `bin/validation-architect.js` · `bin/validation-trace.js` · `tsconfig.build.json` | production package bins (core CLI + deprecated trace alias) and the compiled public-closure build |
| `design/` | the `validation-architect-design` package: local adapters, provider TurnPort, design CLI, offline tests |

## License

This repository and its published packages are licensed under the
**Functional Source License 1.1 with MIT future grant**
([FSL-1.1-MIT](LICENSE.md)) — fair source, not open source. In plain English:
you are free to read, use, modify, and self-host the software, including
commercial internal use; you may not offer it as a competing product or
service; and each released version automatically becomes MIT-licensed two
years after its release. Copyright 2026 Bikram Gupta. Third-party runtime
dependency notices are in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
