# Documentation Governance

> Living document. Defines how documentation in this repo is organized, reviewed, and maintained.

## 1. Directory Taxonomy

Every document in this repo belongs in one of these folders. If it doesn't fit, it belongs elsewhere (see §5).

| Directory | Purpose | Audience |
|-----------|-|--|-
| `docs/specs/` | Protocol definitions, data formats, behavioral contracts | Contributors, future self |
| `docs/design/` | Architecture proposals, system design, trade-off analysis | Contributors, 8TO |
| `docs/guides/` | Usage, configuration, operational how-tos | Users, contributors |
| `docs/process/` | Workflow definitions, project tracking | Contributors, board |
| `docs/bmad/` | BMAD phase briefs, epics, PRDs, architecture docs | Product, contributors |
| `docs/benchmarks/` | Benchmark methodology, results, comparisons | Contributors |
| `docs/audits/` | Smoke tests, audit reports | 8SO, contributors |
| `docs/research/` | Deep dives, experiments, investigations | Contributors |
| `docs/content/` | Blog posts, audio, marketing assets | 8MO, public |
| `docs/decks/` | Presentations, pitch decks | 8MO, board |
| `docs/prd/` | Product requirement documents | 8PO, contributors |
| `docs/archive/` | Superseded docs kept for historical reference | Anyone |
| Root-level `.md` | Public-facing repo docs: `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `LICENSE`, `AUP.md` | Everyone |

### Special root-level files

These live at the repo root by convention and are **not** in `docs/`:

| File | Owned By | Purpose |
|------|--|-|
| `AGENTS.md` | 8EO | Agent context — auto-synced from `8gi-governance` |
| `8GENT.md` | 8EO | Development process and philosophy |
| `CLAUDE.md` | 8EO | Agent instructions for external AI working on the repo |
| `BRAND.md` | 8DO | Brand guidelines |
| `SOUL.md` | 8EO | Identity and personality definition |
| `CONVENTIONS.md` | 8TO | Code conventions |
| `SECURITY.md` | 8SO | Security policy |

## 2. Document Lifecycle

```
Draft → Review → Published → Maintained → Archived
```

| Stage | Criteria |
|-------|-|
| **Draft** | WIP file, no frontmatter or `status: draft` |
| **Review** | PR open, linked to issue, assigned officer in review |
| **Published** | Merged to main, appears in `docs/README.md` index |
| **Maintained** | Active doc. Reviewed at least once per major release |
| **Archived** | Superseded. Moved to `docs/archive/` with a one-line note in the index explaining why |

### Archiving rules

- If a newer doc supersedes an older one, move the old one to `docs/archive/`
- Add a note at the top of the new doc: `Supersedes: docs/archive/OLD-DOC.md`
- Update `docs/README.md` to remove the archived entry

## 3. Quality Standards

### Structure

- Every doc starts with a one-line summary under the `#` title
- Use tables for structured data (specs, comparisons, inventories)
- Use code blocks for commands, config, and examples
- Keep docs under **200 lines** when possible. Split larger docs into sub-docs.

### Style (enforced by hard rules in `AGENTS.md`)

- No em dashes. Use hyphens, colons, commas, or parentheses.
- No AI vendor names in any surface.
- No emojis in documentation.
- No purple/pink/violet references in any UI-related docs.
- Active voice. Short sentences.

### Frontmatter (required for specs and design docs)

```yaml
---
title: Document Title
status: draft | published | archived
owner: 8TO | 8PO | 8EO | 8SO | 8DO
last-reviewed: YYYY-MM-DD
supersedes: null | path/to/old-doc.md
---
```

## 4. Review and Sign-Off

| Doc Type | Required Reviewer | Optional Reviewer |
|----------|-|-|
| `specs/` | 8TO (Rishi) | 8EO |
| `design/` | 8TO (Rishi) | 8DO |
| `guides/` | 8EO | — |
| `process/` | 8EO | — |
| `bmad/` | 8PO (Samantha) | 8TO |
| `benchmarks/` | 8TO | 8EO |
| `audits/` | 8SO (Karen) | — |
| `research/` | 8EO | — |
| `content/` | 8MO (Zara) | 8DO |
| `decks/` | 8MO | 8DO |
| `prd/` | 8PO | 8TO |
| Root-level public docs | 8EO | — |

Every documentation PR must:
1. Reference a GitHub issue (`Closes #N` in PR body)
2. Update `docs/README.md` index if adding or removing entries
3. Include the reviewer's code (e.g., `8TO`) as a label

## 5. Cross-Repo Documentation

Some docs don't belong in this repo:

| Content | Where It Lives |
|---------|-|
| Ecosystem governance narratives | `8gi-governance` |
| Investor decks and large static media | `8gi-governance` + `8gent-world` |
| Public website content | `8gent-world` |
| Boardroom minutes | `8gi-governance/docs/boardroom-minutes/` |
| Per-product roadmaps | `8gi-governance/context/roadmaps/` |
| Agent context (source) | `8gi-governance` — synced to all repos via CI |

When a doc needs to reference content in another repo, link to it. Don't duplicate it.

## 6. Index Maintenance

`docs/README.md` is the single source of truth for what documentation exists.

- Every published doc must be listed in the index
- Entries use a table with `Doc` and `Topic` columns
- Group entries by directory section
- Update the index in the same PR that adds or removes the doc

## 7. Duplicate Prevention

Before creating a new document:

1. Search `docs/README.md` for existing coverage
2. Search GitHub issues for related doc requests
3. If a similar doc exists, update it instead of creating a new one
4. If multiple docs cover the same topic, consolidate into one and archive the rest

This prevents the vessel loop from generating duplicate documentation requests.
