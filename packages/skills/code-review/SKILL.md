---
name: code-review
trigger: /code-review
description: Analyzes code for quality, security vulnerabilities, and best practices. Provides actionable feedback with severity ratings.
category: analysis
tools: [read_file, list_files, grep, ast_parse]
---

# Code Review Skill

Performs comprehensive static analysis on code files or directories. Identifies common issues, security vulnerabilities, and provides actionable suggestions for improvement.

## What It Checks

### Type Safety
- Avoid `any` types in TypeScript
- Ensure proper type annotations
- Check for unsafe type assertions

### Code Quality
- Function complexity and size
- Naming conventions
- Code duplication
- Dead code detection

### Best Practices
- Proper error handling (try-catch blocks)
- Use strict equality (`===` not `==`)
- Structured logging over console.log
- Async/await over callbacks

### Security
- Input validation
- SQL injection risks
- XSS vulnerabilities
- Hardcoded credentials

## Usage

Review a single file:
```
/code-review src/app.ts
```

Review a directory:
```
/code-review src/
```

With specific focus:
```
/code-review src/auth.ts --focus=security
```

## Output Format

```
CODE REVIEW RESULTS
===================

File: src/app.ts
Lines: 342

ISSUES FOUND: 3

[HIGH] Type Safety (line 45)
  Avoid using "any" type for better type safety
  → Suggestion: Use specific type or generic constraint

[MEDIUM] Strict Equality (line 89)
  Use strict equality (===) instead of (==)
  → Quick fix: Replace == with ===

[MINOR] Logging (line 120)
  Use structured logging instead of console.log
  → Suggestion: Use logger.info() with context

SUGGESTIONS: 2

[MEDIUM] Function Size (line 150-250)
  Function is 100 lines long
  → Consider breaking into smaller functions

[LOW] Code Duplication
  Similar logic found in lines 45-60 and 180-195
  → Extract to shared utility function

QUALITY SCORE: 75/100 (Grade: B)
```

## Review Process

1. **Parse Code**: Use AST parser appropriate for language (TypeScript, JavaScript, Python, etc)
2. **Static Analysis**: Check for common anti-patterns and code smells
3. **Security Scan**: Look for OWASP Top 10 vulnerabilities
4. **Best Practices**: Compare against language-specific style guides
5. **Generate Report**: Prioritize issues by severity
6. **Provide Fixes**: Include actionable suggestions with line numbers

## Severity Levels

- **CRITICAL**: Security vulnerabilities, data loss risks
- **HIGH**: Type safety issues, potential bugs
- **MEDIUM**: Code quality, maintainability concerns
- **LOW**: Style preferences, minor optimizations
- **INFO**: Educational suggestions, future improvements

## Integration

Works well with:
- `/test-generator` - Generate tests for identified edge cases
- `/security-audit` - Deep dive on security findings
- `/documentation-writer` - Document complex logic identified

## Configuration

Can be customized with focus areas:
- `--focus=security` - Security-focused review
- `--focus=performance` - Performance bottlenecks
- `--focus=types` - Type safety only
- `--strict` - Enforce all rules strictly
- `--fix` - Auto-fix trivial issues where possible

## Examples

### Example 1: Quick Review
```
/code-review utils.ts
```

Output:
```
✓ Analyzed 234 lines
✓ No critical issues
⚠ 2 suggestions
Score: 95/100 (A)
```

### Example 2: Security Focus
```
/code-review api/auth.ts --focus=security
```

Output:
```
[CRITICAL] SQL Injection Risk (line 67)
  User input directly in query
  → Use parameterized queries

[HIGH] Missing Rate Limiting (line 45)
  Login endpoint has no rate limit
  → Add rate limiter middleware
```

### Example 3: Directory Review
```
/code-review src/
```

Output:
```
Reviewed 15 files (2,340 lines)

Top Issues:
1. Type safety: 12 occurrences
2. Error handling: 8 occurrences
3. Logging: 23 occurrences

Overall Score: 78/100 (B+)

Worst File: src/legacy/parser.ts (Score: 45/100)
Best File: src/utils/validator.ts (Score: 98/100)
```

## Notes

- Focuses on actionable feedback, not pedantic style
- Severity based on impact to correctness, security, maintainability
- Provides context-aware suggestions (knows framework patterns)
- Fast analysis (<2s for most files)
- Can integrate with CI/CD pipelines
