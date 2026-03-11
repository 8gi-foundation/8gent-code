# Self-Heal Skill

**Automatic error recovery and adaptation. Keep going until done.**

When 8gent encounters errors, it doesn't stop and ask. It diagnoses, adapts, and continues. User sees progress in the feed but isn't interrupted.

## Philosophy

Errors are information, not blockers. Every error teaches something. A stuck agent should try alternatives, not wait for instructions.

## Error Classification

### Level 1: Transient (Auto-Retry)
- Network timeout
- Rate limit hit
- Resource temporarily unavailable
- Service restart

**Action:** Wait and retry (exponential backoff)

### Level 2: Recoverable (Auto-Adapt)
- Wrong tool for job
- Missing dependency
- Permission denied (in infinite mode)
- Model confusion

**Action:** Try alternative approach

### Level 3: Fixable (Self-Modify)
- Tool bug
- Missing capability
- Configuration error
- Recurring failure

**Action:** Fix the underlying issue (see self-modify skill)

### Level 4: Fatal (User Required)
- Hardware failure
- No network at all
- User credentials required
- Ethical/safety boundary

**Action:** Stop and explain clearly

## Recovery Patterns

### Pattern: Timeout
```
ERROR: Command timed out after 120s
DIAGNOSIS: Slow operation or infinite loop
TRY 1: Increase timeout to 300s
TRY 2: Break into smaller operations
TRY 3: Use different tool
GIVE UP: After 3 attempts, report and continue with rest of task
```

### Pattern: Model Confusion
```
ERROR: Model output unparseable / wrong format
DIAGNOSIS: Prompt unclear or model limitation
TRY 1: Rephrase prompt more explicitly
TRY 2: Add examples to prompt
TRY 3: Switch to different model
GIVE UP: After 3 attempts, simplify task
```

### Pattern: Missing Tool
```
ERROR: No tool can do X
DIAGNOSIS: Capability gap
TRY 1: Combine existing tools
TRY 2: Use shell command as fallback
TRY 3: Self-modify to add tool
GIVE UP: Skip this step, document limitation
```

### Pattern: Dependency Missing
```
ERROR: Module not found / command not found
DIAGNOSIS: Missing package or binary
TRY 1: Install with npm/bun/brew
TRY 2: Use alternative that's available
TRY 3: Download/build from source
GIVE UP: Document requirement, continue
```

## Retry Strategy

```typescript
const RETRY_CONFIG = {
  maxAttempts: 3,
  backoff: {
    initial: 1000,      // 1s
    multiplier: 2,      // 1s, 2s, 4s
    max: 30000          // 30s cap
  },
  timeout: {
    initial: 30000,     // 30s
    escalation: 2,      // 30s, 60s, 120s
    max: 300000         // 5min cap
  }
};
```

## Alternative Strategies

For each operation, 8gent has fallback strategies:

| Operation | Primary | Fallback 1 | Fallback 2 |
|-----------|---------|------------|------------|
| Search code | AST index | grep | read files |
| Run command | bun | npm | shell |
| Install deps | bun install | npm install | manual |
| Read file | Read tool | cat | grep context |
| Write file | Write tool | echo > | edit existing |
| Git commit | git commit | stash | manual save |

## Feed Output (Non-Interactive)

Errors and recovery shown in feed but don't block:

```
[8gent:heal] Error: npm install timed out
[8gent:heal] Retrying with bun install...
[8gent:heal] Success. Continuing.

[8gent:heal] Error: AST parser failed on malformed file
[8gent:heal] Falling back to grep...
[8gent:heal] Found 3 matches. Continuing.

[8gent:heal] Error: Model returned invalid JSON (attempt 1/3)
[8gent:heal] Rephrasing prompt...
[8gent:heal] Error: Model returned invalid JSON (attempt 2/3)
[8gent:heal] Switching to different model...
[8gent:heal] Success. Continuing.
```

## Error Memory

8gent remembers what worked:

```json
// .8gent/healing-memory.json
{
  "patterns": {
    "npm-timeout": {
      "count": 5,
      "solution": "use bun instead",
      "successRate": 1.0
    },
    "ast-parse-fail": {
      "count": 3,
      "solution": "grep fallback",
      "successRate": 0.9
    }
  }
}
```

Next time the same error occurs, skip to the known solution.

## When to Stop

8gent stops self-healing and asks user when:

1. **Same error 5+ times** with all alternatives exhausted
2. **Security boundary** - needs credentials, sudo, etc.
3. **Destructive operation** failed - data at risk
4. **User explicitly blocked** something
5. **Cost threshold** - would exceed token/API limits

## Integration with Infinite Mode

In Infinite Mode, self-heal is more aggressive:
- Higher retry counts
- More alternative attempts
- Self-modify enabled
- Only stops for Level 4 errors

## Health Dashboard

Track agent health over time:

```
[8gent:health] Session stats:
  Errors encountered: 12
  Auto-recovered: 11 (92%)
  User-required: 1 (8%)
  Average recovery time: 4.2s
  Most common error: npm timeout
  Most effective fix: bun fallback
```

---

**Remember:** A good agent doesn't break on first error. It adapts. It tries alternatives. It learns. The user hired 8gent to solve problems, not to report every obstacle.
