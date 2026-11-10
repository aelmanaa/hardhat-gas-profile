# Releasing

Audience: the maintainer. Adapted from the release process of
[hardhat-kms](https://github.com/aelmanaa/hardhat-kms/blob/main/docs/contributor/releasing.md) and
[explorer-verify](https://github.com/aelmanaa/explorer-verify/blob/main/docs/contributor/releasing.md),
for one package at the repository root.

The model in one sentence: every version is built from a maintainer-signed `vX.Y.Z` tag on `main`,
staged to npm under the `beta` dist-tag with provenance, approved on npmjs.com, verified from the
registry, and promoted by moving `latest` to that exact version. Nothing is rebuilt between `beta`
and `latest`: same tarball, same provenance.

## The pieces

| Piece                               | What it does                                                                                                                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/ci.yml`          | Lint, format, typecheck, tests on Node 22.13.0, 24.0.0 and 26.0.0, the release script tests, publint and are-the-types-wrong, zizmor                                              |
| `.github/workflows/release-pr.yml`  | On each push to `main`, opens or updates the Version Packages pull request with `pnpm run version-packages`. Publishes nothing                                                    |
| `.github/workflows/release.yml`     | On a `vX.Y.Z` tag: checks the tag and CI, builds, checks and packs, then stages to `beta` behind the `npm-publish` environment. A manual dispatch is a dry run                    |
| `.github/workflows/promote.yml`     | Dispatched from `main` with a version and a target: checks the version on npm, then publishes the GitHub Release as a prerelease (`verify`) or moves `latest` behind `npm-latest` |
| `.github/release-keys/`             | The trust root: the public key of each maintainer who may sign a release tag ([README](../../.github/release-keys/README.md))                                                     |
| `.github/ruleset-protect-tags.json` | The tag ruleset: only a repository admin creates, moves or deletes a `v*` tag                                                                                                     |
| `scripts/verify-release-tag.ts`     | Checks the tag signature against the keys, that the tag names the version in `package.json`, that it is a plain `X.Y.Z`, and that the commit is on `main`                         |
| `scripts/check-tarballs.ts`         | Checks the tarball's SHA-256, name, version and `gitHead` against the pack job's record, and that no dependency range is `workspace:`, `catalog:`, `link:` or `file:`             |
| `scripts/check-registry-release.ts` | Before a promote: the version is on npm, on `beta`, not below `latest`, from the tagged commit, with a provenance attestation `npm audit signatures` verifies                     |

The scripts import only `node:` modules, so the release jobs run them without installing anything.
`node --test "scripts/test/*.test.ts"` (`pnpm run test:scripts`) runs their tests; the `Release
scripts` job of `ci.yml` runs them on every pull request.

Every release job runs only in `aelmanaa/hardhat-gas-profile`, never in a fork. Actions are pinned
by commit SHA. No job reads an npm token: staging and the dist-tag move use npm trusted publishing
over OIDC. Release jobs restore no dependency cache.

## Before the first release

- `devDependencies.hardhat` must be a released Hardhat version that has the `includeTraces` option
  of `test solidity` ([NomicFoundation/hardhat#8824](https://github.com/NomicFoundation/hardhat/pull/8824)).
  While it is a `link:` to a local checkout, `pnpm install --frozen-lockfile` fails on every runner,
  so CI is red and no release can pass, and `scripts/check-tarballs.ts` refuses a tarball whose
  manifest still holds the `link:` range. Raise `peerDependencies.hardhat` to the same release.
- `package.json` reads `0.0.0`, and `.changeset/first-release.md` is a `minor` changeset, so the
  first Version Packages pull request sets 0.1.0 and writes the `## 0.1.0` entry of `CHANGELOG.md`
  that `release.yml` takes the release notes from. 0.0.0 is never published.

## One-time setup

The maintainer does each of these once. Agents do none of them.

On GitHub (Settings of `aelmanaa/hardhat-gas-profile`):

1. Actions, General: turn on "Allow GitHub Actions to create and approve pull requests".
   `release-pr.yml` opens the Version Packages pull request with the default `GITHUB_TOKEN`; no
   GitHub App or personal token is used.
2. Environments, New environment `npm-publish`: required reviewer `aelmanaa`, "Prevent
   self-review" off, deployment branches and tags set to "Selected branches and tags" with the one
   tag rule `v*`. No secrets.
3. Environments, New environment `npm-latest`: required reviewer `aelmanaa`, "Prevent self-review"
   off, deployment branches set to the one branch rule `main`. No secrets.
4. Rules, Rulesets, Import a ruleset: `.github/ruleset-protect-tags.json`, or
   `gh api -X POST repos/aelmanaa/hardhat-gas-profile/rulesets --input .github/ruleset-protect-tags.json`.
   Only the repository admin role may then create, update or delete `refs/tags/v*`.
5. A ruleset on `main`: pull request required, squash merge only, and the CI jobs as required
   checks. The release tag goes on a commit of `main`, so the tag is only as trustworthy as that
   branch.

Create the two environments before the npm steps: a trusted publisher names an environment, and
GitHub creates an environment a job names but that does not exist yet, with no protection.

On npm, for the name `hardhat-gas-profile` (signed in as its owner, with 2FA):

6. First publish, by hand. npm configures a trusted publisher only for a package that exists, and
   `release.yml` stops before staging when the name is not on npm. Reserve the name with a
   placeholder, in an empty folder outside the repository, with a `package.json` holding
   `"name": "hardhat-gas-profile"`, `"version": "0.0.0-placeholder.0"`, `"license": "MIT"`, the
   repository URL and a description that says it is a placeholder:

   ```sh
   npm whoami
   npm publish --access public --tag placeholder
   npm deprecate hardhat-gas-profile@0.0.0-placeholder.0 "Placeholder that reserves the name; install the version on latest."
   ```

   A first publish takes `latest` whatever `--tag` says. The first `target: latest` promotion moves
   `latest` off it; `scripts/check-registry-release.ts` accepts the placeholder on `latest` only
   while it is deprecated.

7. In the package settings on npmjs.com, set "Publishing access" to "Require two-factor
   authentication and disallow bypass 2fa tokens".
8. Trusted publisher for the release, on the day of the first tag (a configuration that completes
   no publish expires 48 hours after its creation): GitHub Actions, user `aelmanaa`, repository
   `hardhat-gas-profile`, workflow filename `release.yml`, environment `npm-publish`, staged
   publishing only. From a terminal with npm 11.15.0 or later:

   ```sh
   npm trust github hardhat-gas-profile --file release.yml --repo aelmanaa/hardhat-gas-profile --env npm-publish --allow-stage-publish
   ```

9. Trusted publisher for the promotion, on the day of the first `target: latest` run: workflow
   filename `promote.yml`, environment `npm-latest`, dist-tag management allowed, publish not
   allowed, so the promote workflow can never publish a tarball.

## Cut a release

1. Changesets accumulate on `main` (`pnpm changeset`). `release-pr.yml` keeps the Version Packages
   pull request (branch `changeset-release/main`) current.
2. On that pull request, click "Approve workflows to run": GitHub starts the workflows of a pull
   request that `GITHUB_TOKEN` opened only after someone with write access approves them. Read the
   version and the `CHANGELOG.md` entry, then squash-merge it.
3. Wait for `ci.yml` on `main` to pass on the merge commit. Then sign the tag on that commit, check
   it, and push it:

   ```sh
   git fetch origin main
   git tag -s v0.1.0 -m v0.1.0 <merge-sha>
   git verify-tag v0.1.0
   node scripts/verify-release-tag.ts v0.1.0
   git push origin v0.1.0
   ```

   The script prints one line: `v0.1.0 passes:` with the signer, version and commit, or
   `v0.1.0 fails:` with the reason. Never push a tag that fails.

4. `release.yml` runs `verify-tag` (signature, version, `main`, a passing `ci.yml` push run on the
   commit) and `pack` (`pnpm run pkg:check`, `pnpm pack` with `gitHead` set to the commit, publint
   and are-the-types-wrong on the tarball, `scripts/check-tarballs.ts`). Read the run summary: the
   tarball's SHA-256, its file list and the release notes.
5. Approve `npm-publish`. The `publish` job checks the tarball against the sum the `pack` job
   recorded, checks that the name exists on npm, and runs
   `npm stage publish <tarball> --tag beta --access public --provenance`. `github-release` then
   creates a draft GitHub Release with the prerelease flag.
6. On npmjs.com, inspect the staged version and approve it. Only then does the version exist on the
   registry, with `beta` pointing at it.

Rehearse with a dry run: dispatch `release.yml` with `tag` set to an existing tag, or `none` to
pack the dispatched branch without the tag checks. It runs `verify-tag` (without the CI check),
`pack` and `npm stage publish --dry-run`, and writes the commands a release would run to the
summary. It uses no environment, no OIDC token and no secret.

```sh
gh workflow run release.yml --ref main -f tag=none
```

## Verify and promote

1. Install the version from npm and try it (`npm install --save-dev hardhat-gas-profile@beta`).
2. Dispatch `promote.yml` from `main` with `target: verify`:

   ```sh
   gh workflow run promote.yml --ref main -f version=0.1.0 -f target=verify
   ```

   `verify` checks tag `v0.1.0` again with the keys and script of `main`, then
   `scripts/check-registry-release.ts`: the version is published, `beta` points at it, `latest` is
   not above it, its `gitHead` is the tagged commit, and `npm audit signatures` verifies its
   provenance attestation after a scratch `npm install --ignore-scripts`. Green publishes the
   draft GitHub Release as a prerelease.

3. Dispatch it with `target: latest`, then approve `npm-latest`. The `latest` job reads the
   dist-tags again, runs `npm dist-tag add hardhat-gas-profile@0.1.0 latest` over OIDC, and
   `release-latest` marks the GitHub Release as the latest. If npm refuses the move over OIDC, run
   the same `npm dist-tag add` by hand with 2FA and re-run the workflow; it finds `latest` already
   moved and only edits the release.

## When something fails

- Before `publish`: nothing reached npm, so the tag can move. Fix through a pull request, delete the
  remote tag (`git push origin :refs/tags/vX.Y.Z`; the tag ruleset lets only an admin do it), sign a
  new tag on the new commit, verify, push.
- After the stage: never move or delete the tag, and never reuse the version. Reject a wrong stage
  on npmjs.com, treat the number as used, and ship the next patch. A bad version that reached
  `beta` or `latest` is deprecated (`npm deprecate hardhat-gas-profile@<bad> "<reason>; use <next>"`)
  and replaced by a new patch; `latest` never moves backwards.
- `github-release` failed after the stage: re-run that job only; it never creates a second release.
- A trusted-publisher configuration expired (48 hours without a publish): delete it on npmjs.com and
  create it again on the day of the tag.

## Not ported from the source repositories

hardhat-kms also has hotfix lines (`release/X.Y`, dist-tag `release-X.Y`), a `next` channel for
prereleases of a future major (`release-next.yml`), a CI gate that dispatches missing runs of four
workflows, fresh installs checked for deprecated packages, live tests in the promotion, and a
comment on the merged pull request. explorer-verify also deploys a docs site in the promotion and
checks the workflows' job graph with `scripts/check-release-workflows.ts`. None of these applies to
this package yet; add them when it needs them.

## Rules

- Agents never tag, publish, approve an environment or a stage, dispatch `promote.yml` or move a
  dist-tag. A dry run of `release.yml` publishes nothing.
- Versions change only through `pnpm run version-packages`, on the Version Packages pull request.
- The npm pin (`npm@12.2.0`) is in `release.yml` and `promote.yml`; raise it in both together.
