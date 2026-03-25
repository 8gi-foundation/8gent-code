# content-type

Parse and format HTTP Content-Type headers.

## Requirements
- parse(header: string) -> { type: string, params: Record<string, string> }
- format(type: string, params?) -> string
- charset(header: string) -> string | undefined
- isJSON(header), isHTML(header), isText(header)
- Normalize media type casing

## Status

Quarantine - pending review.

## Location

`packages/tools/content-type.ts`
