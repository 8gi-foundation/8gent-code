# release-notes-generator

Generates release notes from git commit messages using conventional commits format.

## Requirements
- parseCommits(commits[]): categorizes by feat, fix, chore, docs, breaking
- generateNotes({ version, date, commits }): returns formatted release notes
- formatChangelog(notes[]): full CHANGELOG.md section
- bump(currentVersion, changes): determines semver bump from change types
- renderMarkdown(notes): formatted markdown release notes

## Status

Quarantine - pending review.

## Location

`packages/tools/release-notes-generator.ts`
