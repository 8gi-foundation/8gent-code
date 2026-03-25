# Quarantine: WISC Context Management Framework

## Source
- LinkedIn: Cole Medin, 2000+ hours Claude Code experience
- Video: lnkd.in/ggxxepik (YouTube deep dive)

## Key Insights
WISC = Write, Isolate, Select, Compress

### W - Write (externalize memory)
- Git log as long-term memory with standardized commit messages
- Plan in one session, implement in a fresh one
- Progress files and handoffs for cross-session state

### I - Isolate (keep main context clean)
- Subagents for research (90.2% improvement per Anthropic's data)
- Scout pattern: preview docs before committing to main context

### S - Select (just in time, not just in case)
- Global rules (always loaded) - our CLAUDE.md
- On-demand context for specific code areas - our skills system
- Skills with progressive disclosure
- Prime commands for live codebase exploration

### C - Compress (only when you have to)
- Handoffs for custom session summaries
- /compact with targeted summarization instructions

## Relevance to 8gent
- We already implement most of WISC but not as a named framework
- W = our packages/memory/ + git workflow
- I = our packages/orchestration/worktree pool
- S = our skills system + system-prompt.ts USER_CONTEXT_SEGMENT
- C = our session-sync.ts checkpoint/resume
- Gap: we lack the "scout pattern" and "progressive disclosure" from S
- Gap: our compress is automatic, not user-directed like their /compact

## What to Build
1. Add WISC scoring to harness - benchmark how well Eight manages context vs baseline
2. Implement "scout pattern" - preview file outlines before loading full content (our AST-first is this!)
3. Add /compact command to TUI with targeted summarization
4. Create a WISC compliance checker that scores Eight sessions
