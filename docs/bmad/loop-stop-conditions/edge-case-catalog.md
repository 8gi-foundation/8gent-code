# Loop Stop Conditions — Edge Case Catalog

**Status:** Draft  
**Owner:** Rishi (8TO)  
**Created:** $(date)

## Overview

This catalog documents every known loop condition that can cause the vessel to hang, spin, or consume unbounded resources. Each entry has a severity, detection method, and recommended stop action.

---

## Severity Scale

| Level | Label | Description |
|-------|-------|-------------|
| P0 | Critical | Data loss, cost explosion, or system hang risk |
| P1 | High | Significant resource waste or user-visible freeze |
| P2 | Medium | Suboptimal but recoverable |
| P3 | Low | Minor inefficiency, not worth blocking on |

---

## Edge Cases

### E1: Tool Call Repetition (Same Tool, Same Args)

**Severity:** P1  
**Detection:** `DoomLoopDetector` (period=1, reps=3)  
**Current State:** Implemented and tested  
**Stop Action:** Emit `stuck` event, halt execution

```typescript
// Example: desktop_click called 3x with same coordinates
calls: [desktop_click({x:100, y:200}), desktop_click({x:100, y:200}), desktop_click({x:100, y:200})]
```

**Gap:** DoomLoopDetector is not integrated into the main agent loop.

---

### E2: Tool Call Repetition (Same Tool, Different Args)

**Severity:** P1  
**Detection:** `DoomLoopDetector` (period=1, reps=3)  
**Current State:** Implemented and tested  
**Stop Action:** Emit `stuck` event, halt execution

```typescript
// Example: read_file called 3x on different paths, same tool
calls: [read_file({path:"a.ts"}), read_file({path:"b.ts"}), read_file({path:"c.ts"})]
```

**Gap:** DoomLoopDetector is not integrated into the main agent loop.

---

### E3: Pattern Repetition (Sequence of Tools Repeated)

**Severity:** P1  
**Detection:** `DoomLoopDetector` (period=2-4, reps=2)  
**Current State:** Implemented and tested  
**Stop Action:** Emit `stuck` event, halt execution

```typescript
// Example: [read_file, edit_file] repeated 2x
calls: [read_file({path:"a.ts"}), edit_file({path:"a.ts"}), read_file({path:"a.ts"}), edit_file({path:"a.ts"})]
```

**Gap:** DoomLoopDetector is not integrated into the main agent loop.

---

### E4: Max Steps Reached (CUA)

**Severity:** P0  
**Detection:** `runComputerUseLoop` step counter >= maxSteps  
**Current State:** Implemented  
**Stop Action:** Return `{ok: false, reason: "max_steps"}`

**Current limit:** 20 steps (DEFAULT_MAX_STEPS)  
**Gap:** No adaptive step limit based on goal complexity.

---

### E5: All Model Providers Exhausted

**Severity:** P0  
**Detection:** consecutiveModelErrors >= MAX_CONSECUTIVE_ERRORS  
**Current State:** Implemented (MAX_CONSECUTIVE_ERRORS = 4)  
**Stop Action:** Return `{ok: false, reason: "goal_failed"}`

**Gap:** No distinction between transient errors (retry) and permanent errors (stop).

---

### E6: Tool Execution Timeout

**Severity:** P0  
**Detection:** None currently  
**Stop Action:** Should halt and surface error

**Example:** `run_command` hangs on infinite process  
**Gap:** No timeout enforcement on tool execution. Tools can block indefinitely.

---

### E7: Token Budget Exhaustion

**Severity:** P0  
**Detection:** None currently  
**Stop Action:** Should halt before sending oversized context

**Example:** History grows until context window is full, model receives truncated prompt  
**Gap:** No pre-send token budget check. No truncation strategy when approaching limit.

---

### E8: Cost Cap Exceeded

**Severity:** P1  
**Detection:** None currently  
**Stop Action:** Should halt when cost exceeds threshold

**Gap:** No cost tracking or cap enforcement. API calls accumulate without limit.

---

### E9: Context Window Near-Full

**Severity:** P1  
**Detection:** None currently  
**Stop Action:** Should compact history or halt

**Gap:** No context utilization tracking. No compaction triggered before overflow.

---

### E10: Retry Without Progress (Same Error Repeated)

**Severity:** P1  
**Detection:** None currently  
**Stop Action:** Should halt after N retries on same error

**Example:** Model keeps making same failed tool call  
**Gap:** No error-without-progress detection.

---

### E11: Tool Failure Cascade

**Severity:** P1  
**Detection:** None currently  
**Stop Action:** Circuit breaker after N consecutive tool failures

**Example:** Desktop automation fails repeatedly, model keeps trying  
**Gap:** No circuit breaker pattern.

---

### E12: User Abort Signal

**Severity:** P0  
**Detection:** None currently  
**Stop Action:** Immediate halt on external signal

**Gap:** No mechanism for user or system to abort a running loop.

---

### E13: Memory Exhaustion (History Growth)

**Severity:** P1  
**Detection:** None currently  
**Stop Action:** Cap history size, oldest entries removed

**Gap:** History array grows unbounded within a session.

---

### E14: Same Semantic Goal, Different Wording

**Severity:** P2  
**Detection:** None currently  
**Stop Action:** Should detect and prompt user

**Example:** Model re-asks the same question with different phrasing  
**Gap:** No semantic loop detection across the conversation.

---

### E15: Infinite Tool Chain (A calls B calls A)

**Severity:** P0  
**Detection:** None currently  
**Stop Action:** Depth cap on tool call chains

**Example:** Tool A spawns subprocess that calls tool A  
**Gap:** No call depth tracking.

---

### E16: Model Returns No Tool (Free-text Loop)

**Severity:** P2  
**Detection:** Handled in CUA loop  
**Current State:** `_no_tool` logged, loop continues with nudge  
**Stop Action:** Should halt after N consecutive `_no_tool` responses

**Gap:** No cap on `_no_tool` responses before halting.

---

### E17: Perception Failure Loop

**Severity:** P1  
**Detection:** Tree perception fails, fallback to screenshot, screenshot fails  
**Stop Action:** Should halt after N perception failures

**Gap:** Tree fallback is one-time, not tracked across iterations.

---

### E18: Approval Timeout

**Severity:** P1  
**Detection:** None currently  
**Stop Action:** Auto-deny after timeout, continue

**Gap:** No approval timeout. Awaiting user input can hang indefinitely.

---

### E19: External Dependency Unavailable

**Severity:** P1  
**Detection:** None currently  
**Stop Action:** Circuit breaker, surface error

**Example:** GitHub API rate limit, filesystem permissions denied  
**Gap:** No external dependency health tracking.

---

### E20: Prompt Injection Loop

**Severity:** P0  
**Detection:** None currently  
**Stop Action:** Immediate halt, surface alert

**Example:** Model repeatedly re-interprets injected instructions  
**Gap:** No injection pattern detection.

---

## Summary Matrix

| ID | Edge Case | Severity | Detection | Status |
|----|-----------|----------|-----------|--------|
| E1 | Tool repetition (same args) | P1 | DoomLoopDetector | Implemented (not integrated) |
| E2 | Tool repetition (diff args) | P1 | DoomLoopDetector | Implemented (not integrated) |
| E3 | Pattern repetition | P1 | DoomLoopDetector | Implemented (not integrated) |
| E4 | Max steps | P0 | Step counter | Implemented |
| E5 | Providers exhausted | P0 | Error counter | Implemented |
| E6 | Tool timeout | P0 | None | Missing |
| E7 | Token budget | P0 | None | Missing |
| E8 | Cost cap | P1 | None | Missing |
| E9 | Context near-full | P1 | None | Missing |
| E10 | Retry no progress | P1 | None | Missing |
| E11 | Tool failure cascade | P1 | None | Missing |
| E12 | User abort | P0 | None | Missing |
| E13 | Memory exhaustion | P1 | None | Missing |
| E14 | Semantic loop | P2 | None | Missing |
| E15 | Infinite tool chain | P0 | None | Missing |
| E16 | No-tool loop | P2 | Counter | Partial |
| E17 | Perception failure | P1 | None | Missing |
| E18 | Approval timeout | P1 | None | Missing |
| E19 | External dependency | P1 | None | Missing |
| E20 | Prompt injection | P0 | None | Missing |

---

## Recommended Priority

1. **E6 Tool Timeout** — P0, easiest to implement
2. **E7 Token Budget** — P0, critical for production
3. **E12 User Abort** — P0, safety requirement
4. **E15 Infinite Tool Chain** — P0, critical for agent safety
5. **E1-E3 Integration** — P1, detectors exist but not wired
6. **E4-E5 Hardening** — P1, add caps and backoff
7. **E9 Context Compaction** — P1, uses existing two-stage compactor
8. **E8 Cost Cap** — P1, financial safety
9. **E10-E11 Retry Logic** — P1, prevent waste
10. **E13 Memory** — P1, session stability
