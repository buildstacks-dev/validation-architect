# Validation Architect core protocol

This is the compact reference for the provider-neutral records implemented by
the core. Product-specific probes, fixtures, runners, CI wiring, publication,
and public package names remain adapter or later API work.

## `validation-architect/result/v1`

Every result answers three independent questions:

| Axis | Values | Rule |
| --- | --- | --- |
| Applicability | `applicable`, `not_applicable` | Not applicable requires an accepted reason. |
| Completeness | `complete`, `incomplete` | Missing, stale, stopped, blocked, unauthorized, or unstarted required evidence is incomplete. |
| Verdict | `pass`, `fail`, `inconclusive` | A proven violation fails; insufficient evidence is inconclusive. |

Only `applicable + complete + pass` is green. `incomplete + pass` is invalid.
An applicable non-green record has exactly one reason:

| Reason | Example | Required response |
| --- | --- | --- |
| `product_failure` | A foreign-tenant row was observed. | Fix the product defect; it remains fail even if unrelated evidence is incomplete. |
| `prerequisite_unavailable` | The required process identity or offline package store was unavailable. | Repair the host prerequisite, then rerun; dependents do not start. |
| `harness_failure` | A fixture or reporter self-test failed. | Repair the harness before interpreting product evidence. |
| `evidence_incomplete` | A required test was skipped, stopped, stale, unauthorized, or not run. | Collect the missing exact-revision evidence. |
| `traceability_broken` | A design family, test, status, or generated view disagreed. | Restore deterministic closure before fidelity judgment. |

Every applicable record identifies product revision, lane, environment, all
core versions, owning product structure/root/owner, every affected case, and
integrity-bound evidence. Affected cases use stable statuses and explicit
`blocked_by` edges; no summary removes them. Optional plan data retains selected
scope, conservative expansions, and unresolved mappings.

Host detail lives only under dotted, namespaced extension keys such as
`validation-architect.trace` or `host.example`. Extensions cannot shadow core
fields. Canonical JSON and YAML sort keys and case/evidence IDs; both parse back
through the same validator. Evidence integrity is SHA-256 and can be rechecked
against artifact bytes.

A mixed result may be `applicable + incomplete + fail/product_failure`: one
case contains direct failure evidence while an unrelated case remains
inconclusive. The product failure is never downgraded. A required skip is
`applicable + incomplete + inconclusive/evidence_incomplete`, never pass.

Local and CI records retain their different environment names. For the same
revision and lane, their parity fingerprint agrees only when axes, reason,
plan, cases, versions, and evidence agree.

## Startup and declared causality

Core capability descriptors name an ID, meaning, owner, relative cost, and
explicit dependencies. Hosts implement probes. Core validates the graph,
orders foundational probes before their dependents and cheaper ready probes
first, and starts a declared dependent exactly once only when all prerequisites
are available. The conformance fixtures cover process identity, offline package
store availability, and live-child startup without performing those checks.

An outer launcher can wrap failure before the library or test framework loads
in a bootstrap envelope. The mapping emits an incomplete/inconclusive
`prerequisite_unavailable` result, preserves every suppressed case, and redacts
seeded credential/token values from machine and human output.

Causal reduction follows only `blocked_by` edges. It never groups by equal
messages, stacks, timing, or similar names. Each root projection leads with
meaning, owner, next action, and every affected case ID. Independent failures
remain in the ungrouped ledger; all cases remain in the machine record. Missing
roots, cycles, duplicate cases, and cross-run identities are rejected.

These meanings do not collapse campaign completion, design-audit verdict,
fidelity status, trace closure, evidence completeness, or product behavior into
one boolean. Boundary mappings preserve each native record in a namespaced
extension while applying the common axes and green predicate.

## Trace, explain, and role views

The model-native relationship graph is the one shared mapping:

`changed path → product structure → validation family → test → evidence`

Inventory and evidence are injected repository facts bound to an exact
revision/environment; neither can redefine the checked model. Queries accept an
exact structure/contract, family, test, evidence ID, or path and walk both
directions. Explanations lead with protected product meaning, then retain stable
IDs, provenance, owners, layer/oracle, controls, tickets, paths, hashes, and the
graph identity. Unresolved selectors and missing hops are records, never empty
successes. Traversal is visited-node bounded, so malformed cycles cannot loop.

Author, architect, Reviewer, and operator views are generated from the same
graph identity. They respectively emphasize affected meaning/commands/unknowns;
enumeration/ownership/rationale/findings; protected meaning/exclusions/controls/
evidence; and first cause/affected cases/next action/run identity. No view is a
separate authority or independently editable artifact. The generated planned
trace also carries the complete, ID-ordered source registry so its provenance
references resolve to kind, path, locator, and quote inside the fresh-reader
surface; absent optional fields remain explicit.

The named `Validation Trace` contract detects missing implementation, orphan
tests, false landed status, missing owners, broken sources/structures/negative
controls, planned-path drift, absent or invalid evidence, missing test roots,
runtime identity mismatch, and stale generated views. Structural artifacts may
close a link while remaining explicitly partial evidence. Trace proves closure,
not oracle fidelity; independent fidelity review remains separate.

For the public RepositoryPort composition, the checked model's exact
`planned_tests` paths own current test/family links. The adapter observes which
spec paths and executable call sites exist at the exact revision, then joins a
path to every reviewed family and control that plans it. Legacy first-comment
CF/HB tokens remain annotations only: they cannot create, rename, or reject a
current model relationship. An observed spec planned by no current family is a
red orphan, and a missing header or executable call remains a structural red.

Implementation closure is backlog-status-aware without becoming green by
absence. An implementable family with no observed implementation is an explicit
partial `IMPLEMENTATION_PENDING` finding while its known owner ticket is
`pending`, `blocked`, or `parked`; planned paths are future work in those
states. The same absence with a `landed` or unknown owner is red, and a landed
owner additionally produces `LANDED_STATUS_FALSE`. Pending partials therefore
remain `inconclusive`/`incomplete`, never pass.

The current CLI route is:

```bash
pnpm exec validation-architect check . --tests-root <tests-root>
```

`validation-trace` is the deprecated 0.x alias for this exact `check` path.
`validation-architect check` itself never accepts legacy flags. The alias alone
has a bounded bridge for historical `--manifest`/`--tests` invocations: with no
checked-model file it runs retained legacy closure; the presence of any one of
the eight model files selects checked-model closure for that invocation, maps `--tests`
to `--tests-root`, and makes `--manifest` a visible no-op. Partial/corrupt
models therefore fail without legacy fallback. The bridge and alias disappear
at 1.0. Hosts own repository reads and CI wiring; core graph inputs are
provider- and product-neutral.

## Conservative changed-path impact planning

Hosts inject changed paths/symbols, versioned mapping records, exact commands,
and the full-CI command. Core never reads Git and never executes the returned
commands. A plan always lists changed inputs, affected meaning, structures,
families, tests, paired negative controls, always-run safety checks, expansions,
unknowns, exact injected commands, and exact model/graph/inventory/mapping/
revision/lane identities.

Selection is advisory. Missing, uncertain, ambiguous, corrupt, stale, unsafe,
or structural mappings; absent inventory; graph reds; unimplemented families;
missing paired controls; and missing exact commands widen to the full applicable
lane. Widening may add work but never silently removes it. Likely-first commands
cannot remove or duplicate the authoritative full required CI command, whose run
count remains exactly one.

The offline benchmark labels advice trustworthy only with zero missed required
families across generated rules, representative history, deliberate corruption
negatives, and independently reviewed shadow comparisons. Recall counts misses;
extra selections and planning latency are reported separately. Even perfect
recall does not authorize future CI omission. The plan's selected scope,
expansions, and unresolved mappings round-trip through `validation-architect/result/v1`.

## Versions and explicit migration

Every accepted model, result, relationship graph, impact plan, campaign state,
and compiled bundle carries the exact package, method, model, compiler, policy,
result, and golden-set versions that interpret it. Accepted bundles also bind
model identity plus source and generated-surface fingerprints into one hash.
Mixed bundles are semantic mismatches even when an individual schema major
looks familiar.

The current release line is pre-1.0: it reads and writes only the exact current
clean schema and promises no legacy compatibility. The legacy catalog importer
and legacy target re-anchor are named recovery inputs, not silent schema reads.
The importer preserves only explicitly reviewed ticket dependencies and split
statuses; it never derives those facts from legacy prose, and the resulting
canonical dependency graph must have known, non-self, acyclic edges.

At stable 1.0+, the compatibility matrix is deliberately narrow:

| Input | Ordinary read | Explicit migration |
| --- | --- | --- |
| Exact current major and semantic bundle | accepted without mutation | only the named `no-op-current` acknowledgement; not an upgrade |
| Exact immediately previous major bundle | rejected | accepted only by a named, reviewed previous→current definition |
| Two-or-more majors old, unknown, or mixed bundle | rejected | rejected |

A migration plan records source identity, exact source/target bundles, a
distinct migration name, and integrity-bound approval evidence. Apply clones
the source, writes only a new current-major artifact, validates required
meaning, and records output hash plus validation result. Output is deterministic
for identical inputs. Atomic writes never target the source path; partial,
interrupted, tampered, unreviewed, or hash-mismatched output is rejected.

Campaign resume checks versions before providers or repository mutation. A
mismatch refuses while preserving `pending`. An old unversioned pre-1.0 run may
use the explicit `adopt-current-pre1-after-compiler-validation` recovery only
when it has no accepted unversioned compilation; the recovery records the
pending-message identity before and after. A meaning-bearing accepted corpus
requires the reviewed migration workflow instead. Hosts own dependency updates,
artifact storage, orchestration, and publication; core performs no implicit
upgrade, ratification, release, or Git action.
