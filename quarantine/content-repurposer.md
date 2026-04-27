# content-repurposer

Repurposes long-form content into multiple formats: tweets, LinkedIn posts, bullets, email blurb.

## Requirements
- toTweets(text, n?): splits content into tweet-length chunks with continuity
- toLinkedIn(text): reformats as LinkedIn post with hook and CTA
- toBullets(text, n?): extracts key points as bullet list
- toEmailBlurb(text, words?): condenses to email-appropriate length
- renderAll(text): all formats in a single output document

## Status

Quarantine - pending review.

## Location

`packages/tools/content-repurposer.ts`
