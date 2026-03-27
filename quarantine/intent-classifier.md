# intent-classifier

Keyword and pattern-based intent classifier for routing user messages to handlers.

## Requirements
- addIntent(classifier, { name, keywords[], patterns[], priority })
- classify(classifier, text): returns best match with score
- classifyAll(classifier, text): returns all matching intents sorted by score
- defaultIntent(classifier, fallback)
- renderClassifier(classifier): table of intents with keywords

## Status

Quarantine - pending review.

## Location

`packages/tools/intent-classifier.ts`
