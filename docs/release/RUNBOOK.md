# Release runbook

A merge, green CI run, or built tarball is not release approval. Publication
requires two deliberate manual dispatches with identical candidate inputs. The
first defaults to verification only and is physically unable to schedule the
OIDC-enabled publish job. The second explicitly sets `publish=true` and repeats
every check before that job can start. The workflow never creates a tag or
publishes on push. Agents never create, request, receive, or use npm credentials.

GitHub Team does not support required environment reviewers for private
repositories. The `npm-publish` environment is retained only as an npm OIDC
subject binding; it is not an approval gate and carries no secret or token.

## One-time configuration and bootstrap

The npm trusted-publisher settings page exists only after the package exists,
so `@cormidia/validation-architect@0.5.0` has one owner-performed bootstrap:

1. On the squash commit on `main`, the owner creates and pushes `v0.5.0`.
2. The owner creates the GitHub environment `npm-publish` without protection
   rules. It exists only to bind the npm trusted-publisher identity.
3. From a clean tree at that commit, construct the candidate with:

   ```bash
   node scripts/release-candidate.mjs
   ```

   Dispatch `release.yml` with its exact `commit`, `tag`, and `digest`, leaving
   `publish=false`. The verification job seals and uploads `package.tgz`; the
   publish job cannot be scheduled in this run.
4. The owner downloads that exact artifact, checks its printed SHA-256, and
   performs the only local publication, from the owner's authenticated terminal:

   ```bash
   npm publish ./package.tgz --access public --ignore-scripts
   ```

5. On the package settings page, the owner configures the npm trusted publisher
   for organization/repository `cormidia/validation-architect`, workflow
   `release.yml`, environment `npm-publish`, then enables “Require two-factor
   authentication and disallow tokens”. No `NPM_TOKEN` is created or stored.
6. Re-dispatch the same commit, tag, and digest with `publish=true`. This second
   run repeats the full verification job before its OIDC-enabled publish job can
   start. Registry planning must report the bootstrapped package as present,
   publish nothing, and finish with matching integrity.

For `v0.5.0`, the two-dispatch gate was ratified immediately after the immutable
tag was pushed. Dispatch the workflow definition from current `main`, while the
candidate `commit`, `tag`, and tarball remain bound to the tagged commit. The
workflow explicitly accepts an ancestor of `main` and verifies the tag and
digest against that exact checkout.

Every later version is published only by the two-dispatch workflow.

Trusted publishing and provenance are separate npm features. OIDC trusted
publishing works for this private repository, but npm cannot generate public
provenance for a package built from a private source repository. The workflow
therefore omits `--provenance`, and `publishConfig` has no provenance default.
Making the repository public is deferred; revisit provenance only then. The
workflow pins Node 24 and npm 11.19.0; trusted publishing requires npm 11.5.1 or
newer and Node 22.14 or newer.

## Verify and publish a later candidate

1. On the clean, merged commit on `main`, run `node
   scripts/release-candidate.mjs`. It checks package identity, version, pinned
   pnpm, built version, and tree cleanliness before and after packing. It reads
   neither npm nor credentials and does not tag or publish.
2. Review the exact commit, tag, package version, and tarball SHA-256. Create
   the exact `vX.Y.Z` tag at that commit and push it; never move it.
3. Dispatch `.github/workflows/release.yml` with the exact `commit`, `tag`, and
   `digest`, leaving `publish=false` (the default).
4. The verification job requires the commit on `main`, verifies the tag, runs
   the full offline suite, rebuilds the one tarball, compares its digest, and
   uploads it. Review this verify-only run and its sealed artifact.
5. Re-dispatch the exact same `commit`, `tag`, and `digest` with `publish=true`.
   The second run repeats every verification step. Only after those checks pass
   can the publish job receive short-lived OIDC permission and use that second
   run's verified artifact.

A rebuilt tarball with a different digest is a different candidate. Void the
old preview and investigate before producing another one.

## Absent, matching, or ambiguous registry state

The workflow reconciles `@cormidia/validation-architect@<version>`. It compares the
exact npm `dist.integrity` of the approved tarball. Only a structured `E404` means absent;
network, registry, authentication, malformed-response, and integrity
errors are ambiguous and stop publication.

| Registry state | Workflow action |
| --- | --- |
| Absent | Publish the approved tarball, then verify exact integrity. |
| Exact integrity present | Publish nothing; verification succeeds. |
| Different integrity or ambiguous lookup | Stop for investigation. |

If a workflow publish command times out after npm may have accepted the bytes,
the step continues only to the final exact-integrity query. If the run ends red,
redispatch the workflow with the same commit, tag, and digest and
`publish=true`. Never rebuild, unpublish, overwrite, move the tag, or
bump a version to escape ambiguity.

Record the scoped name and version, SHA-256 digest, commit, tag, both workflow
run URLs, the dispatch actor, and final npm integrity.

## Version rules

- Consumers exact-pin pre-1.0 releases.
- Package SemVer covers code, prompts, and skills. A substantive method or
  prompt change is at least a minor release and appears in the changelog.
