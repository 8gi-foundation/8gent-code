# context-window

Manage LLM context window with token budget.

## Requirements
- ContextWindow with maxTokens budget
- add(message) inserts if budget allows, evicts oldest if not
- getMessages() returns current window
- tokenCount() returns total estimated tokens
- Simple whitespace tokenizer (1 token per ~4 chars)

## Status

Quarantine - pending review.

## Location

`packages/tools/context-window.ts`
