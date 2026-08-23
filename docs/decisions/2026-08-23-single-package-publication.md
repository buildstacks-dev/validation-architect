# Single-package scoped publication

Status: **ratified** 2026-08-23 by the repository owner (Bikram Gupta).

This decision supersedes the package-name, package-count, and license choices
in `2026-08-15-public-naming-and-license.md`. It does not change the result
schema, CLI names, campaign graph, settlement, confinement, or deprecated-alias
lifecycle recorded there.

## Rulings

1. Publish one package, `@cormidia/validation-architect@0.5.0`. The former
   design package moves under `src/design/`, `test/design/`, and `fixtures/`.
   The `validation-architect`, `validation-trace`, and
   `validation-architect-design` binary names and behavior remain unchanged.
2. `@anthropic-ai/claude-agent-sdk@0.3.220` and
   `@openai/codex-sdk@0.146.0` are exact optional peers and exact development
   dependencies. Live turns load them dynamically; deterministic and offline
   commands do not load them. No other provider or harness is supported.
3. The first publication is Apache-2.0 with `LICENSE`, `NOTICE`, and the 2026
   Bikram Gupta copyright notice. The private repository may become public
   later, which would enable npm provenance; that is deferred, not release work.
4. The npm allowlist is `LICENSE`, `NOTICE`, `README.md`,
   `THIRD-PARTY-NOTICES.md`, `bin/*`, `dist/**`, `src/**`, `schemas/**`,
   `enablement/**`, `skill/**`, and `fixtures/**`. Tests, docs, research, and
   `.env`-shaped files never ship.
5. Only the scoped name is published, with public scoped-package access. The
   two former bare package names are never published.
6. Releases use one approval-sealed tarball and OIDC trusted publishing from
   the protected `npm-publish` environment. Registry reconciliation publishes
   when absent, does nothing for identical integrity, and fails closed for
   different or ambiguous integrity. The owner performs the one-time local
   bootstrap publication from the sealed tarball and handles every credential,
   tag, environment, and approval action.
7. Package metadata points to `cormidia/cormidia-web` as the public landing
   page. Its three-package README is updated in a separate post-publication PR.

The source repository stays private for the initial release, so the workflow
deliberately omits npm provenance. Repository metadata continues to name the
real private source repository.
