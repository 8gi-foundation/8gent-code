# Codebase Health Monitor - Methodology

## Location

`packages/proactive/health-monitor.ts`

## What it measures

The health monitor produces a composite score (0-100) from three weighted dimensions.

### 1. Code Debt (40 points)

Scans all TypeScript/JavaScript files for `TODO`, `FIXME`, `HACK`, `XXX`, and `WORKAROUND` markers. The score is based on marker density (markers per 1,000 lines of code).

- 0 markers per 1k lines = 40/40
- 10+ markers per 1k lines = 0/40
- Linear interpolation in between

Rationale: debt markers are a reliable proxy for acknowledged-but-unresolved issues. Density (not raw count) normalizes for codebase size.

### 2. Test Coverage (35 points)

For each source file (`.ts`, `.tsx`, `.js`, `.jsx`), checks whether a matching `.test.*` or `.spec.*` file exists. This is a file-level heuristic, not line-level coverage.

- 100% of source files have a corresponding test file = 35/35
- 0% = 0/35
- Linear interpolation

Rationale: line-level coverage requires instrumenting a test run. File-level coverage can be computed statically in under a second and still catches the most common gap (files with zero tests).

### 3. Dependency Hygiene (25 points)

Reads `package.json` dependencies and searches all source files for imports/requires of each dependency name. Any dependency that never appears in source is flagged as "possibly unused."

- 0 unused dependencies = 25/25
- All unused = 0/25
- Linear interpolation

Rationale: unused dependencies increase install time, attack surface, and cognitive overhead. The heuristic can produce false positives (deps used only in scripts or config), so results are labeled "possibly" unused.

## Grading scale

| Score | Grade | Meaning |
|-------|-------|---------|
| 80-100 | A | Healthy. Ship with confidence. |
| 60-79 | B | Minor issues. Address when convenient. |
| 40-59 | C | Noticeable debt. Schedule cleanup. |
| 20-39 | D | Significant problems. Prioritize fixes. |
| 0-19 | F | Critical. CI should block on this. |

## Running it

```bash
# Human-readable report
bun run packages/proactive/health-monitor.ts

# JSON output (for CI pipelines, dashboards)
bun run packages/proactive/health-monitor.ts --json
```

## CI integration

The script exits with code 1 if the score falls below 20 (grade F). Add to any CI pipeline:

```yaml
- name: Codebase health check
  run: bun run packages/proactive/health-monitor.ts
```

## Limitations

- Test coverage is file-level, not line-level. A file with one trivial test counts the same as full coverage.
- Dependency check uses string matching. Deps used only in config files or runtime plugins may be false-flagged.
- LOC counts include comments and blank lines. This is intentional - they represent maintenance surface.
- The scan walks `packages/`, `apps/`, `src/`, `scripts/`, and `benchmarks/`. Files outside these directories are not counted.
