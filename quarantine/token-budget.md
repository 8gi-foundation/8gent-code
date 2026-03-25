# Quarantine: token-budget

## What

Token budget calculator that estimates counts and allocates budgets across
context layers: system prompt, user context, memory injection, tool definitions,
conversation history, and response reservation. Tracks live usage per segment,
surfaces overflow warnings, and normalises fractional allocations to the active
model's context window.

## File

`packages/tools/token-budget.ts` (~150 lines)

## Status

**quarantine** - new file, untested in CI, not wired into the tool registry.

## API

```ts
import {
  TokenBudget,
  estimateTokens,
  estimateMessagesTokens,
} from './packages/tools/token-budget.ts';

// Create a budget for a specific model (defaults to 32k if unknown).
const budget = new TokenBudget('claude-3-5-sonnet');

// Track usage from raw text.
budget.trackText('systemPrompt', systemPromptString);
budget.trackText('memoryInjection', injectedMemory);
budget.trackText('conversationHistory', historyString);

// Or track by explicit token count.
budget.track('responseReservation', 2048);

// Check the allocation limit for a segment.
const histLimit = budget.limitFor('conversationHistory'); // e.g. 90_000

// Get a full snapshot.
const snap = budget.snapshot();
// {
//   modelLimit: 200000,
//   totalUsed: 34200,
//   totalRemaining: 165800,
//   overBudget: false,
//   segments: {
//     systemPrompt: { allocated: 20000, used: 3100, remaining: 16900, percentUsed: 15 },
//     ...
//   }
// }

// Which segments are over their allocation?
const overflows = budget.overflowingSegments();

// Quick guard.
if (!budget.isWithinLimit()) {
  console.warn('Total token usage exceeds model context window');
}

// Standalone token estimation.
const count = estimateTokens('Hello, world!'); // 4
const msgCount = estimateMessagesTokens(messages);  // array of {role, content}
```

## Default Segment Fractions

Fractions are normalised at construction so they always sum to 1.

| Segment | Default fraction | Notes |
|---------|-----------------|-------|
| systemPrompt | 10% | Agent identity + instructions |
| userContext | 5% | Onboarding + preferences |
| memoryInjection | 15% | Episodic + semantic recall |
| toolDefinitions | 10% | Tool schemas injected each turn |
| conversationHistory | 45% | Rolling message window |
| responseReservation | 15% | Reserved for model output |

Override any fraction via the second constructor argument:

```ts
const budget = new TokenBudget('gpt-4o', { responseReservation: 0.20 });
```

## Integration Path

- [ ] Wire `TokenBudget` into `packages/eight/agent.ts` - instantiate per session, pass model name from provider
- [ ] Inject snapshot into system prompt builder (`packages/eight/prompts/system-prompt.ts`) so the agent can self-report remaining budget
- [ ] Trim `conversationHistory` when `overflowingSegments()` includes it
- [ ] Export from `packages/tools/index.ts`
- [ ] Add unit tests: allocation normalisation, overflow detection, `estimateTokens` accuracy
- [ ] Validate estimates against tiktoken on a sample prompt corpus

## Why Quarantined

No tests, no CI coverage, no integration with the agent loop. The segmentation
model is opinionated - needs sign-off before it gates real context trimming.
