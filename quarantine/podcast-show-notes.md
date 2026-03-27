# podcast-show-notes

Generates structured podcast show notes from episode outline: summary, timestamps, links, quotes.

## Requirements
- buildShowNotes({ title, guest?, duration, topics[] })
- addTimestamp(notes, { time, topic })
- addQuote(notes, { text, speaker, timecode })
- renderMarkdown(notes): full show notes document
- renderSEO(notes): SEO-optimized description under 300 words

## Status

Quarantine - pending review.

## Location

`packages/tools/podcast-show-notes.ts`
