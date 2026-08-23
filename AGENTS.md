# AGENTS.md

## What this repo is

Validation Architect publishes a provider-neutral checked validation compiler
and campaign engine plus one provider-bound design composition. Read
`README.md` first; it is authoritative on usage, optional rambling semantics,
reader/audit convergence, immutable capture, delivery, fidelity, and the
anti-rubber-stamp design.

## Commands

- `pnpm install` · `pnpm typecheck` · `pnpm test` · `pnpm test:package` are
  offline. Corepack must select the pinned pnpm version.
- `validation-architect-design <target> --profile C0..C4` and `resume` are the
  only live campaign start/resume commands and spend both providers as the
  profile requires.
- `validation-architect-design fixture ...`, `readers`, `audit`, and
  `fidelity` are live/provider-spending. Never run them without explicit human
  approval.
- `validation-architect-design list`, `report`, `deliver`, and `repos` are
  offline operational commands.

## Architecture invariants

- **One transition state.** `CampaignCheckpoint` in
  `src/api/campaign-contracts.ts` is the only campaign state. Do not add a
  parallel host state machine or compatibility for unreleased historical
  formats.
- **One settlement path.** Every provider turn uses
  `src/design/turn-ledger.ts`. Reconcile before work; ambiguous stateful turns
  fail closed and are never blindly retried.
- **One provider/confinement adapter.** All Claude/Codex seats use
  `src/design/provider-port.ts`. Keep read-only filesystem/tool policy, OS
  sandbox, no-network settings, identity checks, and explicit auth selection.
- **Immutable source.** Campaign and fidelity providers see remote-free
  captured revisions, never the mutable user checkout. Delivery stays outside
  the core engine and never switches the user checkout.
- **Offline suite.** Nothing under `test/` may call a real
  provider. Live behavior uses scripted fakes unless a human separately
  authorizes a live smoke.
- **Fixture answer keys stay hidden.** `fixtures/*/fixture.yaml` is for
  offline checks only. Materialized campaign source must exclude it.
- **Prompts and schemas are load-bearing.** Preserve provenance separation,
  owner challenge, no taste re-litigation, reader independence, audit-2
  verification-only scope, and findings-only fidelity. Do not weaken them to
  make a campaign flow smoothly.
- **Convergence is a contract.** C3/C4 reader passes, the two-iteration audit
  maximum, and the stakeholder feedback cap are enforced by the public graph
  and deterministic validators. Never add an unbounded recovery turn.
- **Bounds are admitted.** Absolute wall deadline, artifact files/bytes,
  structured history, prompt bytes, intake bytes, and per-turn output limits
  may be tightened but never enlarged or silently truncated.
- **Append-only intake.** The fixed optional human source may append in place.
  Add/remove/truncate/replacement/source substitution stops before another
  provider turn.
- **Completion-only fleet facts.** The registry is UNKNOWN by absence and is
  written only by campaign, delivery, and fidelity completion paths.

## Checked model and skills

The eight YAML files under `validation-design/model/` are machine authority;
generated Markdown is projection. Compiler-clean identity gates readers,
audit, delivery, and fidelity.

The skills under `skill/validation-harness-design/`,
`skill/validation-harness-audit/`, and `skill/implement-harness-ticket/` are
package artifacts. Design/audit contract changes land together with both
changelogs and `METHOD_VERSION` updates when required by
`test/six-layer-contract.test.ts`.

## Layout

- `src/api/` — public contracts, engine, schemas, entry points, conformance fakes.
- `src/model*.ts`, `src/relationship*.ts`, `src/validation-result.ts` —
  deterministic checked-model implementation.
- `src/design/` — sole live composition, settlement, capture, operations.
- `fixtures/` — packaged synthetic products.
- `test/` — offline red-capable verification, including `test/design/`.
- `runs/` — ignored historical local data; never migrate, commit, or delete it
  as part of product behavior.
