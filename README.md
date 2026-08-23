# Validation Architect

> **Work in progress:** `@cormidia/validation-architect@0.5.0` is the first
> publication candidate and is not yet available from npm.

Validation Architect designs a checked validation harness for a product
repository. A provider-neutral engine runs a bounded designer, product-owner,
fresh-reader, and independent-auditor campaign; one provider-bound composition
supplies immutable Git capture, Claude/Codex turns, at-most-once settlement,
operational evidence, delivery, and fleet reporting.

The repository publishes one package, `@cormidia/validation-architect`, with
three command-line entry points:

- `validation-architect` — deterministic check, compile, plan, and explain.
- `validation-trace` — deprecated 0.x alias for `validation-architect check`.
- `validation-architect-design` — live campaign and offline operational command.

The root import exports provider-neutral contracts, compiler, relationship
graph, schemas, conformance fakes, and public `design()` / `resume()`. The
`@cormidia/validation-architect/design` subpath exports the local operational
adapters. Importing either surface does not load a provider SDK.

There is one campaign state machine (`CampaignCheckpoint`), one provider
settlement implementation (`TurnLedger`), and one confinement implementation
(`LocalTurnPort`). The project is unreleased; no obsolete campaign-state
reader, writer, or migration is carried.

## Campaign method

Profiles are finite admitted contracts:

- C0 — one designer turn.
- C1 — designer plus a fresh independent audit.
- C2 — designer, cross-provider product-owner challenge, revision, audit.
- C3/C4 — bounded relay, up to three fresh-reader passes, and at most two
  independent audit iterations with a capped stakeholder disposition window.

Designer and stakeholder seats are persistent native sessions. Readers and
auditors are fresh sessions with checked independence requirements. Every turn
is structured JSON, revalidated by the core, and saved through a pending-first
compare-and-swap checkpoint. Provider settlement is reconciled before work;
an ambiguous stateful turn fails closed and is never blindly retried.

The absolute campaign deadline is authoritative before dispatch, in flight,
after settlement, and before transition/artifact acceptance. Artifact count,
artifact UTF-8 bytes, structured history, prompt bytes, and intake bytes are
admitted bounds. Authority-bearing files are never silently truncated.

## Checked design model

Machine authority lives in eight YAML files under `validation-design/model/`:

- `project.yaml`
- `owners.yaml`
- `sources.yaml`
- `structures.yaml`
- `policy.yaml`
- `controls.yaml`
- `families.yaml`
- `backlog.yaml`

The compiler validates schemas, links, ownership, provenance, statuses,
fail-closed lanes, negative controls, planned tests/evidence, safe paths, and
family↔ticket/control relationships. From one canonical identity it generates
`case-catalog.md`, `harness-backlog.md`, `owner-briefing.md`,
`owner-backlog.md`, `planned-trace.md`, and `compiler-report.json`.

Generated projections are never editable authority. An invalid or stale model
blocks fresh readers, audit, completion, delivery, and fidelity.

## Optional human intake

By default the live command watches `<target>/rambling.txt`. The file is
optional:

- absent at kickoff means intent is derived from committed repository evidence;
- present content is unratified human input, not product truth;
- docs win on facts while human values remain explicit decisions;
- directives are surfaced as scope decisions, not silently obeyed;
- provenance stays distinct (`[rambling]`, `[simulated]`, `[doc]`,
  `[PROPOSED]`; never `[stated]` without a live ratifying human);
- append-in-place content reloads before the next pending turn;
- adding, removing, truncating, replacing, or substituting the fixed file
  stops before provider work.

`--intake-file <path>` selects another fixed append-only source.

## Installation and offline verification

Install the deterministic compiler surface with an exact pre-1.0 pin:

```bash
pnpm add --save-dev --save-exact @cormidia/validation-architect@0.5.0
pnpm exec validation-architect check .
npx @cormidia/validation-architect@0.5.0 --help
```

The Claude and Codex SDKs are optional peers. Install both exact tested
versions only on a machine that runs live design work:

```bash
pnpm add --save-dev --save-exact \
  @anthropic-ai/claude-agent-sdk@0.3.220 \
  @openai/codex-sdk@0.146.0
```

Design campaigns support exactly two harnesses — the Claude Agent SDK and the
Codex SDK — at the pinned versions; no other provider or harness is supported.
If a live command needs an absent SDK, it stops with the exact package and
version to install. Deterministic commands and offline design operations never
load either SDK.

For repository development, the package manager is pinned by
`packageManager`. Use Corepack and verify the reported version before running:

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm test:package
```

All tests are offline. No test may call a provider SDK for real.

## One live campaign command

Start against a clean Git repository:

```bash
npx -p @cormidia/validation-architect@0.5.0 validation-architect-design ~/code/product --profile C2
```

The command prints the run ID and state directory. It captures target HEAD into
a detached, remote-free clone outside the checkout, then runs public
`design()`. Product source remains pinned even if the user checkout advances.

Resume an interrupted checkpoint:

```bash
npx -p @cormidia/validation-architect@0.5.0 validation-architect-design resume <runId> ~/code/product
```

Resume requires the same package version and immutable source snapshot. A
settled failed turn stays failed. There is no historical-state recovery flag.

Optional provider selection:

```bash
--model-designer <model> --model-stakeholder <model>
--model-reader <model> --model-auditor <model>
--claude-auth subscription|api-key
--codex-auth chatgpt|api-key
```

Subscription/ChatGPT login is the default. API-key modes require the
corresponding environment variable. The unselected key is not silently used.

## Inspect, report, and deliver

These commands are offline and do not load a provider:

```bash
validation-architect-design list ~/code/product
validation-architect-design report <runId> ~/code/product
validation-architect-design deliver <runId> ~/code/product
validation-architect-design repos [~/code/product ...]
```

`report` derives a human summary and transcript projection from public
checkpoint facts. `deliver` lands `CampaignCheckpoint.artifacts` on
`validation-design/<runId>` through a temporary worktree rooted at the captured
source commit. Re-delivery of the same tree returns the same branch and commit;
the user checkout is untouched.

The fleet registry is UNKNOWN by absence. It is written only by campaign,
delivery, and fidelity completion paths and reports undelivered, uninstalled,
source-stale, fidelity-missing/stale/findings, or healthy state.

## Fixtures and bounded smoke

The design package ships three synthetic products:

| Fixture | Shape | Primary pressure |
| --- | --- | --- |
| `lumen-webapp` | C2 multi-tenant money workflow | state machines, payouts, UI adapter |
| `relay-backend` | C3 delivery daemon | ordering, DLQ, failover, time |
| `docsmith-agent` | C3 agentic LLM | evals, judge calibration, trajectories |

```bash
validation-architect-design fixture lumen-webapp --profile C2
validation-architect-design fixture relay-backend --smoke
```

Fixture materialization excludes `fixture.yaml`; the answer key is available
only to offline detectors and never enters a provider prompt. `--smoke`
defaults to C3 and admits one turn, so it terminates through the public limit
instead of a separate relay implementation. Both commands spend provider
quota and require explicit human authorization.

## Post-hoc judgment and fidelity

These commands are live and spend Claude quota:

```bash
validation-architect-design readers <runId> ~/code/product
validation-architect-design audit <runId> ~/code/product
validation-architect-design fidelity ~/code/product --wave 1 --run-id <id>
validation-architect-design fidelity ~/code/product --tickets HB-014,HB-015 --run-id <id>
```

Post-hoc readers/audit operate on a completed bundle and write operational
evidence without mutating campaign transition history. Fidelity refuses a
dirty checkout or red public `check()`, audits a remote-free captured revision,
accepts findings-only JSON (no patch field), and invalidates evidence if the
target moves during judgment. All use `LocalTurnPort` and `TurnLedger` stable
keys; none contains a second provider adapter or retry loop.

## Deterministic product CLI

In a product repository, the package remains the CI/compiler surface:

```bash
pnpm add --save-dev --save-exact @cormidia/validation-architect@0.5.0
pnpm exec validation-architect check .
pnpm exec validation-architect compile . --write
pnpm exec validation-architect plan . --changed src/example.ts
pnpm exec validation-architect explain CF-001 .
```

Spec detection follows the checked model, not a hardcoded language guess:
`model/project.yaml` may declare a reviewed `conventions` block naming a
runner preset (`jest-vitest` — the default, `pytest`, `go-test`, `junit`) or
`runner: custom` with explicit `spec_suffixes`, `test_call_pattern`, and
`header_comment_styles`. The resolved detection block is recorded in the
compiled identity; an unknown or ambiguous convention fails closed at compile
time and never silently falls back to JS/TS. Without the block, detection is
exactly the historical JS/TS behavior and existing corpora are unaffected.

The deprecated `validation-trace` alias remains only through 0.x as a bounded
bridge to `validation-architect check`; it is unrelated to campaign hosting.

## State layout

The default state home is outside the target checkout and keyed by target path:

```text
~/.local/state/validation-architect/design-runs/<target-key>/
  <runId>.json                       # sole CampaignCheckpoint
  runs/<runId>.json                  # non-transition operational metadata
  workspaces/<runId>/source/         # immutable remote-free product snapshot
  turn-settlements/*.json            # sole provider settlement ledger
  posthoc/<runId>/*.json             # readers/audit evidence
  fidelity/*.json                    # fidelity evidence
```

Existing ignored repository-local `runs/` data from development history is not
discovered, changed, or migrated.

## Repository map

| Path | Responsibility |
| --- | --- |
| `src/api/campaign-engine.ts` | sole provider-neutral campaign state machine |
| `src/api/campaign-contracts.ts` | envelope/checkpoint/bundle contracts and validators |
| `src/model*.ts` · `src/relationship*.ts` | checked compiler and graph |
| `src/core-cli.ts` | deterministic `validation-architect` CLI |
| `src/design/cli.ts` | sole live/operational campaign command |
| `src/design/provider-port.ts` | sole provider adapter and confinement policy |
| `src/design/turn-ledger.ts` | sole at-most-once settlement implementation |
| `src/design/run-context.ts` · `run-repository.ts` | immutable source and append-only intake |
| `src/design/delivery.ts` · `registry.ts` | offline publication and fleet state |
| `src/design/posthoc.ts` · `fidelity.ts` | fresh operational judgment |
| `fixtures/` | packaged synthetic products and offline-only answer keys |
| `skill/` | design, audit, and implementation skills |

## License and publication

`@cormidia/validation-architect` is licensed under the
[Apache License 2.0](LICENSE). See [NOTICE](NOTICE) and
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Copyright 2026 Bikram Gupta.

The source repository remains private for the initial release. Making it
public is a deferred owner decision; doing so later would enable npm provenance.
