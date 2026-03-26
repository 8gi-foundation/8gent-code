# locale-parser

Parse and normalize BCP 47 locale strings.

## Requirements
- parse('en-US') returns {language, region?, script?, variants[]}
- normalize(locale) returns canonical form
- isValid(locale) checks format
- match(requested[], available[]) finds best match
- Zero dependencies

## Status

Quarantine - pending review.

## Location

`packages/tools/locale-parser.ts`
