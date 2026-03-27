# blog-scaffolder

Scaffolds a complete blog post with title, meta description, slug, outline, and section stubs.

## Requirements
- scaffold({ topic, keywords[], audience, wordCount }): returns BlogPost structure
- generateOutline(topic, sections?): H2/H3 section outline with subtopics
- metaDescription(title, keywords[]): 150-char SEO meta description
- readingTime(wordCount): estimated minutes to read
- renderMarkdown(post): full blog post template in markdown

## Status

Quarantine - pending review.

## Location

`packages/tools/blog-scaffolder.ts`
