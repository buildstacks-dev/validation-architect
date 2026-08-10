# AGENTS.md

## What this repo is

An orchestrator that runs a full validation-harness-design campaign between
two AI agents — a Claude **designer** driving this repo's design skill
(`skill/validation-harness-design/`) and a Codex **stakeholder** playing the
product owner, grounded in fixture docs plus the human's `rambling.txt` —
then gates completion behind an independent **auditor**: fresh Claude
sessions running `skill/validation-harness-audit/` in design-conformance
capacity (max 2 iterations, capped feedback windows, dispositions arbitrated
by the stakeholder). Read `README.md` first — it is the product view and
stays authoritative on usage, the rambling.txt semantics, the audit stage,
and the anti-yes-loop design.

## Commands

- `pnpm install` · `pnpm typecheck` · `pnpm test` — offline, no tokens.
- `pnpm vda run <fixture> [--smoke]` /
  `pnpm vda run --target <product-repo> [--fresh]` · `resume` · `readers` ·
  `audit` · `report` · `list` — **live, spends subscription quota on BOTH
  providers** (`readers`/`audit`/`fidelity` spend Claude only). Never run a
  live campaign casually; a full run is hours of wall clock.
- `pnpm vda fidelity <target-repo> [--wave W | --tickets ...]` — live (one
  fresh Claude session) judgment pass over a product repo; refuses while
  `validation-trace` is red; findings only (the no-patches rule is enforced
  in the prompt AND the report-format guard — keep both halves).
- `pnpm vda deliver <runId>` — offline; (re-)lands a completed target run's
  corpus in the product repo as a `validation-design/<runId>` branch via a
  temp worktree (never touches the user's checkout).
- `pnpm vda repos [paths...] [--stale-days N]` — offline; the fleet ledger
  (`runs/registry.json`). Entries are written ONLY by the campaign/delivery/
  fidelity completion paths — never hand-edit it; absent entry = UNKNOWN,
  loudly, never healthy.

## Working rules

- **The offline suite stays offline.** Nothing under `test/` may call a
  provider SDK for real. Live behavior is validated by `--smoke` runs.
- **fixture.yaml never reaches agent prompts.** It is the answer key our
  checks compare campaign output against; leaking it invalidates the
  fixture. The `fixtures.test.ts` integrity checks (conflict species,
  directive-in-ramble) must keep passing after any fixture edit.
- **Prompts are load-bearing.** `src/prompts.ts` and
  `personas/product-owner.md` encode the provenance model
  ([rambling]/[simulated]/[doc]/[PROPOSED], never [stated]) and the
  anti-rubber-stamp discipline (OBJECTION / GATE-REFUSED / CONFIRMED with
  cited evidence). The auditor rubric is equally load-bearing in the other
  direction: it forbids relitigating ratified decisions and auditing taste.
  Do not weaken any of them to make a campaign "flow better" — a smooth
  campaign with no objections is the failure mode, and report.md flags it as
  RUBBER-STAMP SUSPECT (and a zero-finding first audit as AUDIT-SUSPECT).
- **The audit loop's convergence rules are invariants, not tuning.** The
  12-exchange feedback-window cap and iteration 2's strict scope
  (verify round-1 dispositions + regressions; NEW findings admissible only
  at blocking tier; never a third iteration) are what guarantee the audit
  stage terminates. They are enforced in the auditor prompts AND in the
  orchestrator's parsing; keep both halves.
- **The skills live here.** `skill/validation-harness-design/`,
  `skill/validation-harness-audit/` and `skill/implement-harness-ticket/` are
  this repo's own artifacts, not copies of anything upstream. Change them here.
  They are a contract pair: the design skill defines the artifact set and the
  audit skill measures conformance against it, so a change to one that the
  other must know about lands in the same commit, with both `VERSION` and
  `CHANGELOG.md` updated.
- **Resumability is a contract.** Every orchestrator change must keep the
  `state.json` pending-message invariant: any crash point resumes via
  `vda resume` without repeating or dropping a turn. This covers the audit
  machine (`pending: {to: "auditor"}` re-runs the interrupted iteration;
  `state.audit` carries findings/dispositions/phase). The orchestrator tests
  encode this; extend them with any new state. Tests that complete without
  the audit stage pre-set `audit.phase = "done"` the same way `readersRan`
  is pre-set — never weaken the gate itself.

## Layout

`src/` one module per concern (orchestrator, two adapters, readers, auditor,
audit parsing/verdicts, prompts, report, transcript, ramble, workspace,
fixtures, target, catalog, trace, fidelity, registry, conventions, cli) · `fixtures/` three synthetic
products (web app / backend daemon / agentic LLM) plus `operon`, the
real-target pilot docs snapshot · `bin/validation-trace.js` the product-
agnostic closure CLI · `skill/implement-harness-ticket/` the coding-agent
enablement skill · `runs/` gitignored campaign outputs.
