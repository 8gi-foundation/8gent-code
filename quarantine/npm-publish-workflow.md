# npm Publish Workflow

## What

GitHub Actions workflow that publishes `@podjamz/8gent-code` to npm on version tag push.

## Trigger

Push a tag matching `v*` (e.g., `v1.1.0`, `v2.0.0-beta.1`).

## Pipeline

1. Checkout with full history
2. Setup Bun + Node 20
3. Install dependencies
4. Run typecheck, lint, test
5. Build CLI (`bun run build` - produces `dist/cli.js`)
6. Verify build artifact exists and has shebang
7. Verify `package.json` version matches the pushed tag
8. Publish to npm with `--access public`
9. Extract changelog entry for the version
10. Create GitHub release (pre-release if tag contains `-`)

## Secrets Required

| Secret | Purpose |
|--------|---------|
| `NPM_TOKEN` | npm automation token for `@podjamz` scope |

## Usage

```bash
# 1. Bump version in package.json, bin/8gent.ts, README badge
# 2. Update CHANGELOG.md
# 3. Commit and tag
git tag v1.1.0
git push origin v1.1.0
```

## Graduation Criteria

- [ ] `NPM_TOKEN` secret added to repo settings
- [ ] One successful dry run (`npm publish --dry-run` locally)
- [ ] Tag push triggers workflow and publishes successfully
- [ ] GitHub release created with correct changelog
