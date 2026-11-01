# Terminal-Bench Integration

8gent Code benchmarked via [Harbor Framework](https://harborframework.com) using [Terminal-Bench 2.0](https://tbench.ai).

## Setup

```bash
# Install Harbor (one-time)
uv tool install harbor

# Verify
harbor --version
harbor datasets list
```

## Running Benchmarks

### Oracle (sanity check)
```bash
harbor run -d terminal-bench-sample@2.0 -a oracle -o benchmarks/harbor-results
```

### Claude Code (cloud - needs ANTHROPIC_API_KEY)
```bash
export ANTHROPIC_API_KEY="..."
harbor run -d terminal-bench@2.0 -a claude-code -m anthropic/claude-sonnet-4-6 -o benchmarks/harbor-results
```

### Full benchmark (89 tasks)
```bash
harbor run -d terminal-bench@2.0 -a claude-code -m anthropic/claude-haiku-4-5 -o benchmarks/harbor-results -n 4
```

### Pro benchmark (200 tasks)
```bash
harbor run -d terminal-bench-pro@1.0 -a claude-code -m anthropic/claude-sonnet-4-6 -o benchmarks/harbor-results
```

## Available Agents

| Agent | Description |
|-------|-------------|
| oracle | Perfect solutions (sanity check) |
| claude-code | Claude Code CLI |
| aider | Aider coding assistant |
| codex | OpenAI Codex CLI |
| cursor-cli | Cursor CLI |
| qwen-coder | Qwen Coder |
| opencode | OpenCode |
| swe-agent | SWE-agent |

## Available Datasets

| Dataset | Tasks | Description |
|---------|-------|-------------|
| terminal-bench-sample@2.0 | 10 | Quick sample |
| terminal-bench@2.0 | 89 | Full benchmark |
| terminal-bench-pro@1.0 | 200 | Extended benchmark |
| aider-polyglot@1.0 | 225 | Multi-language coding |
| ade-bench@1.0 | 48 | Data engineering |

## Results

Results stored in `benchmarks/harbor-results/`. View with:
```bash
harbor view benchmarks/harbor-results
```

## Leaderboard

Submit results to [tbench.ai/leaderboard](https://tbench.ai/leaderboard).

## Future: 8gent as Custom Agent

To benchmark 8gent's own agent (not Claude Code), we need a custom Harbor adapter.
```bash
harbor adapters init  # Interactive wizard to create adapter template
```

The adapter would wrap `bun run packages/eight/index.ts` as the agent process.
