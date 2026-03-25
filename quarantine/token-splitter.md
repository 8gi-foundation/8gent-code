# token-splitter

**Status:** quarantine

## Description

Splits text into chunks that fit within a given token limit. Respects sentence, paragraph, or word boundaries to avoid cutting mid-sentence. Supports configurable overlap between consecutive chunks so context is preserved across chunk boundaries.

## API

```ts
splitByTokens(text: string, maxTokens: number, options?: SplitOptions): TextChunk[]
```

### SplitOptions

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `overlap` | number | 50 | Overlap in tokens between consecutive chunks |
| `boundary` | `"paragraph" \| "sentence" \| "word"` | `"sentence"` | Where to break the text |
| `source` | string | - | Optional label attached to each chunk's metadata |

### TextChunk

Each returned chunk includes:
- `text` - the chunk content
- `tokens` - estimated token count (~4 chars per token)
- `index` - zero-based chunk index
- `startChar` / `endChar` - character offsets in the original text
- `source` - optional source label

## Integration Path

1. **RAG pipeline** - use before embedding documents into the memory store (`packages/memory/store.ts`). Replace any naive character-split logic with `splitByTokens`.
2. **Context window management** - use in `packages/eight/agent.ts` when injecting large documents into the system prompt to stay within model limits.
3. **Promotion criteria** - add a unit test suite, wire into at least one consumer (memory store or agent), then promote to a first-class tool.

## File

`packages/tools/token-splitter.ts`
