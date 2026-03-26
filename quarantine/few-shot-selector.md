# few-shot-selector

Selects the best few-shot examples for a prompt based on semantic similarity to current input.

## Requirements
- addExample(pool, { input, output, tags[] })
- select(pool, query, k, scoreFn): returns k most relevant examples
- formatExamples(examples[], format?): formats as chat messages or Q/A blocks
- balanced(pool, query, k, tagKey): ensures category balance in selection

## Status

Quarantine - pending review.

## Location

`packages/tools/few-shot-selector.ts`
