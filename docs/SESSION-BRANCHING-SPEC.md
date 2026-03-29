# Session Branching Spec

> Issue #938 - Tree-structured sessions with fork/navigate/summarize

## Problem

Sessions are linear. When a user wants to explore an alternative approach without losing the current thread, they must start a new session and lose context. We need branching so users can fork, explore, and return.

## Constraint

Must work with existing JSONL session format. No database migration. Minimal memory overhead - only the active branch is loaded into the LLM context window.

## Not doing

- Multi-branch merging (too complex, out of scope)
- Real-time collaborative branching
- Automatic branch creation on tool failures
- Visual tree rendering in TUI (LATER - text list is enough for now)

## Success metric

User can `/fork`, explore an alternative, `/switch` back to the parent branch, and continue where they left off. Session file remains a single JSONL with branch metadata.

---

## 1. JSONL Format Extension

Each message gets two optional fields. Existing sessions (no branch fields) are treated as branch `main`.

```typescript
interface BranchMessage {
  id: string;           // nanoid, unique per message
  parentId?: string;    // parent message id (null for root)
  branchId: string;     // branch identifier, e.g. "main", "fork-1", "fork-1-a"
  role: string;
  content: string | unknown[];
  timestamp: number;
  // ... existing fields (tool calls, usage, etc.)
}
```

---

## 2. Session DAG Storage

The session file is still a flat JSONL - one message per line. The DAG is reconstructed by walking `id`/`parentId` links on load.

```typescript
interface SessionBranch {
  id: string;           // branch identifier
  parentBranchId?: string;
  forkPointId: string;  // message id where the fork occurred
  label?: string;       // user-provided or auto-generated
  summary?: string;     // LLM-generated branch summary
  messageCount: number;
  createdAt: number;
}

interface SessionDAG {
  branches: Map<string, SessionBranch>;
  activeBranch: string;
  messages: BranchMessage[];  // flat list, filtered by branch for context
}
```

---

## 3. Commands

```
/fork [label]      # create a new branch from current message
/branches          # list all branches with summaries
/switch <id>       # switch to a different branch (reloads context)
/summarize         # generate LLM summary of current branch
/prune <id>        # delete a branch and its children
```

---

## 4. Branch Summarization

When switching away from a branch, auto-generate a 2-3 sentence summary using the same compaction prompt pattern from COMPACTION-SPEC.md. Summary is stored on the `SessionBranch` object and shown in `/branches` listing.

---

## 5. Context Loading

On `/switch`, rebuild the message array by walking from root to the target branch's tip:
1. Collect all messages from root to fork point
2. Append messages on the target branch after the fork point
3. Replace `messageHistory` in agent - triggers compaction if needed

---

## 6. Files to Create/Modify

**Create:**
- `packages/eight/session-branching.ts` - DAG construction, fork, switch, prune (~200 lines)
- `packages/eight/branch-summarizer.ts` - LLM summarization of branches (~60 lines)

**Modify:**
- `packages/eight/session-sync.ts` - add branchId/parentId to message serialization (~20 lines)
- `packages/eight/agent.ts` - wire `/fork` and `/switch` commands (~30 lines)
- `apps/tui/src/screens/ChatScreen.tsx` - branch indicator in header, `/branches` view (~40 lines)

## 7. Estimated Effort

2 new files (~260 lines), 3 modified files (~90 lines). Total: ~350 lines across 5 files.

Architecture reference: Pi coding agent's session tree model. Also inspired by ChatGPT's "edit message" branching and Git's own DAG model.
