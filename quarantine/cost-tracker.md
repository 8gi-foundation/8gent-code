# Quarantine: cost-tracker

## Tool name

`cost-tracker`

## Description

Tracks API token usage per request and estimates costs across model providers. Maintains a running ledger of input/output tokens with a built-in pricing table covering Anthropic, OpenAI, Google, OpenRouter, and Ollama (local) models. Generates per-model and cumulative cost reports. Zero external dependencies.

## File

`packages/tools/cost-tracker.ts` (~130 lines)

## Status

**quarantine** - new file, untested in CI, not wired into tool registry.

## API

```ts
import { CostTracker, globalTracker, PRICING } from './packages/tools/cost-tracker.ts';

const tracker = new CostTracker();

// Track a request
const record = tracker.track({
  model: "claude-3-5-sonnet",
  inputTokens: 1200,
  outputTokens: 400,
  label: "summarise task",
});

// Cumulative cost
console.log(tracker.totalCost()); // number (USD)

// Full report object
const report = tracker.report();
// { totalRequests, totalInputTokens, totalOutputTokens, totalCostUsd, byModel }

// Human-readable report
console.log(tracker.reportText());

// Reset
tracker.reset();

// Or use the global singleton
globalTracker.track({ model: "gpt-4o", inputTokens: 800, outputTokens: 300 });
```

## Pricing table

10 models included. Prices approximate as of early 2026 - verify before billing.

| Model | Provider | Input/1k | Output/1k |
|-------|----------|----------|-----------|
| Claude 3.5 Sonnet | Anthropic | $0.003 | $0.015 |
| Claude 3 Haiku | Anthropic | $0.00025 | $0.00125 |
| Claude Opus 4 | Anthropic | $0.015 | $0.075 |
| GPT-4o | OpenAI | $0.0025 | $0.01 |
| GPT-4o Mini | OpenAI | $0.00015 | $0.0006 |
| OpenAI o1 | OpenAI | $0.015 | $0.06 |
| Gemini 2.0 Flash | Google | $0.0001 | $0.0004 |
| Gemini 2.0 Pro | Google | $0.0035 | $0.014 |
| Llama 3 70B (free) | OpenRouter | $0 | $0 |
| Qwen (local/Ollama) | Ollama | $0 | $0 |

## Integration path

- [ ] Add tests for cost calculation accuracy and model lookup
- [ ] Wire into `packages/tools/index.ts` exports
- [ ] Register as an agent-callable tool in `packages/eight/tools.ts`
- [ ] Hook into the agent loop to auto-track every LLM call
- [ ] Expose cost summary in TUI session footer
- [ ] Keep pricing table in sync with provider updates
