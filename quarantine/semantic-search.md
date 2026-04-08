# Quarantine: semantic-search

## What

Semantic search over codebase files using Ollama embeddings (nomic-embed-text). Indexes file contents into vectors, then finds semantically similar files to a natural language query via cosine similarity.

## File

`packages/tools/semantic-search.ts` (~120 lines)

## API

```ts
import { buildIndex, search, formatResults } from './packages/tools/semantic-search.ts';

// Build index from project root (embeds all .ts/.tsx/.js/.jsx/.md/.json files)
const index = await buildIndex('/path/to/project');

// Search with natural language
const results = await search('authentication middleware', index, { topK: 5 });
console.log(formatResults(results));
```

## How it works

1. **Indexing** - Walks the directory tree, reads the first 2048 chars of each file, sends to Ollama `/api/embed` endpoint with `nomic-embed-text`
2. **Search** - Embeds the query string, computes cosine similarity against all indexed file vectors, returns top-k results
3. **Filtering** - Skips node_modules, .git, dist, build, hidden dirs, and files over 100KB

## Dependencies

- Ollama running locally with `nomic-embed-text` pulled (`ollama pull nomic-embed-text`)
- No npm dependencies beyond Node built-ins (`fs/promises`, `path`)

## Config

| Option | Default | Description |
|--------|---------|-------------|
| `extensions` | `.ts .tsx .js .jsx .md .json` | File extensions to index |
| `model` | `nomic-embed-text` | Ollama embedding model |
| `topK` | `10` | Number of results to return |

## Limitations

- Index lives in memory (no persistence yet) - rebuilds each session
- First 2048 chars only per file - large files may lose tail context
- Requires Ollama running locally with the embedding model pulled
- Sequential embedding calls - could be batched for speed on large codebases

## Promotion criteria

- [ ] Persistence layer (save/load index to disk, skip re-embedding unchanged files)
- [ ] Integration with Eight's tool registry
- [ ] Benchmark: index time and search accuracy on this repo
- [ ] Batch embedding calls for indexing speed
