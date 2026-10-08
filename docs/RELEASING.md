# Releasing 8gent Code

Releases go through a pull request. Nothing in CI pushes to main (#3658).

## How a release happens

1. PRs merge to main as usual. Nobody edits `package.json`'s version or
   `CHANGELOG.md` in a feature PR (#3575).
2. After every merge, the **Release PR** workflow
   (`.github/workflows/release-pr.yml`) rebuilds branch `release/next` from
   main and opens or refreshes one pull request titled `release: vX.Y.Z`. It
   carries the version in `package.json`, `bin/8gent.ts` and the README
   badge, plus the `CHANGELOG.md` section built from the merged PR titles
   since the previous release.
3. A maintainer merges that PR when a release is wanted. The workflow then
   tags the commit where the version landed and starts `release.yml`
   (GitHub Release and npm publish) and `release-binaries.yml` (installers)
   on that tag.

Do not edit the release branch by hand: the next merge to main rebuilds it.

## The version number

`bun scripts/release-version.ts next` prints the next version. It is
computed from max(`package.json`, highest `v*` tag in the same major line),
bumped, then stepped past any tag that already exists. Tags from another
major line (the pre-reset `v1.0.0` to `v2.1.0` from March 2026 are still on
origin) never pull the version up. On 8 Oct 2026, with `package.json` at
0.18.0 and tags `v0.18.1` and `v0.19.0` orphaned off main, the next version
is 0.19.1.

The bump is a patch unless a PR title or body merged since the previous
release carries `[bump:minor]` or `[bump:major]`. To override the next
proposal, run the Release PR workflow by hand (Actions, "Release PR", "Run
workflow") with `bump` set to `minor` or `major`. `feat:` alone does not
raise the level: a minor or major release is an explicit decision.

## CI on the release PR

GitHub does not start `pull_request` workflows for a PR created with the
default `GITHUB_TOKEN`. Two ways to get CI on the release PR:

- Set a repository secret `RELEASE_PAT`: a fine-grained token with contents
  and pull-requests write on this repository. The workflow uses it to push
  the branch and open the PR, and CI runs on every refresh.
- Without it, close and reopen the release PR (or push an empty commit to
  `release/next`) to start CI before merging.

The tag job always uses `GITHUB_TOKEN` and starts the publish workflows with
`workflow_dispatch`, so a tag is published exactly once whether or not
`RELEASE_PAT` is set.

## Recovery

- **A release PR merged but nothing was tagged.** Push anything to main, or
  run the Release PR workflow by hand: it sees an untagged version and tags
  it. `bun scripts/release-version.ts commit X.Y.Z` prints the commit it will
  tag.
- **A tag exists that was never released** (as `v0.18.1` and `v0.19.0` on
  1 Oct 2026). Nothing to do; the next proposal is computed past it.
- **The CHANGELOG section is wrong.** Fix the PR titles it came from, or edit
  `CHANGELOG.md` on `release/next` and merge before the next push to main
  rebuilds the branch. `bun scripts/changelog-release.ts --version X.Y.Z`
  prints the section locally.

## Tests

- `bun test scripts/lib/release-version.test.ts`: next version past existing
  tags, the CHANGELOG section against a git history in the wedged state, no
  `git push ... main` in any workflow.
- `bun test tests/security/workflow-injection.test.ts`: no `${{ }}` inside a
  `run:` script of `release-pr.yml`, every action pinned to a commit SHA, and
  crafted versions and inputs execute nothing (#3214).
