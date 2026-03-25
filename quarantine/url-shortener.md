# Quarantine: url-shortener

## What

Simple URL shortener that stores mappings in `~/.8gent/urls.json` with base62-encoded IDs. Includes a Bun.serve redirect server.

## File

`packages/tools/url-shortener.ts` (~80 lines)

## API

```ts
import { shorten, resolve, list, remove, serve } from './packages/tools/url-shortener.ts';

const mapping = shorten('https://8gent.dev');  // { id: '1', url: '...', createdAt: '...', hits: 0 }
const url = resolve('1');                       // 'https://8gent.dev' (increments hits)
const all = list();                             // all stored mappings
remove('1');                                    // true if deleted

// Start redirect server on port 3456
const server = serve(3456);
// GET /1 -> 302 redirect to original URL
// GET /  -> JSON list of all mappings
```

## Storage format

`~/.8gent/urls.json`:
```json
{
  "counter": 2,
  "mappings": {
    "1": { "id": "1", "url": "https://8gent.dev", "createdAt": "2026-03-25T...", "hits": 3 },
    "2": { "id": "2", "url": "https://8gentos.com", "createdAt": "2026-03-25T...", "hits": 0 }
  }
}
```

## Why quarantine

- Useful utility but no immediate consumer in the agent loop
- Needs integration with the tools index and potentially the browser package
- Server component needs policy engine approval before auto-starting

## Promotion criteria

- Agent or TUI feature that needs short URLs (share links, session exports)
- Tests covering shorten/resolve/remove and redirect server
