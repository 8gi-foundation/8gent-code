# press-release-builder

Structured press release generator following AP style with headline, dateline, body, boilerplate.

## Requirements
- buildRelease({ headline, subheadline, dateline, body[], quote, boilerplate, contact })
- renderText(release): AP-style formatted press release
- wordCount(release): total word count
- validateStructure(release): checks required fields (headline, dateline, boilerplate)
- renderHTML(release): basic HTML version with semantic markup

## Status

Quarantine - pending review.

## Location

`packages/tools/press-release-builder.ts`
