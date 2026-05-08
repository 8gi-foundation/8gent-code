# context-window-optimizer

Fits maximum relevant content into a token budget using priority-based selection.

## Requirements
- fit(items[], tokenBudget, tokenizerFn?): returns selected items within budget
- prioritize(items[], scoreFn): sorts by relevance score
- trim(text, maxTokens, tokenizerFn?): truncates text to token limit preserving sentence boundaries
- summarizeOverflow(items[], budget): reports what was excluded and why

## Status

Quarantine - pending review.

## Location

`packages/tools/context-window-optimizer.ts`
