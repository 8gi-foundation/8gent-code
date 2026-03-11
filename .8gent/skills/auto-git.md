# Auto-Git Skill

**Autonomous git workflow - commit constantly, branch safely, rollback always available.**

8gent handles all git operations automatically. User never needs to ask for commits, branches, or pushes. Everything is shown in the response feed but requires no interaction.

## Philosophy

Every change is versioned. Every state is recoverable. The user focuses on *what* to build, 8gent handles *how* to version it.

## Automatic Behaviors

### On Task Start
```
1. git stash (if dirty working tree)
2. git checkout -b 8gent/<task-slug>-<timestamp>
3. Log: "[8gent] Branch: 8gent/add-auth-1710234567"
```

### During Work
```
After EVERY significant change:
1. git add <specific-files>
2. git commit -m "<type>(<scope>): <description>"
3. Log: "[8gent] Committed: feat(auth): add login form"

Commit triggers:
- File created
- File modified (>10 lines changed)
- Test passes after failing
- Error fixed
- Milestone reached
```

### On Task Complete
```
1. Final commit with summary
2. git checkout main
3. git merge 8gent/<branch> --no-ff
4. Log: "[8gent] Merged to main. Branch preserved for rollback."
```

### On Error/Failure
```
1. git stash
2. git checkout main
3. Log: "[8gent] Rolled back to main. Changes stashed."
```

## Branch Naming

| Type | Pattern | Example |
|------|---------|---------|
| Feature | `8gent/feat-<slug>-<ts>` | `8gent/feat-auth-1710234567` |
| Fix | `8gent/fix-<slug>-<ts>` | `8gent/fix-login-crash-1710234567` |
| Refactor | `8gent/refactor-<slug>-<ts>` | `8gent/refactor-api-1710234567` |
| Self-modify | `8gent/self-<slug>-<ts>` | `8gent/self-add-tool-1710234567` |

## Commit Message Format

```
<type>(<scope>): <description>

[8gent] Auto-commit during <task>
```

**Types:** feat, fix, refactor, test, chore, docs, style, perf

## Rollback Commands

User can request rollback at any time:

| Command | Action |
|---------|--------|
| `/rollback` | Undo last commit |
| `/rollback all` | Return to main, discard branch |
| `/rollback to <commit>` | Reset to specific commit |
| `/branches` | List all 8gent branches |

## Feed Output (Non-Interactive)

All git operations show in the response feed:

```
[8gent:git] Created branch: 8gent/feat-dashboard-1710234567
[8gent:git] Committed: feat(dashboard): add chart component
[8gent:git] Committed: feat(dashboard): add data fetching
[8gent:git] Committed: test(dashboard): add chart tests
[8gent:git] Merged to main (4 commits)
```

## Protected Operations

These NEVER happen automatically:
- `git push --force`
- `git reset --hard` on main
- Deleting branches with unmerged commits
- Modifying commits already pushed

## Integration with Self-Modify

When 8gent modifies its own code:
1. Always use `8gent/self-*` branch
2. More frequent commits (every change)
3. Automatic rollback if tests fail
4. Never merge to main without passing tests

## Recovery Snapshots

Before any risky operation:
```bash
git stash push -m "8gent-snapshot-$(date +%s)"
```

List recovery points:
```bash
git stash list | grep 8gent-snapshot
```

---

**Remember:** The user should never think about git. 8gent handles versioning like breathing - constant, automatic, invisible until needed.
