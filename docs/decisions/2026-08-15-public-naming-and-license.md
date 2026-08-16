# VA-API-001 — Public package names, result schema ID, trace-alias transition, and license

Status: **ratified** 2026-08-15 by the repository owner (Bikram Gupta).
Closes [#25](https://github.com/cormidia/validation-architect/issues/25); the
license section also implements the decision recorded in
[#29](https://github.com/cormidia/validation-architect/issues/29).

Authority: the final API/package contract
(`research/2026-08-13_validation-architect-redesign/validation-architect-api-contract.md`,
§§6, 8–10, 12–13; D4, D5, D8, D9) and the locked result semantics of
VA-CORE-004 ([#22](https://github.com/cormidia/validation-architect/issues/22)).
This record chooses public spellings and lifecycles only. It changes no result
semantics, reserves no registry name, creates no tag, and publishes nothing.

## Pre-publication candidate correction — 2026-08-15

Version `0.3.0` remained an unpublished release candidate. VA-CORE-008 (#40)
therefore advanced the lockstep candidate to `0.4.0`; status-aware closure
(#42) advanced it to `0.4.1`; and the ratified atomic-cutover correction (#44)
advanced it to `0.4.2`. Exact credential-token boundaries and authorization
projection (#46) advanced it to `0.4.3`; public compiler-report closure (#48)
advances it to `0.4.4`. None was published. In Decision 2 below, the historical
phrase "first public release" now applies to `0.4.4`; the retained-through-0.x
alias lifecycle, warning, and 1.0 removal decision are unchanged. The #44
correction adds only the bounded legacy-flag bridge recorded below. No package
name was reserved and no tag or release was created by these corrections. The
#46 and #48 corrections change no schema, method, campaign, or provider
contract.

## Decision 1 — Package names: the bare pair

| Surface | Spelling |
| --- | --- |
| Core npm package | `validation-architect` |
| Design npm package | `validation-architect-design` |
| Core import | `import { check, plan, design, … } from "validation-architect"` |
| Core subpath imports | `validation-architect/schemas/<name>.schema.json` (only paths matched by `exports`) |
| Design import | `validation-architect-design` (CLI-first; programmatic adapters exported) |
| Core binary | `validation-architect` |
| Design binary | `validation-architect-design` |
| Deprecated alias binary | `validation-trace` (see Decision 2) |

Binary names are stated independently of the npm names and happen to coincide
with them.

**Evidence** (read-only registry check, 2026-08-15, `registry.npmjs.org`):
`validation-architect` → 404 not found; `validation-architect-design` → 404 not
found; `@validation-architect/core` → 404 not found. All candidate names are
unclaimed; availability did not force the choice.

**Why the bare pair.** Continuity: the existing package metadata, enablement
handoff (`enablement/INSTALL.md`), CI example, and every downstream reference
already spell `validation-architect`, so exact-pin migration cost is zero for
the core name. The name-reservation plan in #29 already targets the bare core
name. No npm organization/scope has to be created or governed. CLI ergonomics
are identical either way because binary names are independent of package names.

**Rejected: the scoped pair** (`@validation-architect/core` +
`@validation-architect/design`). Reads marginally better in imports and would
reserve a namespace, but requires creating and administering an npm scope,
renames the package that all current instructions reference, and buys nothing
the two-name pair does not already provide. Namespace squatting risk is
accepted; the design-package name is claimed at first publication alongside the
core name.

## Decision 2 — `validation-trace` alias: retained through 0.x, removed at 1.0

| Property | Value |
| --- | --- |
| Alias target | Without legacy flags, `validation-architect check` — the alias runs the same code path |
| Bounded cutover bridge | The alias alone accepts historical `--manifest`/`--tests`: zero model files selects retained legacy closure; any model file selects checked-model closure without fallback, maps `--tests`, and makes `--manifest` a visible no-op |
| First deprecated version | `0.4.4` (the current first-public-release candidate; `0.3.0`–`0.4.3` remained unpublished) |
| Last supported version | the final `0.x` release |
| Removal version | `1.0.0` |
| Warning behavior | one deterministic line on stderr on every invocation: `validation-trace is a deprecated alias for "validation-architect check" and will be removed at 1.0.` |
| Exit codes | Without legacy flags, identical to `validation-architect check`; bridge invocations preserve the exit status of the authority selected by model-file presence; warnings never alter exit status |

**Why retained.** Three in-flight consumers reference `validation-trace` today:
the completed trace issue (#5), the enablement CI handoff
(`enablement/ci/validation-trace.yml`), and cormidia/Cormidia#431. Removal at
immediate removal from the then-`0.3.0` candidate would require proving all
three migrate in one coordinated change,
including one in a downstream repository this workstream must not edit. A
deprecated alias with identical default behavior costs one shim file and makes
the rename observable instead of breaking.

**Atomic-cutover bridge.** Cormidia's exact source-revision contract exposed a
self-reference: a squash PR cannot both change product/tooling files and embed
its own future squash SHA. A preparatory product/tooling PR followed by a
`validation-design/`-only cutover is exact, but 0.4.1 could not keep the legacy
gate alive during preparation. The owner ratified #44's narrow bridge. It is
not a read-time migration and never creates dual authority: no model file means
legacy closure; the first model file irreversibly selects the checked path for
that invocation, including when the model is partial, corrupt, or stale. The
public `validation-architect check` command remains checked-model-only.

**Downstream changes required before 1.0** (migration owners):

| Consumer | Change | Owner |
| --- | --- | --- |
| `enablement/ci/validation-trace.yml` | invoke `validation-architect check`; rename workflow file | #17 (packaging) updates the shipped template; product repos pick it up on next enablement refresh |
| `enablement/INSTALL.md` | install/run instructions move to `validation-architect check` | #17 |
| cormidia/Cormidia#431 | CI/gate invocation moves to `validation-architect check` | Cormidia adapter work (research doc §11); not edited from this repository |

**`validation-trace generate` disposition.** The compiled trace CLI's
`generate` subcommand is superseded by the supported `compile` workflow; #17
must either route it to `validation-architect compile` with a deprecation
warning or remove it with a detector proving no shipped documentation still
references it. The alias promise above covers only `check` semantics.

## Decision 3 — Result schema ID: `validation-architect/result/v1`

The canonical public schema ID for the VA-CORE-004 result record is
**`validation-architect/result/v1`**. The alternative `validation-result/v1`
(core §9.5's spelling) is rejected and must never be writable.

**Why.** The merged core already writes the chosen ID
(`src/versions.ts`: `RESULT_SCHEMA = "validation-architect/result/v1"`), and it
is namespace-consistent with the other five published schema IDs
(`validation-architect/corpus/v1`, `case-catalog/v1`, `plan/v1`,
`design-run/v1`, `provenance/v1`). Nothing has been published under either
spelling, so no compatibility reader is needed. This record changes none of
VA-CORE-004's semantics: the three axes (applicable, complete, verdict), five
reasons, green predicate, record contents, and namespaced-extension rule are
untouched.

The full published schema set is therefore:

| Schema ID | Artifact |
| --- | --- |
| `validation-architect/corpus/v1` | design model corpus |
| `validation-architect/case-catalog/v1` | generated catalog manifest |
| `validation-architect/result/v1` | one run outcome (VA-CORE-004) |
| `validation-architect/plan/v1` | explained test plan |
| `validation-architect/design-run/v1` | campaign request, envelope, resumable state |
| `validation-architect/provenance/v1` | versions, revision, profile, run identity |

## Decision 4 — License: FSL-1.1-MIT supersedes contract D9 (MIT)

Contract D9 selected MIT. The later licensing decision of 2026-08-14
(cormidia/Cormidia `research/2026-08-14_licensing-and-gtm-structure.md`, D1 and
D10; issue #29) adopts **FSL-1.1-MIT** for this repository and its packages,
matching Cormidia. The owner ratified the supersession on 2026-08-15.

| Property | Value |
| --- | --- |
| License | Functional Source License 1.1 with MIT future grant (`FSL-1.1-MIT`) |
| `package.json` `license` | `LicenseRef-FSL-1.1-MIT` (FSL has no registered SPDX identifier) |
| License file | `LICENSE.md`, shipped in every published tarball |
| Copyright line | `Copyright 2026 Bikram Gupta` |
| Plain-English terms | free to read, use, modify, and self-host, including commercial internal use; may not be offered as a competing product or service; each released version becomes MIT on its second anniversary |
| Vocabulary | **fair source** — never described as open source while under FSL |

Consequences for downstream issues: every acceptance criterion in #17 and #28
that reads "MIT" is amended to expect `LicenseRef-FSL-1.1-MIT` metadata plus
the bundled `LICENSE.md`; the release-candidate detectors check for that pair
and for the absence of `${year}`/`${licensor name}` template placeholders. The
FSL conversion clock runs per released version, so name reservation uses a stub
and real publication waits for correct license metadata (#29's sequencing
note). The npm name-reservation stub and CLA adoption remain owner actions
outside this record's authority.

## Conformance detectors specified for downstream issues

The following red-capable checks are required of #16/#17/#28 (some land
immediately with this record in `test/public-contract-decision.test.ts`):

1. **Stale package name** — no shipped manifest, doc, or example spells a
   scoped `@validation-architect/*` package.
2. **Forbidden combination** — exactly two publishable manifests exist, named
   `validation-architect` and `validation-architect-design`; any third
   publishable manifest fails.
3. **Version skew** — the design manifest depends on the core manifest at
   exact equality; any range or mismatch fails.
4. **Dual result IDs** — the string `validation-result/v1` appears in no
   writer, schema asset, or fixture; `validation-architect/result/v1` is the
   only result schema ID in the tree.
5. **Stale release number** — no doc or manifest presents `0.2.0` as the
   planned public release.
6. **Alias presence** — through 0.x, the core package ships a `validation-trace`
   bin that warns deterministically and exits identically to `check` without
   legacy flags. The bounded legacy bridge is model-presence fail-closed; at
   1.0 a detector flips to asserting the alias and bridge are absent.
7. **License pair** — manifests declare `LicenseRef-FSL-1.1-MIT`, tarballs ship
   `LICENSE.md`, and the notice names the confirmed holder with no template
   placeholder.

## What a fresh consumer needs to know

Install: `npm install --save-dev --save-exact validation-architect` (CI gate),
`npx validation-architect-design@<exact>` (standalone campaigns). Import:
`validation-architect` for all nine public functions, ports, types, and
schemas. CLI: `validation-architect check|plan|explain|compile|report`;
`validation-architect-design [.|resume <id>]`; `validation-trace` keeps working
until 1.0 with a deprecation warning. Result records: read and write only
`validation-architect/result/v1`. License: fair source (FSL-1.1-MIT), MIT two
years after each release.
