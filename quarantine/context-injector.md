# context-injector

Injects relevant context segments into prompts based on relevance scores and token budget.

## Requirements
- addSegment(injector, { key, content, priority, tags[] })
- build(injector, query, budget, scoreFn): returns context string within budget
- refresh(injector, key, newContent): updates a segment
- renderSegments(injector): table of segments with priority and token count

## Status

Quarantine - pending review.

## Location

`packages/tools/context-injector.ts`
