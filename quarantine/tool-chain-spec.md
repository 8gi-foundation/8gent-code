# Tool Chain Benchmark - Test Design

**Benchmark ID:** AB005
**Ability:** tool-use
**Difficulty:** hard
**Time limit:** 120s

## Problem

Eight has 30+ tools available. We need to verify the agent can:
1. Chain tools in sequence where each step depends on the last.
2. Pick the right tool for each sub-task instead of defaulting to run_command.
3. Recover gracefully when a tool call fails (missing file, bad path, etc.).

## Test Structure

### Phase 1 - Write then Read (tool chaining)
- Agent writes a JSON file via `write_file`.
- Immediately reads it back via `read_file`.
- Verifies round-trip correctness.
- **Tests:** sequential tool dependency, data integrity.

### Phase 2 - Shell then Write then Read (cross-tool pipeline)
- Uses `run_command` to count .ts files in packages/eight/.
- Writes the count to a text file via `write_file`.
- Reads it back for verification.
- **Tests:** mixing bash tools with file tools, extracting structured data from shell output.

### Phase 3 - Deliberate failure and recovery
- Attempts to read a file that does not exist.
- Must not halt or apologize without acting.
- Creates the missing file and retries.
- **Tests:** error handling, continuation after failure, self-correction.

### Phase 4 - Tool selection reasoning (no execution)
- Given 5 task descriptions, agent must name the correct tool and justify.
- Expected answers:
  - T1: `list_files` - purpose-built for directory listing with glob support.
  - T2: `git_status` - directly queries working tree state.
  - T3: `run_command` - only tool that runs arbitrary shell pipelines.
  - T4: `get_symbol` or `get_outline` - AST-level extraction without reading full files.
  - T5: `remember` - stores facts in the memory layer for cross-session recall.
- **Tests:** tool awareness, avoidance of run_command when a specific tool exists.

## Scoring

| Metric | Weight | What it measures |
|--------|--------|-----------------|
| tools_chained_correctly | 0.30 | Phases 1-2 complete with verified output |
| correct_tool_selection | 0.25 | Phase 4 answers match expected tools |
| failure_recovery_demonstrated | 0.25 | Phase 3 recovers without halting |
| reasoning_quality | 0.20 | Justifications show understanding of tool purposes |

## Judging

Per project rules: use Vercel AI SDK as judge, never string matching. The judge prompt should evaluate each phase independently and produce a 0-1 score per metric.

## Tools Exercised

`write_file`, `read_file`, `run_command`, `list_files`, `git_status`, `get_symbol`, `get_outline`, `remember` - 8 of Eight's core tools tested directly or by reasoning.
