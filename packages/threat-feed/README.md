# threat-feed

Slice 1 of epic #4840. Reads what we run, reads the public feeds, writes a report. Read-only on production. Proposals only.

    bun packages/threat-feed/cli.ts                  # dry run: report only
    bun packages/threat-feed/cli.ts --file-issues    # one issue per repo, a checklist of its advisories, via gh-issue-file
    options: --repo OWNER/NAME (repeatable)  --min-severity LOW|MEDIUM|HIGH|CRITICAL  --manifest PATH  --out DIR

- Inventory: repos from `8gi-governance/context/ecosystem.json` (archive-proposed skipped). One git tree call and one blob call per lockfile through the GitHub API, no clones. Reads bun.lock, package-lock.json, pnpm-lock.yaml, requirements*.txt (== pins only), poetry.lock, go.sum, Cargo.lock. bun.lockb is binary and listed as a coverage gap. Lockfiles under node_modules, fixtures, __fixtures__ and testdata are ignored.
- Feeds: OSV `querybatch` (paged), OSV per-advisory records for severity and fixed versions, CISA KEV.
- Severity: CVSS v3 vector computed locally, else the GHSA label, else UNKNOWN. A hit is on KEV when the advisory id or any alias is a KEV CVE.
- Output: `~/.8gent/security/threat-feed/<date>/report.json` and `summary.md`. With `--file-issues`, one issue per repo titled `Critical dependency advisories: <repo>` (non-dev-only rows first) is drafted under `issues/` and filed. `gh-issue-file` skips a title that already exists. When the checklist later changes, the new checklist is added as a comment (digest kept in `issue-state.json`); the issue body is never edited. Issue text carries no advisory prose. Every third-party value (ids, aliases, CVEs, versions, package names, lockfile paths) must pass a strict character check and is printed in backticks; hits whose id, package or version fail are dropped, a failing alias is dropped, a failing fixed version prints `no valid fixed version`.
- No bump PRs. The proposed bump is listed in the report and in each issue.
- Hosts needed: api.github.com, api.osv.dev, www.cisa.gov.

Tests use fixture lockfiles and fixture feed data. No network.
