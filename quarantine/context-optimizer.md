# Quarantine: context-optimizer

## What

Token budget tracker and truncation engine for the 8gent context window. Tracks
token consumption across system prompt, injected memory context, and conversation
history. Applies configurable truncation strategies to keep total usage within
the model's context window while preserving the most valuable content.

Zero external dependencies. Pure TypeScript. No AI judge needed for token math.

## File

`packages/eight/context-optimizer.ts` (~220 lines)

## API

```ts
import { ContextOptimizer } from './packages/eight/context-optimizer';

const optimizer = new ContextOptimizer({
  contextWindow: 128_000,     // model's max context (default: 128k)
  outputReserve: 4_096,       // tokens held back for completion (default: 4k)
  systemPromptFraction: 0.20, // 20% of input budget for system prompt
  memoriesFraction: 0.10,     // 10% for injected memories
  // historyFraction: remaining 70% auto-computed
  historyStrategy: "oldest-first", // | "summarize-middle" | "sliding-window"
});

// Optimize before sending to LLM
const result = optimizer.optimize({
  systemPrompt: renderedSystemPrompt,
  memories: memoryContextBlock, // from buildMemoryContext()
  history: conversationMessages,
});

// result.history      - trimmed message array
// result.memories     - possibly truncated memory block
// result.systemPrompt - possibly truncated system prompt
// result.budget       - allocation breakdown
// result.usage        - actual token counts after truncation
// result.truncated    - boolean flag
// result.log          - human-readable truncation decisions

// Inspect without modifying (debugging)
console.log(optimizer.inspect({ systemPrompt, memories, history }));
```

## Budget Allocation

Default fractions (configurable):

| Segment | Default fraction | Tokens (128k window, 4k reserve) |
|---------|-----------------|----------------------------------|
| Output reserve | - | 4,096 |
| System prompt | 20% | ~24,780 |
| Memories | 10% | ~12,390 |
| History | 70% | ~86,734 |

## Truncation Strategies

| Strategy | Behavior | Best for |
|----------|----------|----------|
| `oldest-first` | Drop oldest messages until budget met | General use |
| `sliding-window` | Keep only the most recent N tokens | Recency-only sessions |
| `summarize-middle` | Keep head + tail, drop middle with placeholder | Context at both ends |

System prompt and memories truncate from the tail with a `[...truncated]` marker.

## Token Estimation

Char-based heuristic matching `packages/memory/types.ts`:

| Type | Chars/token | Detection |
|------|-------------|-----------|
| Prose | 4.0 | default |
| Mixed | 3.5 | >3% code chars or >20% indented lines |
| Code | 3.0 | >6% code chars or >40% indented lines |

Accuracy: within ~10-15% of actual tokenizer output for typical inputs.

## Integration Points

- `packages/eight/agent.ts` - call `optimizer.optimize()` before each `createEightAgent()` call
- `packages/memory/auto-inject.ts` - pass `optimizer.computeBudget().memoriesBudget` as `maxTokens` to `buildMemoryContext()`
- `packages/ai/` - wrap the message array before it reaches the AI SDK

Minimal integration sketch:

```ts
const optimizer = new ContextOptimizer({ contextWindow: modelContextWindow });
const { history, memories, systemPrompt } = optimizer.optimize({
  systemPrompt: currentSystemPrompt,
  memories: await buildMemoryContext(userId, recentMessages, store, rep, {
    maxTokens: optimizer.computeBudget().memoriesBudget,
  }),
  history: conversationHistory,
});
```

## Why quarantined

New file, untested in CI, not wired into the agent loop. Needs:

- [ ] Unit tests: each truncation strategy, boundary conditions (empty history, zero budget, single message over budget)
- [ ] Integration test with real system prompt from `prompt.ts`
- [ ] Wire into `packages/eight/agent.ts` - replace ad-hoc history management
- [ ] Wire into `packages/memory/auto-inject.ts` - pass `budget.memoriesBudget` as `maxTokens`
- [ ] Validate token estimates against actual model tokenizer on a sample corpus
- [ ] Export from `packages/eight/index.ts`
- [ ] Benchmark utilization % before/after on production sessions
