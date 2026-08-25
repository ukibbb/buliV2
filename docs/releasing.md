# Releasing Buli

This guide describes the supported release process for native GitHub Release
artifacts, the curl installer, and the `@ukibbb/buli` npm package.

## Release channels and versions

Buli uses semantic versioning:

- increment `patch` for backward-compatible fixes, for example `0.1.0` to
  `0.1.1`
- increment `minor` for backward-compatible features, for example `0.1.0` to
  `0.2.0`
- increment `major` for breaking changes after the public API is stable
- use versions such as `0.2.0-rc.1` while validating a future stable release

Stable versions are published to the npm `latest` dist-tag. Prerelease versions
are published to `next` and are marked as prereleases on GitHub.

## Prerequisites

Before releasing, confirm that:

- the intended code and tests are committed on `main`
- GitHub Actions is enabled and has available hosted-runner capacity
- npm Trusted Publishing for `@ukibbb/buli` points to owner `ukibbb`, repository
  `buliV2`, and workflow `release.yml`
- the GitHub repository variable `NPM_TRUSTED_PUBLISHING` is exactly `true`
- Bun 1.3.12 or newer, ripgrep, and fd are available locally

Do not use a long-lived npm token for routine releases. The workflow publishes
through GitHub OIDC.

## 1. Choose the version

Examples:

```text
0.1.1
0.2.0
0.2.0-rc.1
```

A version can be published to npm only once. Never reuse an npm version after
a successful publication.

## 2. Update all version sources

Set the exact same version in:

- `package.json`
- the root workspace entry in `bun.lock`
- `npm/package.json`

The release build rejects mismatched versions, and the tag must equal the
version prefixed with `v`.

For example, version `0.1.1` requires tag `v0.1.1`; version `0.2.0-rc.1`
requires tag `v0.2.0-rc.1`.

## 3. Inspect the working tree

```bash
git status --short
```

Review every changed and untracked path. Do not use `git add .` when unrelated
work exists. A release tag must point to a commit containing every source and
test change intended for that release.

## 4. Run the local release gate

Set `VERSION` to the version without `v`:

```bash
VERSION=0.1.1
bun run typecheck \
  && bun run test \
  && npm pack ./npm --dry-run \
  && BULI_RELEASE_TAG="v$VERSION" bun run bundle:local
```

Use `bun run test`, not `bun test ./test`. The project script sets
`SHOW_CONSOLE=0`, which prevents the OpenTUI console from taking focus during UI
tests.

This gate verifies types, the complete test suite, npm tarball contents, tag and
package version agreement, the native executable, macOS signing when run on
macOS, and the bundled ripgrep and fd sidecars.

## 5. Commit the release

Add the intended feature files, tests, and three version files explicitly:

```bash
git add package.json bun.lock npm/package.json path/to/source path/to/test
git diff --cached --check
git commit -m "Release v0.1.1"
git push origin main
```

It is reasonable to wait for the regular `CI` workflow on `main` to pass before
creating the tag. The release workflow has its own blocking verification job as
a final gate.

## 6. Create and push an annotated tag

```bash
git tag -a v0.1.1 -m "Release v0.1.1"
git show --stat v0.1.1
git push origin v0.1.1
```

For a release candidate:

```bash
git tag -a v0.2.0-rc.1 -m "Release v0.2.0-rc.1"
git show --stat v0.2.0-rc.1
git push origin v0.2.0-rc.1
```

Do not move a tag after GitHub Release or npm publication succeeds. Publish a
new version instead.

## 7. Monitor the automated pipeline

```bash
gh run list --workflow release.yml --limit 3
```

The pipeline runs in this order:

1. install the test ripgrep and fd sidecars
2. typecheck, run the complete test suite, and inspect the npm tarball
3. build `darwin-arm64`, `darwin-x64`, `linux-arm64`, and `linux-x64`
4. sign and verify macOS executables
5. create archives and SHA-256 files
6. publish a stable or prerelease GitHub Release
7. publish npm through Trusted Publishing with provenance

The npm job publishes prereleases to `next` and stable versions to `latest`.
Do not run `npm publish` manually during the normal process.

## 8. Verify the published release

For stable version `0.1.1`:

```bash
gh release view v0.1.1 --repo ukibbb/buliV2
npm view @ukibbb/buli@0.1.1 version
npm dist-tag ls @ukibbb/buli
```

The GitHub Release must contain an archive and a `.sha256` file for each of the
four targets. A stable release must not be marked as a prerelease.

For `0.2.0-rc.1`, the GitHub Release must be a prerelease and `next` must point
to `0.2.0-rc.1`.

## 9. Run installation smoke tests

Stable npm installation:

```bash
npm install --global @ukibbb/buli@latest
buli --version
buli --help
```

Prerelease npm installation:

```bash
npm install --global @ukibbb/buli@next
buli --version
```

Stable standalone installation:

```bash
curl -fsSL https://raw.githubusercontent.com/ukibbb/buliV2/main/install.sh | sh
buli --version
```

If both npm and standalone installations exist, inspect `command -v buli` and
`type -a buli`. The first entry in `PATH` is the version the shell runs.

## Recovery rules

### Failure before any publication

If verification or build fails before GitHub Release and npm publication,
fix the cause and publish a new version. During initial release setup only, an
unpublished tag may be recreated after confirming both destinations are empty;
routine releases should prefer a new version.

### GitHub hosted-runner outage

If no step starts and GitHub reports that a hosted runner did not acquire the
job, check <https://www.githubstatus.com/> and rerun the same workflow after the
incident. Do not create a second version merely because runner infrastructure
was unavailable.

### Partial publication

Before retrying, check both destinations:

```bash
gh release view v0.1.1 --repo ukibbb/buliV2
npm view @ukibbb/buli@0.1.1 version
```

If npm already contains the version, it is immutable. Do not retry with changed
contents under the same version. Diagnose the remaining stage or prepare the
next patch version.

### npm authentication

Routine workflow publication uses OIDC and must not require `NPM_TOKEN`, OTP,
or a local npm session. If the npm job is skipped, verify that the repository
variable `NPM_TRUSTED_PUBLISHING` is `true`. If publication returns 403, verify
the npm Trusted Publisher owner, repository, workflow filename, and environment.

Never paste npm tokens, OTP values, recovery codes, or other credentials into
issues, logs, commits, or chat.
