# Changelog

Package SemVer is the single released identity of the code, the prompts, and
all three skills (their own CHANGELOGs remain as readable history).

## 0.4.12 — sourcing channels become policy schema (unreleased)

- VA-ENF-006 (#58): `policy.yaml` gains a `sourcing` block declaring the four
  standing case-sourcing channels (`acceptance-criteria`,
  `adversarial-derivation`, `production-incident`, `substrate-drift`),
  validated exactly like layers and lanes — all four declared
  (`MODEL_SOURCING_CHANNEL_MISSING`), active channels name a trigger,
  declared-empty channels carry a reason, and owners must resolve.
- The owner briefing renders the standing obligations. Legacy import carries a
  reviewed `sourcing` block or imports every channel declared-empty for later
  review. Method contract 0.8.5 in both skill CHANGELOGs.
- This makes the design skill's "recorded in the policy file as standing
  obligations" true rather than aspirational; fail-closed conversion of
  findings into claims is the companion issue's linkage.
- Tighten-only; breaking for existing corpora (pre-1.0 clean break). All
  shipped fixtures migrated.
- This is a pre-publication candidate correction. No package was published,
  tagged, or reserved by this change.

## 0.4.11 — per-lane wall-clock budgets (unreleased)

- VA-ENF-004 (#56): `ValidationLane` gains `max_duration_seconds`, required
  for every active test lane (`MODEL_LANE_BUDGET_MISSING` otherwise; a
  malformed value is a field error). Evidence lanes and declared-empty lanes
  are unaffected.
- Doctrine lands with the field: a breached budget is a defect against the
  harness, filed like any red (design skill lane section); the audit's
  gate-reality checklist compares declared budgets to observed CI durations.
  Method contract 0.8.4 in both skill CHANGELOGs.
- Budgets render in the owner briefing; the legacy fallback policy carries
  canonical starting budgets (120s inner-loop, 600s per-commit) for review.
- Tighten-only; breaking for existing corpora (pre-1.0 clean break): active
  test lanes declare budgets on recompile. All shipped fixtures migrated.
- This is a pre-publication candidate correction. No package was published,
  tagged, or reserved by this change.

## 0.4.10 — smoke-journey designation, fail-closed (unreleased)

- VA-ENF-003 (#55): `policy.yaml` gains `smoke_journey_ids` naming at least
  one `journey` structure as the always-green, must-run-on-merge smoke path.
  Missing designation is `MODEL_SMOKE_JOURNEY_MISSING`; a non-journey
  designation or a designated journey with no implementable `per-commit`
  family is `MODEL_SMOKE_JOURNEY_INVALID`.
- The owner briefing shows the smoke journey by name. Legacy import carries a
  reviewed designation into the canonical fallback policy; a reviewed policy
  carries its own. Method contract 0.8.3 in both skill CHANGELOGs.
- Tighten-only; breaking for existing corpora (pre-1.0 clean break): every
  corpus names its smoke journey on recompile. All shipped fixtures migrated.
- This is a pre-publication candidate correction. No package was published,
  tagged, or reserved by this change.

## 0.4.9 — contracts require typed error criteria (unreleased)

- VA-ENF-005 (#57): `contract` structures declare `error_criteria` beside
  `acceptance_criteria` — invalid-input behavior, typed errors, idempotency
  under retry. A happy-path-only contract rejects compilation with
  `MODEL_CONTRACT_ERROR_CRITERIA_MISSING` at the contract's source location.
- The boundary `failure_modes` requirement is unchanged; error criteria render
  in the generated structure routing table and owner briefing. Method contract
  0.8.2 in both skill CHANGELOGs.
- Tighten-only; breaking for existing corpora (pre-1.0 clean break): every
  contract structure must declare its error half on recompile. All shipped
  fixtures migrated in this change.
- This is a pre-publication candidate correction. No package was published,
  tagged, or reserved by this change.

## 0.4.8 — boundary failure modes must be covered or pruned by name (unreleased)

- VA-ENF-001 (#53): families may cite the declared failure modes they exercise
  as `covers_failure_modes: ["<structure-id>#<mode>"]`; the compiler rejects a
  **boundary** failure mode with no covering family and no named prune
  (`MODEL_FAILURE_MODE_UNCOVERED`, located at the boundary's own source line).
  A pruned family citing the same reference with its reason is the named prune.
- Dangling references — a missing structure, an undeclared mode, or a
  malformed `<id>#<mode>` string — reject compilation as broken links.
- Generated views render the coverage: `planned-trace.md` gains a
  failure-mode coverage table (covered / pruned / open) and `case-catalog.md`
  a "Failure modes covered" column, so a fresh reader sees the matrix without
  YAML access. Method contract 0.8.1 in both skill CHANGELOGs.
- Tighten-only and breaking for corpora that declare boundaries (pre-1.0 clean
  break): recompile with coverage links or named prunes.
- This is a pre-publication candidate correction. No package was published,
  tagged, or reserved by this change.

## 0.4.7 — declared negative controls must be implemented (unreleased)

- VA-ENF-002 (#54): the design↔inventory join fails closed when a declared
  negative control of an implementable test-lane family is implemented by no
  inventory test while its owner ticket is `landed` or unknown — the new red
  `CONTROL_UNIMPLEMENTED` diagnostic names the control. The join also reports
  `unimplemented_control_ids` alongside `unimplemented_family_ids`.
- Status-aware, mirroring the 0.4.1 implementation-closure semantics: the same
  gap under a `pending`, `blocked`, or `parked` owner ticket is the explicit
  partial `CONTROL_IMPLEMENTATION_PENDING` finding — inconclusive, never red,
  never green by absence. Evidence-lane families keep their controls outside
  the test inventory by construction.
- The checked-model trace host adapter now emits `control_ids` for citing
  specs from the checked model's family/control relationships, matching the
  public RepositoryPort composition; spec prose still cannot create or reject
  a control relationship.
- This closes the paper-only-control hole deterministically; whether an
  implemented control can actually fire remains the fidelity audit's judgment
  (the recurring falsifiability sweep is tracked separately).
- This is a pre-publication candidate correction. No package was published,
  tagged, or reserved by this change.

## 0.4.6 — reviewed family-output semantics (unreleased)

- Reviewed legacy-family outputs may override `oracle` and `risk` with exact,
  non-empty per-output values, preserving distinct statistical and mechanical
  semantics across one legacy family's split outputs.
- Omitted overrides retain the exact legacy oracle and risk; malformed or empty
  overrides fail closed rather than silently changing the compiled family.
- This is an additive migration-input correction only. It changes no model
  schema, method, campaign, provider, or ordinary checked-model load contract.
- This is a pre-publication candidate correction. No package was published,
  tagged, or reserved by this change.

## 0.4.5 — fresh-reader and migration fidelity (unreleased)

- Generated `planned-trace.md` now carries a complete deterministic source-ID
  registry with kind, path, locator, and cited quote, so the isolated
  fresh-reader bundle can resolve every provenance reference without YAML
  access.
- The same trace renders every product structure's protected meaning,
  acceptance criteria, failure modes, changed paths, provenance, and owner;
  absent optional lists are explicit rather than silently omitted.
- Explicit legacy ticket outputs now preserve reviewed per-output status and
  dependencies; compact ticket reviews preserve reviewed dependencies while
  continuing to inherit legacy status. Neither fact is inferred from prose.
- Ticket dependency review rejects malformed and duplicate IDs, while the
  canonical compiler rejects missing targets, self-references, and cycles.
- This is a pre-publication candidate correction. No package was published,
  tagged, or reserved by this change.

## 0.4.4 — canonical public compiler report (unreleased)

- Public `compile()` now returns the canonical `compiler/v1` report as typed
  data plus its deterministic two-space JSON bytes, alongside the unchanged
  findings and five generated Markdown views.
- RepositoryPort and workspace compilation share one ordered eight-file source
  fingerprint and one report builder/serializer, so identical model bytes
  produce byte-identical reports for both accepted and rejected input.
- `validation-architect compile --write` writes `compiler-report.json` with the
  five Markdown views, refuses report/view symlinks before any artifact write,
  and remains mutation-free without `--write`.
- This is a pre-publication candidate correction. No package was published,
  tagged, or reserved by this change.

## 0.4.3 — exact secret boundaries and authorization projection (unreleased)

- Credential-shaped `sk-...` values are detected only at a complete token
  boundary, so reviewed prose such as `risk-review-gated` survives byte-exact
  migration while standalone credentials remain redacted and red-capable.
- The generated owner briefing now projects each lane's reviewed title, kind,
  and authorization, including fresh `per-run-human` requirements.
- This is a pre-publication candidate correction. No package was published,
  tagged, or reserved by this change.

## 0.4.2 — atomic checked-model cutover (unreleased)

- Public repository facts now join observed specs to current families and
  controls through the checked model's exact `planned_tests` paths. Legacy
  first-comment CF/HB tokens remain historical annotations rather than a
  second machine authority; unplanned specs remain red orphans.
- The deprecated `validation-trace` alias has a bounded pre-model bridge for
  historical `--manifest`/`--tests` invocations. The first checked-model file
  selects checked-model closure permanently and fail-closed; the public
  `validation-architect check` surface remains unchanged.
- This enables a preparatory product/tooling squash followed by a
  `validation-design/`-only authority cutover bound to the exact preparation
  revision, without a gate gap or self-referential commit identity.

## 0.4.1 — status-aware implementation closure (unreleased)

- An implementable family whose known owner ticket is `pending`, `blocked`, or
  `parked` now records an explicit partial `IMPLEMENTATION_PENDING` finding
  when no implementation exists. It remains inconclusive and never green.
- Planned test paths are not drift while their owner ticket is non-landed;
  missing implementation under a landed or unknown owner remains red and
  landed status-honesty enforcement is unchanged.

## 0.4.0 — lossless reviewed legacy migration (unreleased)

- The public `migrate` review can normalize one legacy family into explicit
  canonical layer/lane outputs and split a legacy ticket into actionable
  single-layer/single-lane tickets without parsing composite prose.
- A complete reviewed target policy may replace the canonical import fallback,
  preserving product-specific lane triggers, authorization, exceptions, and
  criticality obligations without host inference.
- Migration evidence now carries a deterministic ledger for every legacy
  family and ticket. It separates ticket citations from first-owner work and
  retains no-owner tickets as historical evidence instead of emitting invalid
  empty backlog entries.
- Synthetic Cormidia-shaped negative controls cover dropped or duplicate IDs,
  unreviewed placement, layer/lane mismatch, missing historical disposition,
  unknown review IDs, and deterministic regeneration.

## 0.3.0 — first public release candidate (unreleased)

The corrected core/API/packaging boundary, superseding all `0.1.x` internal
tarballs and the abandoned `0.2.0` plan. Pre-1.0: no compatibility promise.

- Two lockstep packages split by provider-client construction:
  `validation-architect` (deterministic core + provider-neutral campaign
  engine + schemas + skills + core CLI; runtime dependency: `yaml`) and
  `validation-architect-design` (standalone provider adapters, local
  repository/store, campaign CLI; provider SDKs as ordinary dependencies).
- Public API: `compile`, `check`, `explain`, `plan`, `ingest`, `render`,
  `migrate`, plus provider-neutral `design`/`resume` over three injected
  ports (`RepositoryPort`, `TurnPort`, `CampaignStorePort`).
- Six published schema families with runtime validators and assets:
  `corpus/v1`, `case-catalog/v1`, `result/v1`, `plan/v1`, `design-run/v1`,
  `provenance/v1` (all under the `validation-architect/` ID namespace).
- `validation-trace` is a deprecated alias for `validation-architect check`
  (removed at 1.0); its `generate` subcommand now directs to
  `validation-architect compile`.
- Method: `rambling.txt` is optional — product intent may be derived from the
  repository's own documentation, with the intent source recorded.
- License: FSL-1.1-MIT (fair source; each release converts to MIT after two
  years). Previously UNLICENSED.
