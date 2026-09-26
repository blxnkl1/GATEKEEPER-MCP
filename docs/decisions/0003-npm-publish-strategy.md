# 3. We publish to npm from GitHub Actions on a tag, with provenance

Date: 2026-09-26

## Status

Accepted

## Context

GATEKEEPER MCP is distributed as a package. The package name `gatekeeper-mcp`
was confirmed available on the npm registry (a 404 from `npm view`, checked on
2026-09-26) before any of this was written, and `blxnkl1-gatekeeper-mcp` is held
as a fallback if the primary name is taken by someone else first.

Publishing requires an npm credential. A credential is the risk in this decision,
and the options all differ in where that risk lands:

1. **Developers publish from their own machines.** Each contributor holds a
   publish token. A leaked token on a laptop is a compromised npm account, and
   there is no record tying a given tarball to a given commit. A maintainer
   publishing by hand also means the published artefact is whatever happened to
   be in their working tree, which may be dirty.
2. **A long-lived token in the repository as a file.** Obviously unacceptable.
3. **GitHub Actions with `NPM_TOKEN` as a repository secret.** The token never
   leaves the runner, the publish happens in a clean checkout of a tagged
   commit, and the run is auditable. The token is still long-lived.
4. **GitHub Actions with npm trusted publishing (OIDC).** No long-lived secret at
   all. The npm registry trusts GitHub Actions for a named package, and the
   exchange happens per run. This is strictly better on the credential axis, but
   it requires a one-time linking step between the npm package and the GitHub
   repository, and if the package name, npm account, or repository path do not
   match exactly, publishing fails in a way that is easy to misread as a
   workflow bug.

There is a second question, which is what "published" should guarantee. A tarball
on npm with no attribution can be published by anyone. npm supports **provenance
attestations**, which link a tarball to the exact commit and workflow run that
produced it, and which require the publisher to be a supported CI system. GitHub
Actions is supported, at the cost of one permission: `id-token: write`.

A third consideration: the engine, schema, and tool source are frozen for this
phase, and a published artefact cannot be recalled in any practical sense. So the
publish path should refuse to run on anything that has not passed the full check
suite, and it should be impossible to publish by accident.

## Decision

We publish to npm **only** from `.github/workflows/release.yml`, triggered by
pushing a tag matching `v*.*.*`, using a long-lived `NPM_TOKEN` stored as a
GitHub Actions repository secret, with `npm publish --provenance --access
public`.

Concretely:

- A `test` job runs on `ubuntu-latest` **and** `macos-latest`, running
  `typecheck`, `lint`, `test`, and `build`. The `publish` job has
  `needs: test`, so no failing check can produce a release.
- `NODE_AUTH_TOKEN` is supplied from `secrets.NPM_TOKEN` to the publish step
  only. It is never passed to the test job, and never written to a file.
- `permissions` is set to `contents: read` plus `id-token: write`, the minimum
  needed, with `id-token: write` present because `--provenance` requires it.
- **Manual `npm publish` is prohibited by policy.** The workflow is the only
  publish path, so the published artefact is always a clean checkout of a tagged
  commit that passed every check.
- The package is locked to the `files` allowlist: `dist`, `README.md`, `LICENSE`,
  `SKILL.md`, plus `package.json` which npm always includes. `npm pack --dry-run`
  is asserted against that allowlist in `ci.yml`, so a file added to the
  repository by accident cannot silently ship.
- A `prepack` script runs `build`, so the tarball is never assembled from a stale
  or missing `dist/`. This was added after a release audit found that
  `prepublishOnly` is a publish-only hook: `npm pack` in a clean checkout produced
  a five-file package with no server in it, because `dist/` is gitignored and the
  `files` allowlist silently matched nothing.
- `prepublishOnly` runs `typecheck`, `lint`, `test`, and `build` as a second line
  of defence on the publish path itself.
- Trusted publishing (OIDC) is documented as a `TODO` in the workflow header as
  the preferred end state.

### Amendment, 2026-09-27: release preconditions tightened

Four changes to the mechanism above, none of which alters the decision to publish
only from CI.

- **The tag pattern is `v[0-9]+.[0-9]+.[0-9]+*`, not `v*.*.*`.** The looser glob
  also matches `vfoo.bar.baz` and every prerelease-shaped tag, so any unrelated
  tag pointing at this repository would have started a publish attempt.
- **The tag must equal `package.json`.** Both the test matrix and the publish job
  check it, so a mistagged release fails with a clear message instead of a
  duplicate-version error from the registry that reads like a registry problem.
  Verified locally: `v1.0.1` against `package.json` `1.0.0` is rejected.
- **`id-token: write` is scoped to the publish job** rather than the workflow. The
  OIDC token exists only to sign provenance; the test matrix has no use for it.
- **The release gate now also runs the MCP protocol test and the installer
  round-trip**, so a publish cannot happen on a tree where those fail. The
  published tarball is installed and started before `npm publish`, and the
  installed server is asserted to keep stdout clean.

## Consequences

The credential never leaves the runner, and the published artefact is
reproducible from a tag: same commit, same checks, same build. Provenance makes
that claim checkable by a consumer rather than a promise, which is the property
that matters for a package whose entire value proposition is "trust this tool
before you let it near your files".

The cost is a one-time setup obligation that is invisible until someone tries to
release: the owner must create an npm token and add `NPM_TOKEN` to the
repository secrets. A release attempted without it fails at the publish step
with an authentication error, not at a validation step, which is a mildly
confusing first experience. This is documented in a comment at the top of the
workflow rather than only in a wiki, because the person hitting it is
overwhelmed enough to be reading the workflow file already.

Running the test matrix on both Linux and macOS doubles CI minutes on a tag. We
accept that: the installer shells out to `uname`, checks PATH behaviour, and
falls back for the absence of GNU `timeout`, all of which are platform-specific
and would not be caught by a Linux-only matrix. A release that works on Linux and
breaks on macOS is a worse outcome than a slightly slower release.

`prepublishOnly` runs the full suite, so a local `npm publish` also gates on
everything. That is intentional, and it is also why the policy still forbids
local publishing: passing the checks is necessary but not sufficient, since the
artefact should come from CI.

The remaining known weakness is that `NPM_TOKEN` is long-lived. Trusted
publishing removes it, and the `TODO` points at that migration. We did not adopt
OIDC immediately because the linking step is a one-time manual action on the npm
side that the repository owner must perform, and getting it wrong fails late.
That is a documentation and sequencing problem, not a design one, so it is
recorded rather than solved.
