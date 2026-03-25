# Quarantine: token-counter

**Status:** Quarantine - pending integration review
**File:** `packages/tools/token-counter.ts`
**Size:** ~130 lines, zero external deps

---

## What it does

Estimates token counts for text and chat message arrays using three methods:

| Method | Algorithm | Best for |
|--------|-----------|----------|
| `chars4` | `chars / 4` | Fast estimate, English prose |
| `words` | `words * 1.3` | Word-heavy content, code |
| `tiktoken-approx` | Regex subword split | Closest to cl100k_base without the npm dep |

Default method is `tiktoken-approx`.

---

## API

```ts
import { countTokens, countMessages, fitsContext } from "./packages/tools/token-counter";

// Single string
countTokens("Hello world", "chars4");          // -> 3
countTokens("Hello world", "words");           // -> 3
countTokens("Hello world", "tiktoken-approx"); // -> 3

// Chat messages (includes per-message overhead)
countMessages([
  { role: "system", content: "You are a helpful assistant." },
  { role: "user",   content: "What is 2+2?" },
]);

// Context window check
fitsContext(longText, 8192); // -> true | false
```

---

## Why quarantine

- No tests yet - needs a test file in `packages/tools/__tests__/`
- `tiktoken-approx` has not been benchmarked against actual tiktoken output
- `countMessages` overhead constants (4 per message, 3 priming) match GPT-3.5/4 format; may differ for other model families
- Consider whether this should live in `packages/memory/` (context window checks) or stay in `packages/tools/`

---

## Integration candidates

- `packages/eight/agent.ts` - guard context before sending to model
- `packages/memory/store.ts` - token-aware memory trimming
- `packages/orchestration/` - delegate when context exceeds threshold

---

## Promotion checklist

- [ ] Add unit tests covering all three methods
- [ ] Benchmark `tiktoken-approx` vs actual tiktoken on sample corpus
- [ ] Decide final package home (`tools` vs `memory`)
- [ ] Wire into agent context-guard logic
