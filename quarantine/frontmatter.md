# frontmatter

Parse YAML/TOML frontmatter from Markdown and other text files.

## Requirements
- parse(content: string) -> { data: Record<string, unknown>, body: string }
- stringify(data, body) -> string
- Support --- (YAML) and +++ (TOML) delimiters
- detect(content) -> 'yaml' | 'toml' | null
- Zero dependencies - parse YAML subset inline

## Status

Quarantine - pending review.

## Location

`packages/tools/frontmatter.ts`
