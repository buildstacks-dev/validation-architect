# Changelog

Package SemVer is the single released identity of the code, the prompts, and
all three skills (their own CHANGELOGs remain as readable history).

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
