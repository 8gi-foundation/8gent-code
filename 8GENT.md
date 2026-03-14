# 8GENT.md — The 8gent Development Process

This file defines how 8gent is built. It's different from CLAUDE.md (which is for any Claude agent working on this repo). This is specifically about 8gent's philosophy, architecture decisions, and the autoresearch-driven development loop.

---

## Philosophy

8gent is a **prodigy, not a product.** It's a system that learns from its own failures.

- We don't hand-tune prompts. We run benchmarks, analyze failures, derive mutations, and let the system teach itself.
- We don't pay for inference. Local Ollama models first, free OpenRouter fallback second. $0 cost ceiling.
- We don't trust vibes. Every capability is execution-graded — code compiles and tests pass, or the score is zero.

## Core Architecture

```
packages/eight/       ← The brain. Agent engine, REPL, tools, prompt system.
packages/ai/          ← AI SDK integration. Provider abstraction. Tool loop.
packages/harness-cli/ ← Headless CLI for testing 8gent sessions.
packages/specifications/ ← Session format spec (v2).
packages/dreams/      ← Creative output (scripts, video generation).
apps/tui/             ← Ink v6 terminal UI.
apps/debugger/        ← Next.js session inspector.
benchmarks/           ← 39 execution-graded benchmarks + autoresearch harness.
```

**packages/eight/ is sacred.** It is the core engine. Treat it with care. Read before you write. Understand before you modify.

## The Autoresearch Loop

Based on [Karpathy's autoresearch](https://github.com/karpathy/autoresearch):

```
1. Run all benchmarks (temperature sweep: 0.3, 0.5, 0.7)
2. Grade each output (70% execution + 30% keyword coverage)
3. Analyze failures (execution errors, missing exports, wrong patterns)
4. Derive mutations (specific learnings per benchmark)
5. Inject mutations into system prompt (with dedup: exact + 70% word overlap)
6. Repeat until convergence or max iterations
```

### Running Benchmarks

```bash
# Source the API key (needed for OpenRouter fallback)
source ~/8gent-code/.env && export OPENROUTER_API_KEY

# Single category, 3 iterations
CATEGORY=battle-test MAX_ITERATIONS=3 bun benchmarks/autoresearch/autoresearch-loop.ts

# Overnight runner (cycles all 7 categories)
bash benchmarks/autoresearch/overnight-runner.sh
```

### Experience-Based Model Router

Not a dumb fallback chain. The router (`benchmarks/autoresearch/model-router.ts`) tracks which model performs best on which domain and routes accordingly:

- Records every (model, domain, benchmarkId, score) after each run
- Routes future benchmarks to the proven best model for that domain
- Exploration bonus for untried model/domain combos
- Persists to `model-experience.json`

## Models

**Local first. Free always.**

| Model | Size | Strength |
|-------|------|----------|
| qwen3.5 | 6.6GB | Fast, sharp on structure |
| devstral | 14GB | Patient, code specialist |
| qwen3:14b | 9.3GB | General fallback |

OpenRouter `google/gemini-2.5-flash:free` as remote fallback only.

**NEVER use `openrouter/auto`** — it routes to paid models. This cost us $20 once. Never again.

## Benchmark Tiers

| Tier | Category | Count | What It Tests |
|------|----------|-------|---------------|
| 1 | Bug Fixing + Validation | 5 | Single-file fixes, input validation |
| 2 | Fullstack | 4 | Multi-file REST APIs, queues, state |
| 3 | Agentic | 7 | Config parsing, ETL, reverse engineering |
| 4 | UI Design | 8 | HTML/CSS structural verification |
| 5 | Battle Test | 15 | $500-$1500 real-world freelance contracts |

**39 total benchmarks. 250+ execution tests.**

## Current Scores (as of v0.3.0)

**8 domains passing (score 80+):**
Auth (94), Events (92), Data Pipeline (100), State Machine (92), SEO (96), Video (100), Music Theory (81), AI Consulting (95)

**7 domains improving:**
CLI (53), Finance (54), Email (54), Design Tokens (39), CI/CD (33), Data Viz (30), Security (30)

## Development Rules

1. **Benchmark before you ship.** If you change the system prompt, agent logic, or tool system — run the relevant benchmarks to check for regressions.
2. **Mutations are precious.** The accumulated learnings in `system-prompt.ts` represent hundreds of benchmark runs. Don't casually edit or clear them.
3. **Multi-file extraction is the bottleneck.** Most battle-test failures come from the LLM not producing clean multi-file output. Any improvement to code extraction in `execution-grader.ts` has outsized impact.
4. **Temperature matters.** TC001 went from 24 to 93 just by changing temp from 0.5 to 0.7. Always sweep.
5. **Mutation interference is real.** A learning that helps BT001 can regress TC001. The autoresearch loop handles this via per-category scoping, but be aware of it.
6. **Version everything.** See CLAUDE.md versioning rules. Update CHANGELOG.md with every significant change.

## Contributors

| Who | Role |
|-----|------|
| James Spalding (@jamesspalding) | Creator, architect |
| AI James (Claude) | Co-creator, benchmark engineer |
| Thomas Davis (@thomasdavis) | TUI, AI SDK, packages/eight refactor |
