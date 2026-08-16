# Changelog

Package SemVer is the single released identity of the code, the prompts, and
all three skills (their own CHANGELOGs remain as readable history).

## 0.4.5 — fresh-reader and migration fidelity (unreleased)

- Generated `planned-trace.md` now carries a complete deterministic source-ID
  registry with kind, path, locator, and cited quote, so the isolated
  fresh-reader bundle can resolve every provenance reference without YAML
  access.
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
