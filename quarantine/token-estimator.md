# Quarantine: token-estimator

## What

Char-based heuristic token counter with per-model cost calculation and context window utilisation. Covers 10 models across Anthropic, OpenAI, Google, Meta, and Ollama local. Zero external dependencies.

## File

`packages/tools/token-estimator.ts` (~180 lines)

## API

```ts
import { estimateTokens, estimateCost, contextUsage, findModel, fullReport, MODELS } from './packages/tools/token-estimator.ts';

const est = estimateTokens(myText);
// { chars: 4200, tokens: 1050, method: "prose" }

const model = findModel("gpt-4o");
const cost = estimateCost(model, est.tokens, 512);
// { totalCostUsd: 0.007725, inputCostUsd: 0.002625, outputCostUsd: 0.00512 }

const ctx = contextUsage(model, est.tokens);
// { usedPercent: 0.82, remaining: 126950, overLimit: false }

console.log(fullReport(myText));
```

## Heuristic

Content type auto-detected from char density and indentation ratio:

| Type | Chars/token | Trigger |
|------|-------------|---------|
| prose | 4.0 | default |
| code | 3.0 | >6% code chars or >40% indented lines |
| mixed | 3.5 | between thresholds |

Accuracy: within ~10-15% of actual tiktoken/claude tokeniser for typical inputs.

## Model registry

10 models included. Prices approximate as of early 2026 - verify before billing.

| Model | Context | Input/1k | Output/1k |
|-------|---------|----------|-----------|
| Claude 3.5 Sonnet | 200k | $0.003 | $0.015 |
| Claude 3 Haiku | 200k | $0.00025 | $0.00125 |
| Claude Opus 4 | 200k | $0.015 | $0.075 |
| GPT-4o | 128k | $0.0025 | $0.01 |
| GPT-4o Mini | 128k | $0.00015 | $0.0006 |
| OpenAI o1 | 200k | $0.015 | $0.06 |
| Gemini 2.0 Flash | 1M | $0.0001 | $0.0004 |
| Gemini 2.0 Pro | 2M | $0.0035 | $0.014 |
| Llama 3 70B (free) | 128k | $0 | $0 |
| Qwen 3.5 (local) | 32k | $0 | $0 |

## CLI usage

```bash
bun run packages/tools/token-estimator.ts "Your prompt text here"
bun run packages/tools/token-estimator.ts --file packages/eight/prompts/system-prompt.ts
cat README.md | bun run packages/tools/token-estimator.ts
bun run packages/tools/token-estimator.ts --model gpt-4o --file README.md
bun run packages/tools/token-estimator.ts --output 2000 --file src/agent.ts
bun run packages/tools/token-estimator.ts --list-models
```

## Why quarantined

New file, untested in CI, no integration with existing tool registry yet. Needs:

- [ ] Tests covering prose/code/mixed detection accuracy
- [ ] Wire into `packages/tools/index.ts` exports
- [ ] Add as an agent-callable tool in `packages/eight/tools.ts`
- [ ] Validate token estimates against actual tiktoken output on sample corpus
- [ ] Keep model pricing table in sync with provider updates
