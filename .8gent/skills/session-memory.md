# Session Memory Skill

**Persistent context across sessions. Never start from zero.**

8gent remembers what it was doing, what worked, what failed, and what the user prefers. Every session builds on the last.

## Philosophy

Memory is the difference between a tool and a collaborator. Without memory, every conversation is a first date. With memory, you have a partner who knows the project.

## Memory Types

### 1. Working Context (Ephemeral)
Current session state. Expires after 24h.

```json
// .8gent/context/working.json
{
  "session": "sess_1710234567",
  "started": "2024-03-11T09:45:00Z",
  "project": "8gent-code",
  "branch": "8gent/feat-auth-1710234567",
  "activeFiles": ["src/auth.ts", "src/login.tsx"],
  "currentTask": "Implementing OAuth2 login",
  "blockers": [],
  "notes": "Using Google OAuth, need to set up credentials"
}
```

### 2. Project Memory (Persistent)
Learnings specific to this project.

```json
// .8gent/context/project.json
{
  "projectName": "8gent-code",
  "initialized": "2024-03-10",
  "conventions": {
    "language": "TypeScript",
    "style": "functional",
    "testing": "vitest",
    "packageManager": "bun"
  },
  "decisions": [
    {
      "date": "2024-03-10",
      "what": "Use Ollama for local LLM",
      "why": "No API costs, privacy"
    }
  ],
  "knownIssues": [
    "npm times out often, use bun",
    "AST parser fails on .vue files"
  ]
}
```

### 3. Healing Memory (Persistent)
What errors occurred and what fixed them.

```json
// .8gent/context/healing.json
{
  "patterns": {
    "npm-timeout": {
      "count": 5,
      "lastSeen": "2024-03-11T09:30:00Z",
      "solution": "use bun instead",
      "successRate": 1.0
    }
  }
}
```

### 4. Evolution Log (Append-Only)
History of self-modifications.

```
// .8gent/evolution.log
[2024-03-11T09:45:00Z] MODIFY packages/toolshed/tools/search.ts
  REASON: timeout
  RESULT: SUCCESS
```

## Session Start

When 8gent starts a new session:

```
1. Load working context (if < 24h old)
2. Load project memory
3. Load healing memory
4. Restore branch if active task exists
5. Log: "[8gent] Resuming: <last task>"
```

Feed output:
```
[8gent] Session restored
[8gent] Last task: Implementing OAuth2 login
[8gent] Branch: 8gent/feat-auth-1710234567
[8gent] Files: src/auth.ts, src/login.tsx
[8gent] Ready to continue.
```

## Session End

When 8gent ends a session:

```
1. Save working context
2. Update project memory (new learnings)
3. Commit any pending changes
4. Log summary to evolution log
```

## Context Queries

8gent can query its own memory:

```
"What was I working on?"
→ Read working.json

"What's the project convention for X?"
→ Read project.json

"How did I fix this error before?"
→ Read healing.json

"What changes have I made to myself?"
→ Read evolution.log
```

## Memory Updates

### After Task Completion
```json
// Add to project.json decisions
{
  "date": "2024-03-11",
  "what": "OAuth2 implementation",
  "why": "User requested Google login",
  "files": ["src/auth.ts", "src/login.tsx"]
}
```

### After Error Recovery
```json
// Add/update healing.json
{
  "model-confusion": {
    "count": 1,
    "lastSeen": "2024-03-11T09:50:00Z",
    "solution": "add JSON examples to prompt",
    "successRate": 1.0
  }
}
```

### After Learning
```json
// Add to project.json knownIssues
"React 19 requires different use() pattern"
```

## Feed Output

Memory operations show briefly:
```
[8gent:memory] Saved: working context
[8gent:memory] Learned: bun faster than npm for this project
[8gent:memory] Remembered: previous auth implementation pattern
```

## Memory Cleanup

Automatic cleanup:
- Working context > 24h → archive to session history
- Healing patterns with 0% success rate → remove
- Evolution log > 1000 entries → compress old entries

Manual cleanup:
- `/forget <topic>` - Remove specific memory
- `/clear memory` - Reset all memory
- `/memory stats` - Show memory usage

## Privacy

Memory is local only:
- Stored in `.8gent/context/`
- Never uploaded anywhere
- Can be wiped with `rm -rf .8gent/context/`

## Cross-Project Learning

Some learnings apply to all projects:
- Error recovery patterns
- Tool preferences
- Model performance comparisons

These go in `~/.8gent/global/` (user home).

---

**Remember:** Memory isn't about storing everything. It's about storing what matters: context, decisions, learnings. A good memory makes tomorrow easier than today.
