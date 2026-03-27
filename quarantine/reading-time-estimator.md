# reading-time-estimator

Estimates reading time for text content accounting for word count, code blocks, and images.

## Requirements
- estimate(text, options?): returns { minutes, seconds, words }
- wpm: 238 average for technical content (configurable)
- codeBlockTime(content): adds extra time per code block
- imageTime(content, count): adds 12 seconds per image
- format(estimate): 5 min read style string

## Status

Quarantine - pending review.

## Location

`packages/tools/reading-time-estimator.ts`
