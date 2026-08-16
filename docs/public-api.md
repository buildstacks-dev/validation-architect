# Public API

The supported import surface lives in `src/api/` and is re-exported from one
module (`src/api/index.ts`; the package `exports` map serves it as the root
import). Importing it performs no effect: no file read, socket, subprocess,
credential, or provider SDK. Result/plan/corpus meaning is owned by the core
protocol ([core-protocol.md](core-protocol.md)); this layer only exposes and
runtime-validates it. Naming and schema IDs are ratified in the
[decision record](decisions/2026-08-15-public-naming-and-license.md).

**Install.** `npm install --save-dev --save-exact validation-architect` and
`import { check, plan, design, … } from "validation-architect"`; the six
schema assets are importable as
`validation-architect/schemas/<name>.schema.json`, and deep imports into
`dist/` are refused by the `exports` map. Standalone provider-bound campaigns
install the lockstep companion package `validation-architect-design` (its CLI
composes `design`/`resume` with local fs/git/store/SDK adapters). The
`validation-architect` CLI (`check`/`compile`/`plan`/`explain`/`report`) ships
with the core package; `validation-trace` stays a deprecated alias for
`validation-architect check` until 1.0.

## The effect boundary: three ports

Hosts inject every effect through exactly three ports. There is no fourth seam
— no publication, branch, exec, credential, or settlement port.

| Port | Methods | Used by |
| --- | --- | --- |
| `RepositoryPort` | `revision()`, `readFile(path)`, `listFiles(globs)`, `changedPaths(base, head)` — read-only | every entry point |
| `TurnPort` | `runTurn(request)` | campaign only (`design`/`resume`) |
| `CampaignStorePort` | `load(runId)`, `save(checkpoint, expectedGeneration)` — compare-and-swap | campaign only |

The test inventory is derived through repository reads, never supplied as a
port. `FakeRepositoryPort`, `ScriptedTurnPort`, and `InMemoryCampaignStore`
are exported conformance fakes; every example below runs offline with them.

## The seven deterministic entry points

Pure functions of the corpus plus repository facts; identical validated facts
give identical data. All of them refuse unsupported schema majors with the
typed `unsupported_schema_major` failure before any partial output.

```ts
import {
  compile, check, explain, plan, ingest, render, migrate,
  FakeRepositoryPort, isGreenValidationResult,
} from "validation-architect";

const repo = new FakeRepositoryPort({ revision: "abc123", files: { /* … */ } });

const compiled = await compile(repo);        // author findings + regenerated views (data)
const gate = await check(repo);              // fail-closed result/v1 record for CI
const why = await explain(repo, "CF-X01-S"); // graph query + prose, unresolved hops explicit
const suite = await plan(repo, []);          // full-suite plan + capability requirements
const delta = await plan(repo, ["src/x.ts"]);// changed-path plan; unknowns expand to full suite
```

- **`compile` vs `check`**: `compile` answers an author (source-located
  findings, regenerated views); `check` answers a gate (one fail-closed
  `validation-architect/result/v1` record). A closed trace whose evidence is
  structural-only is reported `inconclusive`/`incomplete` — the trace proves
  closure, never product green (`isGreenValidationResult` stays false). Broken
  closure is `fail`/`traceability_broken`.
- **`plan(repo, [])`** is the supported environment/full-suite question.
  Unknown, uncertain, stale, or structural mappings expand to the full
  applicable suite; the plan is advisory and the full required CI run stays
  authoritative. Optional impact mappings are read from
  `validation-design/impact-mappings.yaml`.
- **`ingest(output, ctx)`** normalizes evidence into the result record:
  `validation-result` (re-validated, never trusted), `relationship-trace`,
  `startup-conformance`, `bootstrap-failure`. Incomplete evidence never
  renders as a pass.
- **`render(view, facts)`** projects `author | architect | reviewer |
  operator` prose from one graph + query identity; it adds no fact.
- **`migrate(corpus, to)`** is the only upgrade path (currently: the explicit
  reviewed `legacy-catalog` import to `validation-architect/corpus/v1`).
  Already-canonical legacy rows retain the compact review form. Composite
  placement uses explicit family outputs and actionable ticket outputs; the
  caller supplies every current ID, layer, lane, owner, provenance link,
  structure link, control, implementation, and ticket relationship. A complete
  reviewed target policy may replace the
  canonical fallback. The returned deterministic ledger accounts separately
  for every legacy family, first-owner ticket relationship, non-owning ticket
  citation, and historical ticket with no actionable family. Composite prose
  is never parsed into current meaning, and ordinary loads never mutate or
  reinterpret.

## Campaign contracts (used by `design`/`resume`)

- **Envelope** (`design-run/v1`, kind `envelope`): profile C0–C4, seats with
  session lifecycle (`persistent` seats start once then resume their exact
  native session; `fresh` seats are new every turn) and independence
  dimensions (`provider` / `model` / `session`), a finite sequence or bounded
  transition graph with per-transition turn costs and terminals, and limits.
  A host admits the envelope before the first turn; the library never
  enlarges it.
- **Checkpoint** (`design-run/v1`, kind `checkpoint`): generation, exact
  package version, source revision, envelope, position, the pending
  idempotency key saved *before* a turn is invoked, accepted receipts, native
  session identities, admitted repository/intake snapshot, and unwritten
  artifacts. `save` names the generation it extends; a stale generation raises
  `stale_generation` instead of overwriting. Before replay, the library
  reconstructs the exact pending request; the same idempotency key must then
  reconcile to one settled result without a second spend.
- **TurnResult** has no success-by-omission: `ok | refused | limit_exhausted |
  error` are all typed outcomes, and a host-supplied `parsed` value is
  re-validated against the requested schema, never trusted by presence.

## `design` and `resume`

```ts
import { design, resume } from "validation-architect";

const outcome = await design(
  {
    runId: "run-1",
    profile: "C2",                       // C0–C4; decides the exact turn shape
    intake: "Product summary and sources…",
    admit: async (envelope) => envelope,  // inspect/tighten before ANY spend; null refuses
  },
  { repository, turns, store },           // the three ports
);
```

Profiles are exact: C0 spends 1 turn (audit recorded as
`not_required_by_profile`, never clean), C1 spends 2, C2 spends 4, C3/C4 run
the bounded relay graph (60 relay exchanges, 3 fresh reader personas across
at most 3 passes, ≤2 audit iterations, ≤12 stakeholder
exchanges per audit window, 104 turns total; every turn is capped at 32,768
tokens and the campaign at 300 wall minutes). A host may tighten any bound;
the library never enlarges one. Designer and
Stakeholder are cross-provider persistent sessions; readers and auditors are
fresh sessions (an auditor may share the designer's model — session
independence is what the method requires). Identity is verified on every
requested dimension; a mismatch is the typed `identity_mismatch` failure.

Outcomes: `{ status: "complete", bundle }` with the unwritten corpus,
provenance, profile assessment (`escalationRequired` when findings support a
deeper tier — the run never upgrades itself), public audit verdict, and usage;
or `{ status: "incomplete", checkpoint, reason, nextAction }` with exactly one
of `turn_refused | limit_exhausted | turn_error | invalid_artifact`. A failed
run stays failed: `resume(runId, ports)` continues an *interrupted* campaign
(same package version, same source revision, untouched envelope), reconciles a
parked pending turn by its idempotency key without a second spend, and returns
the same typed failure for a settled one. Deterministic corpus checks run
after every artifact-producing turn; the engine writes nothing anywhere — the
caller publishes the bundle.

## Typed failures

`PublicContractError.code` is the machine discriminator (text is not):
`invalid_input`, `invalid_output`, `unsupported_schema_major`,
`version_mismatch`, `stale_generation`, `invalid_checkpoint`,
`identity_mismatch`. Test with `isPublicContractError(error, code)`.

## Schemas

Six published families, IDs in `PUBLISHED_SCHEMA_IDS`, runtime validators
exported per family (`validateCorpus`, `validateCaseCatalog`,
`validateResult`, `validatePlan`, `validateDesignRunCheckpoint`,
`validateProvenanceRecord`) plus canonical serializers. Machine-readable
mirrors ship under `schemas/*.schema.json`; the validators are authoritative.
Hosts may add namespaced extension fields to results and may never redefine an
existing field.
