# Validation harness enablement

This directory is the executable handoff that accompanies the ratified design corpus. It deliberately does not rewrite the product repo's package manifest, agent instructions, or CI configuration without review.

1. Pin the architect package in the product repo (use the exact released
   version, or the exact `.tgz` release artifact before registry publication):

   ```bash
   pnpm add --save-dev --save-exact validation-architect@0.4.13
   ```

2. Install `skills/implement-harness-ticket/` in the repository's supported agent-skill location (for example `.agents/skills/implement-harness-ticket/`) and land the ratified `validation-design/agents-md-contribution.md` in the standing agent instructions.
3. Review `ci/validation-trace.yml` (the workflow file keeps its historical name through 0.x; it now invokes `validation-architect check`), then copy it into the repository's CI workflow directory. It assumes the package and lockfile from step 1 are committed.
4. Prove the same command locally before enabling the gate:

   ```bash
   pnpm exec validation-architect check . --tests-root <tests-root>
   ```

This invokes the checked-model graph through the public `check()` entry point.
`validation-trace` remains a deprecated alias for the check through 0.x — it
prints one deterministic warning on stderr and is removed at 1.0; its former
`generate` subcommand is superseded by `validation-architect compile`. The
alias alone accepts historical `--manifest`/`--tests` during an atomic
cutover: zero checked-model files selects retained legacy closure, while any
model file selects the checked path without fallback (`--tests` maps to
`--tests-root`; `--manifest` has no effect). New installations use the command
above and never need the bridge. The
check proves deterministic closure only; the complete Core Checks suite still
runs, and fidelity remains a separate architect audit. A live
outcome-acceptance (`L-ACC`) campaign is never implied by installation or CI:
it still requires fresh human authorization for its target, scenario set,
spend/time ceiling, and permitted effects.
