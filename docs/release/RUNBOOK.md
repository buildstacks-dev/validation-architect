# Release runbook

A merge, green CI run, or built tarball is not release approval. Publication
requires an owner-approved candidate plus approval of the protected
`npm-publish` GitHub environment. The workflow never creates a tag or publishes
on push. Agents never create, request, receive, or use npm credentials.

## One-time configuration and bootstrap

The npm trusted-publisher settings page exists only after the package exists,
so `@cormidia/validation-architect@0.5.0` has one owner-performed bootstrap:

1. On the squash commit on `main`, the owner creates and pushes `v0.5.0`.
2. The owner creates the GitHub environment `npm-publish`, with the owner as a
   required reviewer.
3. From a clean tree at that commit, construct the candidate with:

   ```bash
   node scripts/release-candidate.mjs
   ```

   Dispatch `release.yml` with its exact `commit`, `tag`, and `digest`. Let the
   verification job seal and upload `package.tgz`, but do not approve the
   protected publish job.
4. The owner downloads that exact artifact, checks its printed SHA-256, and
   performs the only local publication, from the owner's authenticated terminal:

   ```bash
   npm publish ./package.tgz --access public --ignore-scripts
   ```

5. On the package settings page, the owner configures the npm trusted publisher
   for organization/repository `cormidia/validation-architect`, workflow
   `release.yml`, environment `npm-publish`, then enables “Require two-factor
   authentication and disallow tokens”. No `NPM_TOKEN` is created or stored.
6. Re-dispatch the same commit, tag, and digest and approve the protected job.
   Registry planning must report the exact package as present, publish nothing,
   and finish with matching integrity.

Every later version is published only by the protected workflow.

Trusted publishing and provenance are separate npm features. OIDC trusted
publishing works for this private repository, but npm cannot generate public
provenance for a package built from a private source repository. The workflow
therefore omits `--provenance`, and `publishConfig` has no provenance default.
Making the repository public is deferred; revisit provenance only then. The
workflow pins Node 24 and npm 11.19.0; trusted publishing requires npm 11.5.1 or
newer and Node 22.14 or newer.

## Approve and publish a later candidate

1. On the clean, merged commit on `main`, run `node
   scripts/release-candidate.mjs`. It checks package identity, version, pinned
   pnpm, built version, and tree cleanliness before and after packing. It reads
   neither npm nor credentials and does not tag or publish.
2. Review the exact commit, tag, package version, and tarball SHA-256. Create
   the exact `vX.Y.Z` tag at that commit and push it; never move it.
3. Dispatch `.github/workflows/release.yml` with the exact `commit`, `tag`, and
   `digest`.
4. The verification job requires the commit on `main`, verifies the tag, runs
   the full offline suite, rebuilds the one tarball, and compares its digest.
5. Review the run and approve the protected environment. The publish job uses
   only the verified artifact and OIDC.

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
redispatch the same workflow with the same commit, tag, and digest and use the
same protected approval. Never rebuild, unpublish, overwrite, move the tag, or
bump a version to escape ambiguity.

Record the scoped name and version, SHA-256 digest, commit, tag, workflow run
URL, environment approver, and final npm integrity.

## Version rules

- Consumers exact-pin pre-1.0 releases.
- Package SemVer covers code, prompts, and skills. A substantive method or
  prompt change is at least a minor release and appears in the changelog.
