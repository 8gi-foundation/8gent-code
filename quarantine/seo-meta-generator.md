# seo-meta-generator

Generates SEO-optimized meta tags: title, description, canonical, OG, Twitter Card.

## Requirements
- generate({ title, description, url, image?, type? }): returns meta tag set
- titleTag(title, siteName?): 60-char optimized title
- metaDescription(description): 155-char meta description with keyword density check
- renderHTML(meta): HTML meta tag strings
- validate(meta): checks lengths and required fields

## Status

Quarantine - pending review.

## Location

`packages/tools/seo-meta-generator.ts`
