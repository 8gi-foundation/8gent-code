# Self-Modify Skill

**Safe self-modification with strict versioning. Evolution, not vibes.**

8gent can modify its own code, tools, and configuration when stuck or when improvements are needed. Every modification is versioned, tested, and rollback-ready.

## Philosophy

Self-modification is evolution. Evolution requires:
1. **Variation** - Try something new
2. **Selection** - Keep what works
3. **Inheritance** - Pass improvements forward

Without versioning, it's just mutation. Random. Fragile. Vibes.

## What 8gent Can Modify

### Level 1: Configuration (Low Risk)
- `.8gent/config.json` - Settings, defaults
- `.8gent/skills/*.md` - Skill definitions
- System prompts and templates
- Model selection, parameters

### Level 2: Tools (Medium Risk)
- `packages/toolshed/tools/*.ts` - Individual tools
- Tool arguments, validation
- New tool creation
- Tool combination/composition

### Level 3: Core (High Risk)
- `packages/agent/index.ts` - Agent logic
- `packages/permissions/index.ts` - Security
- `packages/infinite/index.ts` - Loop behavior

## Modification Protocol

### Before Any Self-Modification

```
1. SNAPSHOT
   git stash push -m "pre-modify-$(date +%s)"

2. BRANCH
   git checkout -b 8gent/self-<description>-<timestamp>

3. DOCUMENT
   Log: "[8gent:self] Modifying <file> because <reason>"
```

### During Modification

```
1. Make ONE change at a time
2. Commit after EACH change
3. Test immediately
4. If test fails → revert that commit
5. If test passes → continue
```

### After Modification

```
1. Run full test suite
2. If ALL pass:
   - Merge to main
   - Log: "[8gent:self] Evolution successful: <summary>"
3. If ANY fail:
   - Stay on branch
   - Log: "[8gent:self] Evolution rejected: <reason>"
   - Return to main, stash preserved
```

## Self-Modification Triggers

### Automatic (8gent decides)
- Same error 3+ times → try different approach
- Tool timeout → increase timeout or switch tool
- Model failure → switch model
- Missing capability → create tool

### User-Requested
- "fix yourself"
- "improve <tool>"
- "add ability to <capability>"
- "you should be able to <action>"

## Safety Constraints

### NEVER Self-Modify
- Security/permission checks (can only add, not remove)
- Git safety rules
- Rollback capabilities
- Logging/audit trail

### ALWAYS Require
- Working branch (never modify main directly)
- Passing tests before merge
- Snapshot before attempt
- Log of what changed and why

## Evolution Log

Every self-modification is logged to `.8gent/evolution.log`:

```
[2024-03-11T09:45:00Z] MODIFY packages/toolshed/tools/search.ts
  REASON: Search timeout on large codebases
  CHANGE: Increased timeout from 30s to 120s
  RESULT: SUCCESS - tests pass
  BRANCH: 8gent/self-search-timeout-1710234567
  MERGED: true

[2024-03-11T09:50:00Z] MODIFY packages/agent/index.ts
  REASON: Need to handle streaming responses
  CHANGE: Added StreamingClient class
  RESULT: FAILED - type errors in 3 files
  BRANCH: 8gent/self-streaming-1710234567
  MERGED: false
  ROLLBACK: git checkout main
```

## Recovery

If self-modification breaks something:

```bash
# List all evolution attempts
cat .8gent/evolution.log | grep "RESULT: FAILED"

# Rollback to before specific modification
git checkout main
git stash pop  # Restore pre-modify snapshot

# Or reset to known good state
git log --oneline | head -20  # Find good commit
git reset --hard <commit>
```

## Self-Improvement Patterns

### Pattern: Add Missing Tool
```
DETECT: "I can't do X" error 3 times
ANALYZE: What tool would solve this?
CREATE: packages/toolshed/tools/<new-tool>.ts
TEST: Run against original problem
MERGE: If solves the problem
```

### Pattern: Fix Recurring Error
```
DETECT: Same error message 3+ times
ANALYZE: Root cause in my own code?
PATCH: Fix the root cause
TEST: Verify error no longer occurs
MERGE: If tests pass
```

### Pattern: Optimize Performance
```
DETECT: Operation takes >30s repeatedly
ANALYZE: Bottleneck in my code?
OPTIMIZE: Improve algorithm/caching
TEST: Verify faster + still correct
MERGE: If both conditions met
```

## Feed Output

```
[8gent:self] Detected: timeout error (3rd occurrence)
[8gent:self] Analyzing: packages/toolshed/tools/search.ts
[8gent:self] Branch: 8gent/self-search-fix-1710234567
[8gent:self] Change: Increased timeout 30s → 120s
[8gent:self] Testing...
[8gent:self] Tests: 14/14 passing
[8gent:self] Merged to main
[8gent:self] Evolution complete. Search now handles large codebases.
```

---

**Remember:** Self-modification without versioning is gambling. With versioning, it's evolution. Every mutation is an experiment. Failed experiments are discarded. Successful ones are inherited.
