# Concept-First Rebuild Plan

**Rule:** Don't merge other people's code. Merge ideas. Rebuild in our architecture.

---

## Day 1: ToolGate (from NemoClaw concept)

**Concept:** Every tool invocation passes through a policy gate.

**Build:**
- `packages/eight/tool-gate.ts` — middleware that wraps every tool call
- Allow/deny by tool name + path + command + network domain
- "requires approval" class for destructive operations (rm, force push, DROP)
- "sensitive context" detector — forces local model when touching .env, credentials, keys
- Logs blocked actions with reason + suggested alternative

**DoD:**
- All tools route through ToolGate
- Safe defaults (deny destructive, allow read-only)
- Approval prompts work in TUI
- Logs show blocked reason + suggestion

---

## Day 2-3: GitHub Loop Closure (from OpenViktor concept)

**Concept:** Agent can open PRs, file issues, and schedule regressions without babysitting.

**Build:**
- `packages/eight/github-provider.ts` — tiny surface area:
  - `createBranch()`, `commit()`, `push()`, `openPR()`
  - `createIssueFromFailure(benchmark, error, score)`
  - `postBenchmarkComment(prNumber, results)`
- `packages/eight/benchmark-reporter.ts` — emits normalized result object, GitHubProvider posts it
- `.github/workflows/nightly-benchmark.yml` — template Action

**DoD:**
- Opens PR end-to-end reliably
- Creates issues from benchmark failures
- Nightly workflow runs + posts results

---

## Day 3-5: Checkpoints + Rollback (from Hermes concept)

**Concept:** Snapshot state before risky ops, auto-rollback on failure.

**Build:**
- `packages/eight/checkpoint.ts` — minimal:
  - `snapshot()` — save git branch + commit + file hashes
  - `rollback()` — git stash + restore
  - `list()` / `delete()`
- Auto-create before: large refactors, delete operations, force push
- User can manually restore via `/checkpoint restore`

**DoD:**
- Snapshot pre-run
- Rollback on failure
- User can manually restore a checkpoint

---

## Day 5-7: Memory Consolidation (from CashClaw + Hermes + Nuggets concepts)

**Concept:** One memory store, one interface. Post-run review. Frequency promotion.

**Build:**
- Pick ONE store: SQLite+FTS5 (already in hermes branch pattern)
- `packages/memory/store.ts` — single interface:
  - `store(fact, type, sessionId)`
  - `search(query, limit)`
  - `promote(factId)` — manual or auto (3+ recalls)
  - `decay()` — prune stale entries
  - `reset()` / `export()` — mandatory controls
- `packages/eight/post-run-review.ts` — after each task:
  - What failed, why, what would fix it
  - Store as structured data (tags, error type, repo area)
- NO parallel brains. One memory system.

**DoD:**
- One memory store, one interface
- Reset/export controls
- No regressions in core flows

---

## Day 7+: Hypothesis Loop (from codex-autoresearch concept)

**Concept:** Every code change is a hypothesis. Commit. Test. Keep or revert.

**Build:**
- `packages/eight/hypothesis.ts` — minimal:
  - Apply change → commit to temp branch → run verifier → keep or revert
  - Escalation: retry with error context (3x) → try different approach (2x) → give up
  - Lessons file: append to `~/.8gent/lessons.jsonl`
- Wire into the agent loop as opt-in mode (`--hypothesis` flag or `/hypothesis on`)

**DoD:**
- Agent never ships broken code in hypothesis mode
- Lessons accumulate and inject into future prompts
- Rollback is clean (no orphan branches)

---

## NOT building now (defer)

| Concept | From | Why Defer |
|---------|------|-----------|
| Browser automation | agent-browser | Needs agent-browser installed; add to onboarding later |
| Worktree swarms | ClawTeam | Too complex without ToolGate + Checkpoints first |
| Remote terminal | clsh | Nice-to-have, not launch-critical |
| GEPA prompt evolution | Hermes | Need stable baselines first |
| Bounty mode | CashClaw | Need reliable task completion first |
| Blast-radius graph | code-review-graph | Evaluate overlap with jcodemunch first |

---

## Branch Disposition

| Branch | Action |
|--------|--------|
| All 9 feature branches | **ARCHIVE, don't merge.** Extract concepts, rebuild clean. |
| 5 stale branches | `git branch -d` |
| Worktree directories | `git worktree prune` |
