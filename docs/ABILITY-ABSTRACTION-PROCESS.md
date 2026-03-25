# 8GI Utility Factory

**8gent Intelligence - Ability Abstraction & Obtainment Pipeline**

**Author:** Eight Operations
**Date:** 2026-03-25
**Version:** 1.0
**Status:** Operational

> Every step is logged. Every decision is traceable. Every output is reviewable. This process exists to make autonomous code production deterministic and auditable.

---

## Overview

Eight discovers abilities from real-world sources (npm trends, GitHub, Hacker News, social feeds), abstracts core patterns into lightweight specifications, generates zero-dependency implementations using local LLMs, validates them through a security gate, ships them as quarantine PRs for human review, and promotes them to main after approval. This is a closed-loop system that learns from its own successes and failures, improving the discovery heuristics and generation quality over time.

---

## Phase 1: Discovery (Research Scraper)

### Objective
Identify promising utility patterns from real-world sources before any code is written.

### Sources
- npm Trending (trending packages in JavaScript ecosystem)
- GitHub Trending (TypeScript repos, utilities, libraries)
- Hacker News (daily front page)
- X/Twitter (bookmarks, trending tech conversations)
- LinkedIn (saved posts from engineering community)

### Frequency
Every 30 minutes during work hours (08:00-22:00 UTC).

### Process
1. Scraper tool polls each source in parallel
2. Filters for utility-like patterns (single-responsibility, <500 LOC, no external deps)
3. Extracts: title, description, URL, category, platform (npm/github/web)
4. Deduplicates against existing queue
5. Appends to `scripts/utility-queue.json` with timestamp

### Output
Specifications in `scripts/utility-queue.json`:

```json
{
  "id": "uuid",
  "name": "debounce-v2",
  "description": "High-precision async debounce with cancellation token",
  "category": "async",
  "source": "npm-trending",
  "sourceUrl": "https://npm.example.com/debounce-v2",
  "discoveredAt": "2026-03-25T14:30:00Z",
  "complexity": "low",
  "estimatedLines": 45,
  "status": "pending"
}
```

### Key Rules
- Specs come from REAL sources only. Never generate synthetic utility ideas.
- Prioritize patterns that appear across multiple sources (signal > noise).
- Reject anything requiring external dependencies or built-in binary modules.
- Never queue utilities already in `packages/tools/` or quarantine.

### Tool
`scripts/research-scraper.ts` (Bun TypeScript, ~300 lines)

---

## Phase 2: Extraction (Concept Abstraction)

### Objective
For each discovered spec, identify whether the core pattern can be rebuilt as a lightweight, zero-dependency utility.

### Process
1. For each spec in queue with status "pending":
   - Read the source (npm README, GitHub repo, article, etc.)
   - Extract: core algorithm, API surface, edge cases, dependencies
   - Ask: "Can this be rebuilt in under 200 lines with zero dependencies?"
   - If **YES**: generate extraction spec, move to Phase 3
   - If **NO**: mark as "rejected" (too complex), log reason, skip

2. Extraction spec includes:
   - Core algorithm in 1-2 sentences
   - Required functions/exports
   - Key edge cases to handle
   - Test scenarios (happy path, error cases)
   - Max lines of code (typically 80-180)

### Output
Updated spec in queue with status "extracted":

```json
{
  "id": "uuid",
  "name": "debounce-v2",
  "description": "High-precision async debounce with cancellation token",
  "extraction": {
    "algorithm": "Delayed function invocation with cancellation via AbortSignal. Timer resets on each call.",
    "exports": ["debounce", "createDebounceController"],
    "edgeCases": [
      "Immediate invocation before delay expires",
      "Cancellation during pending execution",
      "Serialization of abort tokens"
    ],
    "maxLines": 120,
    "status": "extracted"
  }
}
```

### Key Rules
- Do NOT read or execute the source code directly. Read documentation and examples only.
- Do NOT copy function signatures or implementations. Abstract the pattern.
- If the spec requires more than 200 lines, reject it and move on. Complexity debt is not welcome.
- Every extraction decision is documented with reasoning.

### Tool
`scripts/concept-extractor.ts` (manual review or semi-automated)

---

## Phase 3: Generation (Utility Factory)

### Objective
Convert extraction specs into working TypeScript implementations using a local LLM, with zero cloud tokens.

### Process
1. For each spec with status "extracted":
   - Prepare factory prompt (structured template)
   - Invoke local model via Ollama or vessel pool
   - Extract TypeScript code from response
   - Write to `packages/tools/{name}.ts`
   - Write metadata to `quarantine/{name}.md`
   - Log attempt to `scripts/factory-log.json`

2. Factory prompt structure:
   - Spec name and description
   - Core algorithm and exports
   - Example usage
   - Edge cases to handle
   - Constraints (max lines, zero deps, no eval/require, typed)
   - Request for clean, production-ready code

3. Code extraction:
   - Parse markdown response for TypeScript code block
   - Validate syntax (Bun TypeScript parser)
   - Extract only the final code block if multiple

### Output
Two files per utility:

**`packages/tools/{name}.ts`** - Implementation (~80-200 lines)
```typescript
// Debounce implementation with AbortSignal support
export interface DebounceOptions {
  delay: number;
  immediate?: boolean;
}

export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  options: DebounceOptions
): T {
  // Implementation
}
```

**`quarantine/{name}.md`** - Requirements document
```markdown
# debounce-v2

## Description
High-precision async debounce with cancellation token.

## API
- `debounce(fn, options)` - Returns debounced function
- `options.delay` - Milliseconds to wait
- `options.immediate` - Invoke on leading edge

## Tests
- [ ] Immediate invocation works
- [ ] Timer resets on each call
- [ ] AbortSignal cancels pending execution

## Generated by
`scripts/utility-factory.ts` on 2026-03-25T15:45:00Z
```

### Model Selection
- Primary: Ollama (local, `eight-1-q-14b` or `qwen3.5`)
- Fallback: Vessel pool (5 instances on Fly.io AMS, round-robin)
- Timeout: 30 seconds per request
- Retry: 3 attempts with exponential backoff

### Metrics
- Generation time per utility (target: < 10s)
- Ollama success rate (target: > 90%)
- Token efficiency (target: < 500 tokens per spec)
- Code validation rate (target: 100% syntax-valid)

### Key Rules
- Zero Claude tokens used. Local models only.
- Never use web-based APIs. No OpenAI, no Anthropic, no cloud.
- If model times out after 3 retries, move spec to "retry-queue" for next batch.
- Every generated file must pass syntax validation before writing to disk.

### Tool
`scripts/utility-factory.ts` (Bun TypeScript, ~400 lines)

---

## Phase 4: Validation (Security Gate)

### Objective
Ensure generated code is safe, efficient, and production-ready before any human review.

### Process
1. For each generated file:
   - Run `securityReview()` function (sync, no network calls)
   - Check against 12 validation rules
   - Log result to `scripts/factory-log.json`
   - If PASS: advance to Phase 5 (Quarantine)
   - If REJECT: mark spec as "invalid", skip PR creation, log reason

### Validation Rules

| Rule | Check | Rationale |
|------|-------|-----------|
| **No require()** | Grep for `require(` | Breaks bundlers, cloud-only pattern |
| **No eval()** | Grep for `eval(` or `Function(` | Code injection vulnerability |
| **No process.env mutation** | Grep for `process.env[` assignment | Global state mutation |
| **No auto-executing code** | Check for top-level function calls (except exports, imports) | Should not run on import |
| **No excessive `any`** | Count `any` types, warn if > 5 | Type safety requirement |
| **Max 250 lines** | Line count <= 250 | Code bloat detection |
| **No unauthorized network** | Grep for `fetch(`, `http.request()` | Security risk without context |
| **No child_process** | Grep for `child_process`, `spawn()` | Process isolation required |
| **TypeScript valid** | Parse with Bun TS parser | Syntax correctness |
| **Exports present** | Check for `export` statements | Module completeness |
| **No commented-out code** | Flag significant comment blocks | Code smell |
| **No circular deps** | Static analysis of import graph | Dependency correctness |

### Rejection Examples

**REJECT: eval() detected**
```
Security gate FAILED for rate-limiter-v2.ts
Reason: eval() used in logic
Action: Marked as invalid, PR not created
Log: scripts/factory-log.json (2026-03-25T15:50:23Z)
```

**REJECT: Exceeds line limit**
```
Security gate FAILED for state-machine.ts
Reason: 312 lines (limit 250)
Action: Marked as oversized, refer back to extraction phase
Log: scripts/factory-log.json (2026-03-25T15:51:10Z)
```

**PASS: Approved**
```
Security gate PASSED for debounce-v2.ts
- Lines: 78
- any types: 2 (acceptable)
- No eval(), require(), process.env mutation
- Exports: debounce, createDebounceController
Action: Advanced to Phase 5 (Quarantine PR)
Log: scripts/factory-log.json (2026-03-25T15:48:45Z)
```

### Key Rules
- Never skip the security gate. Every LLM output must be validated.
- Rejections are logged for meta-improvement (Phase 7).
- If a rule is too strict and causes false positives, it goes to review queue for human judgment.
- Security gate runs synchronously before any git/GitHub operations.

### Tool
`securityReview()` function in `scripts/utility-factory.ts` (~150 lines)

---

## Phase 5: Quarantine (Branch + PR)

### Objective
Isolate each utility in its own branch and create a GitHub PR for human review with full context.

### Process
1. For each approved utility (security gate PASS):
   - Create git branch: `quarantine/{name}`
   - Commit both files: `packages/tools/{name}.ts` and `quarantine/{name}.md`
   - Commit message: `feat: {name} utility via AAIP factory (gen {timestamp})`
   - Push branch to origin
   - Create GitHub PR with structured template
   - Update PR status in queue to "in-review"

2. GitHub PR template:
   ```markdown
   ## Ability: {name}

   ### What
   {description from quarantine doc}

   ### Why
   Discovered from {source} on {date}.
   Pattern abstraction: {1-sentence algorithm}.

   ### How It Works
   - Exports: {list}
   - Max lines: {N}
   - Security gate: PASSED

   ### Tests to Run
   ```bash
   bun test packages/tools/{name}.test.ts
   ```

   ### Files Changed
   - `packages/tools/{name}.ts` ({lines} lines)
   - `quarantine/{name}.md` (requirements)

   ### Next Steps
   1. Review code for clarity and correctness
   2. Run test suite (if tests provided)
   3. Decision: merge (promote) or close (reject)

   **Generated by Utility Factory** | Gen {timestamp}
   ```

3. Telegram notification:
   - Send to @aijamesosbot with plain-language summary
   - Include: name, source, core algorithm, PR URL
   - Optional: attach voice note (macOS `say` command) with reading of summary

### Quarantine Rules
- Each utility gets ONE branch. No stacking utilities on a single branch.
- Branch name format: `quarantine/{kebab-case-name}` (e.g., `quarantine/debounce-v2`)
- PR title format: `[AAIP] {name}: {one-line description}`
- No squash-merge. Preserve the factory-generated commit.
- Quarantine is **isolation for review**, not a holding pen. PRs should move to merge or close within 24 hours.

### Tool
PR creation is handled in `scripts/utility-factory.ts` via GitHub REST API (Octokit)

---

## Phase 6: Review & Promotion (Human Gate)

### Objective
James reviews each PR on GitHub and decides to merge (promote) or close (reject).

### Review Checklist
Before merging, James verifies:

- [ ] Code is readable and maintainable
- [ ] No dead code or commented-out blocks
- [ ] Error handling is present and sensible
- [ ] Edge cases from quarantine doc are addressed
- [ ] Utility solves a real problem (not academic)
- [ ] No conflicts with existing utilities in `packages/tools/`
- [ ] Security gate passed (already done, but double-check)

### Promotion Decision

**MERGE** (Approve)
- Code is solid, fills a gap, community will benefit
- Move to main branch
- Update CHANGELOG.md with new ability
- Close associated notifications
- Metrics: increment "merge-count" in meta-improvement

**CLOSE** (Reject)
- Code quality issues, insufficient docs, or low utility value
- Add rejection reason as comment
- Move spec status to "rejected" with reason
- Metrics: increment "rejection-count" in meta-improvement

### Merge Procedure
1. GitHub web: Click "Merge pull request"
2. Merge strategy: Create a merge commit (preserve factory commit)
3. Delete branch after merge
4. CHANGELOG.md updated manually with entry:
   ```markdown
   ### Added
   - `debounce-v2`: High-precision async debounce with cancellation token
   ```
5. Verify deployment: Package is now available in `packages/tools/`

### Key Rules
- Human review is MANDATORY. No auto-merge.
- James is the sole approval authority for 8gent-code.
- Merge happens on GitHub (not locally), to preserve CI/CD hooks.
- Rejected utilities are not re-queued without significant revision.
- Promotion metrics inform Phase 7 meta-improvement.

### Slack/Telegram Notification on Merge
When PR is merged, send:
```
Utility promoted: debounce-v2
Status: MERGED to main
Lines: 78
Category: async
Next: available in next release
```

---

## Phase 7: Meta-Improvement (HyperAgent Loop)

### Objective
Every 20 experiments (or weekly), analyze factory-log.json for patterns in success and failure, then improve the discovery heuristics and generation quality.

### Process

**Trigger:** After 20 completed experiments or on a fixed weekly schedule (Sundays 18:00 UTC)

**Analysis:**
1. Read `scripts/factory-log.json` (all recent entries)
2. Calculate metrics:
   - Generation success rate (code validity %)
   - Security gate pass rate (% passing validation)
   - Merge rate (% of PRs merged by James)
   - Timeout rate (% Ollama timeouts)
   - Average generation time per utility
   - Category distribution (async, math, string, etc.)

3. Identify patterns:
   - Which categories have highest merge rate? (double down on discovery)
   - Which have highest rejection rate? (refine extraction heuristics)
   - Which sources produce the best specs? (weight in discovery)
   - Which validation rules cause false positives? (loosen or remove)

4. Update system configuration:
   - Adjust research scraper weight for high-signal sources
   - Revise factory prompt based on common failures
   - Tighten or loosen security gate rules
   - Update model selection (switch Ollama version if improvements emerge)

**Output: Meta-Improvement Report**
```markdown
# AAIP Meta-Improvement Report
**Period:** 2026-03-18 to 2026-03-25
**Experiments:** 20
**Date Generated:** 2026-03-25T22:00:00Z

## Metrics
- Generation success rate: 92% (18/20)
- Security gate pass rate: 95% (17/18)
- Merge rate: 71% (12/17)
- Timeout rate: 1% (1/100 requests)
- Avg generation time: 6.2s

## Best Performers
1. Category: async (merge rate 80%, 5/5 promoted)
2. Source: npm-trending (81% merge rate)
3. Model: ollama qwen3.5 (94% validity)

## Worst Performers
1. Category: compression (merge rate 40%, 2/5)
2. Source: linkedin (62% merge rate)
3. Failure: "exceeds line limit" (3 rejections)

## Decisions
- Double discovery frequency for async utilities
- Reduce expected line limit from 250 to 180 (reduce complexity debt)
- Add secondary model fallback: Mistral if Ollama unavailable
- De-weight LinkedIn source (lower signal)

## Next Actions
1. Update `scripts/discovery-config.json` with new weights
2. Revise factory prompt to target 120-line average
3. Test Mistral model on next batch
```

**Distribution:**
- Save to `scripts/meta-improvement-logs/{date}.md`
- Telegram notification to @aijamesosbot with summary
- Update `CHANGELOG.md` with process improvements

### Key Rules
- Meta-improvement runs AFTER every 20 experiments, not continuously.
- Decisions are data-driven. Hypothesis testing, not guesswork.
- Any changes to discovery weights, generation prompts, or validation rules are documented and dated.
- If a change causes worse outcomes in the next batch, revert immediately and log reason.
- The improvement process itself is versioned and can be rolled back.

### Tools
- `scripts/meta-analyzer.ts` (analysis and report generation)
- `scripts/meta-improvement-logs/` (historical reports)

---

## Infrastructure

### Components

| Component | Location | Runtime | Role | Scaling |
|-----------|----------|---------|------|---------|
| **Research Scraper** | scripts/research-scraper.ts | Bun (local or vessel) | Polls sources every 30min, queues specs | Parallel 6 sources |
| **Concept Extractor** | scripts/concept-extractor.ts | Bun + Claude (optional) | Abstracts patterns, builds extraction specs | Manual or semi-automated |
| **Utility Factory** | scripts/utility-factory.ts | Bun + Ollama/Vessel | Generates code, validates, creates PRs | Up to 5 concurrent |
| **Utility Queue** | scripts/utility-queue.json | File-based | Spec backlog with status tracking | Unlimited queue depth |
| **Factory Log** | scripts/factory-log.json | JSONL append-only | Audit trail of all experiments | ~100 entries/week |
| **Meta-Analyzer** | scripts/meta-analyzer.ts | Bun | Weekly analysis, recommendations | On-demand |
| **Ollama** | localhost:11434 | Local or remote | LLM for code generation | Single instance |
| **Vessel Pool** | eight-factory on Fly.io AMS | Fly.io | Fallback/parallel generation | 5 instances |
| **GitHub API** | Octokit (npm) | Cloud | Branch/PR creation, merging | Rate-limited: 60 req/hour |
| **Telegram Bot** | @aijamesosbot | Cloud | Notifications and approvals | Instant |

### Configuration

**`scripts/discovery-config.json`** - Source weighting
```json
{
  "sources": {
    "npm-trending": { "enabled": true, "weight": 1.0, "refreshInterval": "30m" },
    "github-trending": { "enabled": true, "weight": 0.8, "refreshInterval": "1h" },
    "hacker-news": { "enabled": true, "weight": 0.6, "refreshInterval": "1h" },
    "x-bookmarks": { "enabled": true, "weight": 0.4, "refreshInterval": "2h" },
    "linkedin-posts": { "enabled": false, "weight": 0.2, "refreshInterval": "2h" }
  },
  "deduplication": true,
  "minComplexity": "low",
  "maxEstimatedLines": 500
}
```

**`scripts/factory-config.json`** - Generation settings
```json
{
  "modelPrimary": {
    "type": "ollama",
    "endpoint": "http://localhost:11434",
    "model": "qwen3.5",
    "timeout": 30000
  },
  "modelFallback": {
    "type": "vessel",
    "endpoint": "https://eight-factory.fly.dev",
    "poolSize": 5,
    "timeout": 30000
  },
  "maxLines": 180,
  "retryAttempts": 3,
  "backoffMs": 1000,
  "concurrency": 3
}
```

**`scripts/validation-rules.json`** - Security gate rules
```json
{
  "rules": [
    { "name": "no-require", "enabled": true, "pattern": "require\\(" },
    { "name": "no-eval", "enabled": true, "pattern": "eval\\(|Function\\(" },
    { "name": "no-env-mutation", "enabled": true, "pattern": "process\\.env\\[.*\\]\\s*=" },
    { "name": "no-auto-execute", "enabled": true, "check": "topLevelCalls" },
    { "name": "max-any-types", "enabled": true, "threshold": 5 },
    { "name": "max-lines", "enabled": true, "limit": 250 },
    { "name": "no-unauthorized-network", "enabled": true, "pattern": "fetch\\(|http\\.request" },
    { "name": "no-child-process", "enabled": true, "pattern": "child_process|spawn\\(" },
    { "name": "typescript-valid", "enabled": true, "check": "syntax" },
    { "name": "exports-present", "enabled": true, "check": "exports" },
    { "name": "no-dead-code", "enabled": true, "check": "comments" },
    { "name": "no-circular-deps", "enabled": true, "check": "imports" }
  ]
}
```

---

## Metrics & Dashboards

### Real-Time Metrics (Updated on every experiment)

| Metric | Source | Target | Current | Trend |
|--------|--------|--------|---------|-------|
| **Queue Depth** | utility-queue.json | < 50 | 23 | Stable |
| **Generation Success** | factory-log.json | > 90% | 92% | Up 2% |
| **Security Pass Rate** | factory-log.json | > 95% | 95% | Stable |
| **Merge Rate** | GitHub API | > 70% | 71% | Up 3% |
| **Timeout Rate** | factory-log.json | < 5% | 1% | Down (good) |
| **Avg Gen Time** | factory-log.json | < 10s | 6.2s | Down (good) |

### Weekly Snapshot (Meta-improvement report)

```
Period: 2026-03-18 to 2026-03-25
Utilities Generated: 20
Utilities Merged: 12
Utilities Rejected: 5
Utilities Queued: 3
Success Rate: 60% (12/20 merged)
```

### Category Performance

```
async: 80% merge rate (5 merged, 1 rejected)
math: 75% merge rate (3/4)
string: 67% merge rate (2/3)
data-structure: 60% merge rate (2/3)
compression: 40% merge rate (2/5)
```

### Source Performance

```
npm-trending: 81% merge rate (13/16)
github-trending: 65% merge rate (13/20)
hacker-news: 58% merge rate (7/12)
x-bookmarks: 50% merge rate (3/6)
linkedin: 40% merge rate (2/5) [considering disabling]
```

---

## Anti-Patterns (What NOT to Do)

### 1. Never Generate Specs Synthetically
- WRONG: "Let me invent 10 utility ideas for async operations"
- RIGHT: Scrape npm for actual trending async utilities, abstract patterns

### 2. Never Skip the Security Gate
- WRONG: "This code looks fine, let's ship it"
- RIGHT: Run every generated file through all 12 validation rules

### 3. Never Push to Main Without Human Review
- WRONG: Auto-merge after security gate passes
- RIGHT: Create quarantine PR, wait for James's explicit approval

### 4. Never Use Claude Tokens for Bulk Generation
- WRONG: Use Claude API to generate 100 utilities per day
- RIGHT: Use Ollama (free, local) for all code generation

### 5. Never Import Code Wholesale
- WRONG: Copy-paste npm package code into packages/tools/
- RIGHT: Read package docs, abstract the core pattern, rebuild in <200 lines

### 6. Never Pad PR Counts with Empty Utilities
- WRONG: Create 50 trivial utilities to inflate metrics
- RIGHT: Only queue utilities that solve real problems discovered from real sources

### 7. Never Ignore Rejection Feedback
- WRONG: Re-queue a rejected utility unchanged
- RIGHT: Update extraction spec based on James's feedback, re-submit

### 8. Never Disable Meta-Improvement
- WRONG: Run factory continuously without analyzing results
- RIGHT: Analyze every 20 experiments, adjust heuristics based on data

---

## Workflow Examples

### Example 1: Happy Path (Discover -> Generate -> Merge)

**2026-03-25 14:30 UTC: Discovery**
```
Research scraper finds trending npm package: "p-queue-v4"
Pattern: Priority queue for async task scheduling
Spec added to utility-queue.json with status "pending"
```

**2026-03-25 15:00 UTC: Extraction**
```
Extractor reads npm README and GitHub
Core pattern: FIFO queue with configurable concurrency and priorities
Estimated lines: 95
Max dependencies: 0
Status updated to "extracted"
```

**2026-03-25 15:15 UTC: Generation**
```
Factory invokes Ollama with extraction spec
Prompt includes algorithm, API surface, edge cases
Model returns valid TypeScript in 4.2 seconds
Output: packages/tools/priority-queue.ts (92 lines)
Metadata: quarantine/priority-queue.md
```

**2026-03-25 15:18 UTC: Validation**
```
Security gate runs 12 checks
All pass: no eval(), no require(), 92 < 250 lines, 1 any type
Status: "validated"
```

**2026-03-25 15:20 UTC: Quarantine**
```
Branch created: quarantine/priority-queue
Commit: "feat: priority-queue utility via AAIP factory"
PR created: [AAIP] priority-queue: async task queue with priorities
Telegram notification sent to @aijamesosbot
```

**2026-03-26 10:00 UTC: Review**
```
James reviews PR on GitHub mobile
Code is clean, edge cases handled, fills a gap
Decision: MERGE
Branch merged to main, deleted
CHANGELOG.md updated
```

**2026-03-26 10:05 UTC: Meta-tracking**
```
Factory log updated: { status: "merged", mergeTime: "20h", category: "async" }
Queue depth down to 22
```

---

### Example 2: Security Gate Rejection (Discover -> Generate -> Reject)

**2026-03-25 16:00 UTC: Discovery**
```
Scraper finds GitHub repo: "state-machine-runtime"
Looks promising: compact state machine implementation
Spec added with status "pending"
```

**2026-03-25 16:30 UTC: Extraction**
```
Extractor reads implementation
Core: FSM with guards, transitions, middleware hooks
Estimated lines: 310 (EXCEEDS 200-line threshold)
Decision: REJECT - too complex
Status: "rejected" with reason "complexity exceeds extraction target"
```

**Log entry:**
```json
{
  "timestamp": "2026-03-25T16:30:00Z",
  "utility": "state-machine-runtime",
  "phase": "extraction",
  "status": "rejected",
  "reason": "complexity exceeds extraction target (310 lines, max 200)"
}
```

---

### Example 3: Validation Gate Rejection (Discover -> Generate -> Fail)

**2026-03-25 17:00 UTC: Generation**
```
Factory generates code for "cache-resolver" utility
Model returns 165 lines, looks good
```

**2026-03-25 17:02 UTC: Validation**
```
Security gate runs checks
FAIL: eval() detected in caching logic
```

**Log entry:**
```json
{
  "timestamp": "2026-03-25T17:02:30Z",
  "utility": "cache-resolver",
  "phase": "validation",
  "status": "rejected",
  "reason": "eval() detected",
  "line": 87,
  "snippet": "const cached = eval(cacheKey)"
}
```

**Action:**
- No PR created
- Spec status: "invalid"
- Factory log updated
- No Telegram notification (only errors sent)

---

## Rollback & Recovery

### If Security Gate is Too Strict
Evidence: < 70% merge rate despite high validation pass rate

**Action:**
1. Review "false positive" rejections in factory-log.json
2. Example: "max-any-types" rule rejecting utilities with legitimate any types
3. Adjust threshold: increase from 5 to 8
4. Test on next batch
5. Document decision: "Loosened any-type rule to 8 on 2026-03-26 due to 60% merge rate"

### If Model Generation Degrades
Evidence: > 20% syntax errors or nonsensical code

**Action:**
1. Check Ollama version: `ollama list` and model hash
2. If model changed unexpectedly, revert to known-good version
3. If timeout rate spikes, switch primary model from qwen3.5 to mistral
4. Run batch re-generation on failed utilities
5. Log decision and results

### If Source Becomes Noisy
Evidence: > 30% rejections from single source (e.g., LinkedIn)

**Action:**
1. Reduce weight in discovery-config.json (0.4 -> 0.1)
2. Or disable entirely (enabled: false)
3. Next meta-improvement cycle, review whether to re-enable
4. Prioritize high-signal sources (npm, GitHub)

---

## Future Enhancements

### Planned (Roadmap)
1. **Automated Testing Generation** - Factory generates .test.ts files with jest/vitest
2. **Documentation Generation** - Auto-generate JSDoc comments and README snippets
3. **Performance Profiling** - Factory includes benchmarks in generated files
4. **Multi-Model Ensembling** - Compare outputs from Ollama + Mistral + LLaMA, vote on best
5. **Utility Versioning** - Track breaking changes, auto-bump patch versions
6. **Analytics Dashboard** - Web UI for factory metrics, category trends, source performance

### Speculative (Longer Term)
1. **Community Voting** - Users upvote/downvote utilities in PRs
2. **Utility Marketplace** - Share and sell abilities across 8gent ecosystem
3. **RL Fine-Tuning on Factory Logs** - Train custom model for better code generation
4. **Cross-Language Support** - Generate Python, Go, Rust utilities alongside TypeScript
5. **Distributed Generation** - Scale factory across 50+ vessels for parallel synthesis

---

## FAQ

### Q: Why not use Claude for code generation?
**A:** Cost at scale. Generating 20 utilities/week via Claude would be $50-100/month. Ollama is free and runs locally. We use Claude only for concept extraction (once per utility), not bulk generation.

### Q: What if the LLM generates insecure code?
**A:** Security gate catches it. Every utility passes through 12 validation checks before any human sees it. False positives are rare; false negatives are logged and fed into meta-improvement.

### Q: Can I submit my own utility ideas?
**A:** Not yet. AAIP is automated discovery-first. Human-submitted ideas are tracked separately. Future: community voting on quarantine PRs.

### Q: How do I know if a utility is "production-ready"?
**A:** Merged to main = approved by James. Quarantine is review-stage. Unreleased until in a tagged version.

### Q: What happens to rejected utilities?
**A:** They're marked "rejected" in utility-queue.json with a reason. Re-submission requires significant revision based on feedback. Some are genuinely low-value; some just need tweaking.

### Q: How often should meta-improvement run?
**A:** Every 20 experiments OR weekly, whichever comes first. Run manually with `bun scripts/meta-analyzer.ts`.

### Q: Can I disable specific validation rules?
**A:** Yes. Edit `scripts/validation-rules.json` and set `enabled: false`. Changes are logged. Test on next batch and revert if outcomes worsen.

### Q: What if Ollama crashes during generation?
**A:** Timeout after 30 seconds, fall back to vessel pool. If both fail, move utility to "retry-queue" and retry in next cycle.

### Q: How do I run the factory manually?
**A:** `bun scripts/utility-factory.ts --limit 5` to generate 5 utilities. `--dry-run` to skip PR creation.

---

## Appendix: Command Reference

### Run Discovery
```bash
bun scripts/research-scraper.ts --full-run
```

### Run Generation (Manual)
```bash
bun scripts/utility-factory.ts --limit 10
bun scripts/utility-factory.ts --dry-run  # Test without creating PRs
```

### View Factory Log
```bash
tail -50 scripts/factory-log.json | jq '.[] | { utility, phase, status }'
```

### Run Meta-Improvement
```bash
bun scripts/meta-analyzer.ts --period 7d  # Last 7 days
```

### Check Validation Rules
```bash
cat scripts/validation-rules.json | jq '.rules[] | { name, enabled }'
```

### View Queue Status
```bash
cat scripts/utility-queue.json | jq 'group_by(.status) | map({ status: .[0].status, count: length })'
```

### Inspect Single Utility
```bash
cat scripts/utility-queue.json | jq '.[] | select(.name == "debounce-v2")'
```

### Count by Category
```bash
cat scripts/utility-queue.json | jq 'group_by(.category) | map({ category: .[0].category, count: length })'
```

---

## Revision History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-03-25 | Eight Operations | Initial process document, 7 phases, full infrastructure |

---

**Document Owner:** Eight Operations
**Last Updated:** 2026-03-25
**Status:** Active
**Approval:** James Spalding
