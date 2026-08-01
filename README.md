# Validation Architect

*(Renamed from `validation-design-agent` 2026-07-31 — the re-scope is recorded in
[docs/validation-architect.md](docs/validation-architect.md). The `vda` CLI name is
kept for now.)*

Two AI agents run a complete [validation-harness-design](skill/validation-harness-design/SKILL.md)
campaign end to end — no human at the keyboard, but with a dedicated channel
for the human's thinking — and an independent auditor verifies the result
before the campaign may close:

- **Designer** — Claude (Fable, via the Claude Agent SDK) drives the skill
  through Phases 0–8: teach, elicit, synthesize, hard stops, adversarial
  review, deliverables.
- **Stakeholder** — Codex (gpt-5.6-sol, via the Codex SDK) plays the product
  owner: the domain-expert human counterpart, grounded in the product's
  ratified docs and the human's `rambling.txt`, mounted read-only over the
  shared workspace.
- **Auditor** — a FRESH Claude session per audit iteration (like the readers,
  not a persistent third seat) runs the vendored
  [validation-harness-audit](skill/validation-harness-audit/SKILL.md) skill in
  its design-conformance capacity against the finished corpus. Read-only over
  the workspace (`docs/`, `rambling.txt`, `validation-design/`); it never sees
  the transcript — fresh perspective is the point.

Cross-provider on purpose: the two models have uncorrelated blind spots, the
same principle as builder ≠ reviewer in cross-provider code review. A
same-model self-play loop converges on agreement; this one is built to argue.
The auditor's independence comes from fresh context, not a different model
(override with `--auditor-model` if you want both).

## The loop

```
orchestrator
  ├─ prime stakeholder persona (docs + rambling.txt read-only)
  ├─ designer kickoff (skill + docs + provenance + marker protocol)
  ├─ relay loop:
  │    designer ──(strip markers)──▶ stakeholder ──▶ designer …
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

## rambling.txt — the human channel

The real human's unstructured pre-session thinking, primarily for the
stakeholder. It is input, **never ratified truth**:

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
- Absent file = pure-simulation mode, declared in the report — never silent.

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

```bash
pnpm install
pnpm test          # offline suite, no tokens
pnpm typecheck

# full autonomous campaign (spends real subscription quota on both sides)
pnpm vda run lumen-webapp
pnpm vda run relay-backend
pnpm vda run docsmith-agent

# loop-mechanics smoke (4 exchanges, then aborts by design)
pnpm vda run lumen-webapp --smoke

pnpm vda list
pnpm vda resume <runId>       # continue an aborted/crashed/interrupted run
pnpm vda audit <runId>        # one post-hoc audit iteration of a COMPLETED
                              # run: fresh auditor, no feedback loop; writes
                              # audit-report-N.md, updates report.md
pnpm vda report <runId>       # regenerate report.md
```

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

## Fixtures

Three synthetic products of deliberately different shapes, so the skill's
whole surface gets exercised:

| Fixture | Shape | Exercises |
| --- | --- | --- |
| `lumen-webapp` | C2 multi-tenant web app (expenses, Stripe payouts) | money paths, state machines, UI-as-adapter, Phase 5 declared empty |
| `relay-backend` | C3 delivery daemon (webhooks, ordering, DLQ) | failure domains, leader failover, time events, no UI at all |
| `docsmith-agent` | C3 agentic LLM product (triage, drafts, judge) | Phase 5 in full: evals, judge calibration, trajectory, guardrail-vs-eval |

Each fixture ships ratified `docs/`, a `rambling.txt` with **seeded
doc-vs-ramble conflicts** (a fact conflict the docs must win, a values
conflict that must surface as an open finding, and a directive that must be
recorded rather than obeyed), and a `fixture.yaml` holding expected outcomes
for our own checks — fixture.yaml never reaches the agents.

## Run layout

```
runs/<runId>/
  state.json           # resumable checkpoint (session ids, pending message,
                       # audit machine: iteration/phase/findings/dispositions)
  transcript.jsonl     # every turn: both sides + readers + auditor reports
  report.md            # gate discipline, phases, audit section, usage, artifacts
  audit-report-N.md    # each audit iteration's report (also copied below)
  workspace/           # the shared world
    .claude/skills/validation-harness-design/   # vendored skill (designer)
    .claude/skills/validation-harness-audit/    # vendored skill (auditor)
    docs/  rambling.txt                          # stakeholder's ground truth
    validation-design/                           # the designer's artifacts
      audit/                                     # audit reports + disposition record
```

## Repo map

| Path | What |
| --- | --- |
| `src/orchestrator.ts` | the relay loop, markers, readers, audit stage, checkpointing |
| `src/designer.ts` · `src/stakeholder.ts` · `src/readers.ts` · `src/auditor.ts` | provider adapters |
| `src/audit.ts` | AUD-xxx / DISPOSITION / verification parsers + verdict rules |
| `src/prompts.ts` | kickoffs, persona assembly, reader personas, auditor rubrics |
| `src/report.ts` | report.md + verdict counting + rubber-stamp & audit-suspect flags |
| `personas/` | stakeholder persona (grumpy-engineer mandate) |
| `skill/` | vendored copies of validation-harness-design and validation-harness-audit |
| `fixtures/` | the three synthetic products |
| `test/` | offline suite (fake adapters, no tokens) |
