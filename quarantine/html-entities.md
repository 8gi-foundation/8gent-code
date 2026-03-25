# html-entities

HTML entity encoding and decoding.

## Requirements
- encode(str: string) -> string escapes <>&'"
- decode(str: string) -> string unescapes named and numeric entities
- encodeAll(str) -> string encodes all non-ASCII as numeric entities
- stripTags(html) -> string removes all HTML tags
- Support &amp; &lt; &gt; &apos; &quot; and numeric &#xxx;

## Status

Quarantine - pending review.

## Location

`packages/tools/html-entities.ts`
