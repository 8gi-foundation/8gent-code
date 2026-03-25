# Quarantine: Git Workflow Benchmark

## Problem

No benchmark validates whether Eight can perform real-world git operations - branching, committing with conventional messages, resolving merge conflicts, and using worktree isolation for parallel agent work.

## Solution

`benchmarks/categories/abilities/git-workflow.ts` - an ability benchmark (AB008) with 4 tasks:

1. **Branch, commit, push** - create a feature branch, write a file, commit with conventional message, push
2. **Conventional commit quality** - generate 5 commit messages for given scenarios, all following Conventional Commits spec
3. **Merge conflict resolution** - simulate a real conflict between two branches, resolve it with intent preservation
4. **Worktree isolation** - explain and demonstrate the agent worktree pattern from packages/orchestration/

## Scoring

| Metric | Weight | What it measures |
|--------|--------|-----------------|
| branch_commit_push_correct | 0.25 | Can the agent execute the basic git workflow? |
| conventional_commits_quality | 0.25 | Does it write proper type(scope): description messages? |
| merge_conflict_resolution | 0.30 | Can it identify, understand, and resolve conflicts? |
| worktree_isolation_understanding | 0.20 | Does it understand why Eight uses worktrees? |

## Graduation criteria

- Benchmark runs successfully in the harness
- At least one model scores above 70% on all four tasks
- Merge conflict task produces a valid resolved file (no leftover markers)
