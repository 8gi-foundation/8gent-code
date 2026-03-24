# Model Shootout - 8gent Local vs Cloud

**Date:** 2026-03-23
**Purpose:** Test 8gent's ability to complete real GitHub issues autonomously using free models.

## Setup

Two 8gent instances running the same codebase, different models:

| Instance | Location | Model | Runtime |
|----------|----------|-------|---------|
| **Local** | MacBook, ws://localhost:18789 | eight-1-q-14b (Qwen 3 14B fine-tuned) | Ollama |
| **Vessel** | Fly.io Amsterdam, wss://eight-vessel.fly.dev | nvidia/nemotron-3-super-120b-a12b:free | OpenRouter |

## Round 1: Issue Dispatch (5 tasks, 2 agents)

Dispatched 5 GitHub issues via `scripts/dispatch-issues.ts`. Local got 3 tasks, Vessel got 2. Each task included a detailed prompt with the issue description, file paths, and expected output.

**Timeout:** 180s per task. **MaxTurns:** 15 tool calls.

| # | Issue | Agent | Tools Used | Outcome |
|---|-------|-------|------------|---------|
| 17 | bun:sqlite .pragma() crash | Local 14B | 4 | Timeout - couldn't match edit_file text |
| 9 | Memory checkpoints | Local 14B | 2 | Created file (had API bugs) |
| 8 | Memory health | Local 14B | 0 | Created file (mostly correct) |
| 7 | Contradiction detection | Vessel 120B | 15 | Created branch, no code written |
| 21 | Headless permissions | Vessel 120B | 15 | Spent all tools exploring, no edits |

**Result:** 0/5 tasks fully completed autonomously. Both models could explore and plan but failed to write correct code.

### Key Failures
- **Local 14B:** Too slow (180s timeout), used non-existent Bun APIs (file.check(), file.glob())
- **Vessel 120B:** Spent entire 15-tool budget reading files, never got to writing
- **Both:** Could not use edit_file successfully (couldn't match exact text strings)

### What the agents DID produce
- Local created `checkpoint.ts` and `health.ts` (structurally correct, wrong APIs)
- Vessel created git branches correctly
- Local pushed `feat/memory-health` branch to remote

### Human intervention
All 5 issues were completed by me after reviewing agent output. Agent work was used as scaffolding.

## Round 2: Model Shootout (5 models, same task)

Tested 5 free OpenRouter models on the exact same task via the Vessel. Task: create a test file, run it, report the result.

Script: `scripts/model-shootout-v2.ts`

| Model | Wrote File | Ran Test | Passed | Tools | Time |
|-------|-----------|----------|--------|-------|------|
| **Step 3.5 Flash** | Y | Y | Y | 2 | **15s** |
| **Nemotron 120B** | Y | Y | Y | 3 | 60s |
| Nemotron Nano 30B | N | N | N | 0 | 5s |
| Mistral Small 24B | N | N | N | 0 | 67s |
| Llama 3.3 70B | N | N | N | 0 | 174s |

**Winner:** Step 3.5 Flash - 4x faster than Nemotron 120B, fewer tool calls, perfect execution.

### Why most models failed
- **Nemotron Nano 30B:** Responded with a plan but never called tools
- **Mistral Small 24B:** Tool use format error
- **Llama 3.3 70B:** Tool use format error, timed out at 174s
- **Qwen3-Coder** (v1 test): Rate limited (too popular on free tier)
- **Gemma 3 27B** (v1 test): No tool use support on OpenRouter
- **GPT-OSS 120B** (v1 test): Blocked by privacy/guardrail settings

## Changes Made After

1. **Default model switched** to `stepfun/step-3.5-flash:free` on the Vessel
2. **Delegation maxTurns** bumped from 15 to 25 (Telegram chat stays at 15)
3. **Headless permissions** expanded - write, git push (not main), gh CLI all auto-approved
4. **bun:sqlite pragma** fixed - db.exec() instead of db.pragma()

## Scripts

- `scripts/dispatch-issues.ts` - Multi-agent issue dispatcher (local + vessel)
- `scripts/model-shootout.ts` - v1 shootout (different tasks per model)
- `scripts/model-shootout-v2.ts` - v2 shootout (same task, fair comparison)
- `scripts/vessel-query.ts` - Query vessel for work reports

## Lessons

1. **Free models can execute simple tasks** (write file + run it) but struggle with multi-step edits
2. **edit_file is the bottleneck** - models can't reliably match exact text for replacement
3. **Tool budget matters** - 15 turns is too few for explore + plan + write + test + commit
4. **Speed varies 10x** between models - Step Flash at 15s vs Llama at 174s
5. **The harness makes the difference** - a well-prompted 30B model beats a poorly-prompted 120B model
6. **Human supervision still needed** - agents produce useful scaffolding, not finished work
