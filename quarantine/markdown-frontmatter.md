# markdown-frontmatter

**Status:** quarantine

## Description

Parses and generates YAML frontmatter from markdown files. Extracts the `---` delimited block at the start of a document, parses it into a plain JS object, and strips it from the body content. Also serializes an object back to a frontmatter-prefixed markdown string.

## Exports

- `parseFrontmatter(md: string): FrontmatterResult` - parse frontmatter from raw markdown
- `generateFrontmatter(data: Record<string, unknown>, content: string): string` - generate frontmatter-prefixed markdown

## File

`packages/tools/markdown-frontmatter.ts`

## Integration Path

Wire into the agent's document processing pipeline or memory layer where markdown notes, knowledge-base entries, or session documents carry metadata (title, tags, date, author). Candidate consumers:

- `packages/memory/store.ts` - tag and date-stamp episodic memories stored as markdown
- `packages/eight/tools.ts` - expose as a `read_frontmatter` / `write_frontmatter` tool action
- `packages/self-autonomy/reflection.ts` - reflection outputs could carry structured metadata for filtering

## Limitations (quarantine scope)

- No nested YAML object support (flat key-value only)
- No multi-line scalar blocks (`|`, `>`)
- Sufficient for typical agent document metadata use cases
