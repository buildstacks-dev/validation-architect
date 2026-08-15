# Release runbook

Releases are a separately approved critical operation. Nothing in the
repository — merged PRs, green CI, a built candidate — is itself release
approval. The private source repository stays private; publishing packages
does not change its visibility.

## Producing and approving a candidate

1. From the exact commit to release, with a clean tree:

   ```bash
   node scripts/release-candidate.mjs
   ```

   It refuses a dirty tree, verifies lockstep versions, builds both packages,
   packs both tarballs, and prints the **approval preview**: commit, tag, both
   package names/versions, and both sha256 digests.
2. The human owner reviews that preview and, to release, dispatches the
   `release` GitHub Actions workflow with exactly those four inputs (commit,
   tag, both digests). Any rebuild that changes a digest voids the preview —
   produce a new one; never edit inputs to match.
3. `verify-candidate` rebuilds from that commit, runs the full offline suite
   and the two-tarball smoke, and fails on any tag/version/lockstep/digest
   mismatch or dirty tree.
4. The `publish` job waits on the protected **`npm-publish` environment**
   (configure required reviewers in repository settings — that approval, bound
   to the exact previewed inputs, is the release authorization). It uses npm
   trusted publishing with provenance; no long-lived token exists. Publish
   order is core first, then design; a preflight refuses any version that
   already exists.

## Reconciliation — partial or ambiguous outcomes

Never unpublish, overwrite, blindly rerun, or bump a version merely to escape
an ambiguous state. Inspect first:

| Observation | Meaning | Action |
| --- | --- | --- |
| Preflight says a version already exists | A previous run (or someone else) published it | Inspect `npm view <pkg>@<v>` provenance/commit. If it is this exact candidate, the remaining package may be published by rerunning after removing the published one from scope — do this manually with `npm publish <tarball> --provenance` for ONLY the missing package, from the same downloaded artifact. If it is not this candidate, stop and investigate ownership. |
| Core published, design failed | Partial lockstep | Publish ONLY the design tarball from the run's `candidate-tarballs` artifact (digest-verify first). Do not rebuild. |
| Publish step timed out / ambiguous response | Registry state unknown | `npm view` both names at the version. Treat "exists with matching provenance" as published; "missing" as unpublished; anything else as a support case. |
| Digest mismatch in verify | The commit does not reproduce the preview | The candidate is void. Produce a new preview; investigate nondeterminism before retrying. |

Record for every release: package names, versions, tarball digests, commit,
tag, workflow run URL, and the registry's provenance statements.

## Version rules

- Both packages release at one exact lockstep version; the design manifest
  pins the core at exact equality (pnpm rewrites `workspace:*` on pack).
- Package SemVer is the released identity of code, prompts, and skills; a
  method/prompt change is at least a minor and appears in the changelog.
- Consumers exact-pin.
- Each released version starts its own FSL two-year MIT conversion clock —
  prefer few, deliberate releases over fast-iterating ones.
