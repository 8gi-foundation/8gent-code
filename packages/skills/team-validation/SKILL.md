---
name: team-validation
description: 8gent's code review and validation pattern. Use when orchestrating multi-agent workflows or reviewing code for correctness, security, and performance.
type: skill
---

# Team Validation

No agent should build and validate its own work. Separation of concerns applies to AI workflows.

## Core Rule

**Builder implements. Validator verifies. They are never the same agent.**

## Agent Roles

### Builder
- Full tool access: Read, Write, Edit, Bash, Grep, Glob
- Implements the solution
- Reads CLAUDE.md and existing patterns before touching anything
- Self-reviews before handing off
- Fixes issues raised by validators

### Validator
- Read-only access: Read, Grep, Glob, Bash (no Write, no Edit)
- Verifies correctness, not taste
- Returns a structured PASS or FAIL with file:line references
- Never modifies code

### Security Specialist
- Read-only
- Focuses: injection, auth flaws, data exposure, misconfiguration, insecure deps
- Rates findings: Critical / High / Medium / Low
- References OWASP/CWE

### Performance Specialist
- Read-only
- Focuses: algorithm complexity, query efficiency, memory patterns, bundle size, render cost
- Rates findings: High / Medium / Low with expected improvement estimate

## Workflow

```
Orchestrator receives task
  -> Builder implements
  -> Validator verifies
  -> If FAIL: Builder fixes, re-validate
  -> If PASS: done
```

For security-critical work: add Security Specialist between Builder and Validator.
For performance-critical work: add Performance Specialist in parallel with Security.

## Validation Checklist

Every validation pass must cover:
- [ ] Tests pass
- [ ] Types check (no TS errors)
- [ ] Linting clean
- [ ] No hardcoded secrets or credentials
- [ ] No SQL/XSS/command injection vectors
- [ ] Edge cases handled (empty, null, large input)
- [ ] Error handling appropriate (no silent swallows)
- [ ] Follows project conventions (CLAUDE.md)
- [ ] Accessible (semantic HTML, ARIA where needed)

## Output Format

Validator returns exactly one of:

```
PASS — All checks clear. Implementation approved.

FAIL — Issues found:
1. [Security] SQL injection risk in user input (src/api/users.ts:42)
2. [Types] Return type inferred as `any` (src/lib/parser.ts:17)
```

## Key Rules

1. Builder never validates its own work.
2. Validator never writes code — only reports.
3. Specialists focus on their domain only — no scope creep.
4. Issue references must include file and line number.
5. Iterate until PASS. Track iteration count — high counts signal design problems.
6. Give agents only the tools they need. Validators get no write access. Ever.
