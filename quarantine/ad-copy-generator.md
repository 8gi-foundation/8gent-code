# ad-copy-generator

Ad copy generator for Google Ads, Meta Ads, and LinkedIn with character limit compliance.

## Requirements
- googleAd({ headline, description, url }): 3 headlines (30 chars) + 2 descriptions (90 chars)
- metaAd({ primary, headline, description, cta }): Meta ad copy fields
- linkedInAd({ intro, headline, description }): LinkedIn sponsored content format
- checkLimits(copy): validates all character limits
- renderPreview(copy, platform): formatted ad preview

## Status

Quarantine - pending review.

## Location

`packages/tools/ad-copy-generator.ts`
