# Campaign host consolidation before first release

Status: accepted implementation record for issue #78.

## Decision

`validation-architect-design` is the sole live campaign command. It composes
the provider-neutral public `design()` / `resume()` engine with the design
package's repository, campaign-store, provider, settlement, and operational
adapters. The root `validation-architect` command remains the deterministic
provider-neutral compiler/check/plan/report CLI; source-only `pnpm vda` is
removed.

The public `CampaignCheckpoint` is the only campaign transition state and the
design package's `TurnLedger` is the only provider-settlement authority. No
reader, writer, migration, or inspection path for the unreleased legacy
`RunState` is retained.

## Capability disposition

The wording in the first column is stable and checked by the offline suite.

| Unique pre-public host capability | Disposition | Target owner/component | Reason and acceptance boundary |
| --- | --- | --- | --- |
| **fixture/demo runs** | `replace` | `validation-architect-design fixture` composition | Keep the three synthetic product demos and answer-key isolation, but route every live turn through public `design()` / `resume()` and `LocalTurnPort`. |
| **immutable target capture** | `port` | design-package frozen target adapter | Run providers against an immutable captured source revision, never the mutable user checkout; keep delivery outside the engine. |
| **revision mode and source recovery** | `replace` | public checkpoint + frozen target adapter | Keep greenfield/revision detection, source provenance, and exact-revision resume. Drop legacy re-anchoring and all old-state recovery flags. |
| **model/auth configuration** | `port` | design CLI + `LocalTurnPort` | Keep per-seat models and subscription/API-key auth selection without adding another provider adapter. |
| **rambling/intake hot reload** | `port` | public checkpoint intake revision + design intake watcher | Keep optional/derived intent semantics and append-only hot reload at the next turn. Adding, removing, replacing, or truncating the source fails closed. |
| **transcript and human report generation** | `replace` | design operational reporter over checkpoint/settlement records | Generate one human report and transcript projection from public checkpoint facts; do not retain the old transcript/state machine. |
| **fresh readers and independent audit** | `replace` | public C3/C4 engine graph | The public engine already owns fresh sessions, reader convergence, two-iteration audit scope, dispositions, and final gating; delete the marker/prose implementation. |
| **post-hoc readers/audit** | `port` | design operational `readers` / `audit` commands | Retain separately invoked fresh judgment passes over a completed public bundle, with no mutation of campaign transition history and no hidden retry. |
| **branch delivery and idempotent re-delivery** | `port` | design delivery adapter | Retain temporary-worktree delivery from a completed public bundle, pinned to captured source identity and idempotent on one delivery branch. |
| **fidelity audit** | `port` | design fidelity operation over `LocalTurnPort` | Retain findings-only, immutable-source, closure-gated fidelity without a second Claude adapter or patch capability. |
| **fleet registry and staleness reporting** | `port` | design registry operation | Retain offline UNKNOWN-by-absence fleet reporting, written only by campaign/delivery/fidelity completion paths. |
| **live smoke behavior** | `replace` | bounded public-engine fixture admission | Keep an explicitly bounded fixture smoke that ends by an admitted public-engine limit; never use the superseded relay loop. |
| **old aborted/completed run inspection** | `drop` | none | Old `RunState` files remain local historical data only. New `list` / `report` inspect public checkpoints; there is no legacy compatibility path. |

## Local ignored runs

The existing ignored `runs/` directory is preserved untouched on this machine
as an operator-owned archive. Consolidation neither deletes it nor copies it
into product code, packages, tests, migrations, or commits. The new design
state home uses public checkpoints and does not discover legacy runs.

## Required end state

- One campaign transition implementation: public `design()` / `resume()`.
- One provider settlement implementation: design `TurnLedger`, with
  reconciliation-only replay and no blind stateful retry.
- One confinement implementation: design `LocalTurnPort` policy and OS sandbox.
- One documented live journey: `validation-architect-design`.
- Provider SDKs remain outside the core runtime dependency closure.
- Legacy host source, `RunState`, recovery flags, markers, provider adapters,
  and host-only tests are deleted after their retained capabilities have moved.
