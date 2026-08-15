# Release runbook

A merge, green CI run, or built tarball is not release approval. Publication
requires an approved candidate plus approval of the protected `npm-publish`
GitHub environment. The workflow never creates a tag or publishes on push.

## One-time configuration

1. Reserve both npm names and configure an npm trusted publisher for each:
   organization `cormidia`, repository `validation-architect`, workflow
   `release.yml`, environment `npm-publish`.
2. Configure the GitHub `npm-publish` environment with required reviewers and
   restrict it to the release branch/tag policy.
3. Keep the repository's workflow permissions at `contents: read`; the publish
   job alone receives `id-token: write`. Do not create an `NPM_TOKEN` secret.

Trusted publishing and provenance are separate npm features. OIDC trusted
publishing works for this private repository, but npm cannot generate public
provenance for a package built from a private source repository. Therefore the
workflow deliberately omits `--provenance` and both manifests omit a
`publishConfig.provenance` default. Revisit that decision if the repository
becomes public. The workflow pins Node 24 and npm 11.19.0; npm trusted
publishing requires npm 11.5.1 or newer and Node 22.14 or newer.

## Approve and publish one candidate

1. On the clean, merged commit on `main`, run:

   ```bash
   node scripts/release-candidate.mjs
   ```

   The script verifies the two package identities, lockstep version, pinned
   pnpm, built version constant, and a clean tree before and after packing. It
   prints the approval preview: commit, tag, package versions, and both
   tarball SHA-256 digests. It does not read npm, tag, or publish.
2. Review and approve those exact values. After approval, create the exact
   `vX.Y.Z` tag at the previewed commit and push that tag. Never move it.
3. Dispatch `.github/workflows/release.yml` with the preview's exact `commit`,
   `tag`, `core_digest`, and `design_digest` values.
4. The verification job checks the input shapes, checks out the exact commit,
   requires it to be on `main`, requires the existing tag to point to it, runs
   the full offline contract and package smoke, rebuilds both tarballs, and
   compares both digests.
5. Review that workflow run, then approve its protected `npm-publish`
   environment. The publish job uses only the verified artifact and OIDC.

A rebuilt tarball with a different digest is a different candidate. Void the
old preview and investigate before producing another one.

## Partial or ambiguous publication

The workflow reconciles each package by the exact npm `dist.integrity` of the
approved tarball. Only a structured `E404` means absent; network, registry,
authentication, malformed-response, and integrity errors are ambiguous and
stop publication.

| Registry state | Workflow action |
| --- | --- |
| Both absent | Publish core, reconcile it, then publish design. |
| Exact core present; design absent | Skip core and publish design. |
| Both exact | Publish nothing; final verification succeeds. |
| Design present; core absent | Stop for investigation. |
| Either integrity differs or lookup is ambiguous | Stop for investigation. |

If a publish command times out or fails after npm accepted the bytes, its step
is allowed to continue only so the workflow can query the registry and decide
from exact integrity. If the run still ends red, redispatch the **same workflow
with the same commit, tag, and digests**, pass the same protected-environment
approval, and let reconciliation resume. Never publish locally, remove a
package from scope, rebuild just one tarball, unpublish, overwrite, move the
tag, or bump a version to escape an ambiguous state.

Record the two names and versions, both SHA-256 digests, commit, tag, workflow
run URL, environment approver, and final npm integrity values.

## Version rules

- Both packages use one exact version; the packed design package depends on
  core at exact equality.
- Package SemVer covers code, prompts, and skills. A substantive method or
  prompt change is at least a minor release and appears in the changelog.
- Consumers exact-pin pre-1.0 releases.
- Every release starts its own FSL two-year MIT conversion clock.
