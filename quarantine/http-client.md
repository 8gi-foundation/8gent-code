# http-client

**Tool name:** `http-client`
**Status:** quarantine

## Description

Minimal HTTP client wrapping the native `fetch` API with:

- Automatic retry with exponential backoff (default 3 retries)
- Configurable per-request and global timeout (default 10s, AbortController-based)
- Typed `HttpResponse<T>` return with auto JSON parsing
- Request and response interceptor chains (auth injection, logging, etc.)
- `HttpClientError` with status code and parsed body for non-OK responses
- Query param builder via `params` option
- Singleton `httpClient` export for quick use

## API

```typescript
const client = new HttpClient({ baseUrl: "https://api.example.com", retries: 2 });

const { data } = await client.get<User>("/users/1");
const { data } = await client.post<Created>("/items", { name: "thing" });
const { data } = await client.put<Updated>("/items/1", { name: "updated" });
const { data } = await client.delete("/items/1");
```

## Integration path

1. **Wire into `packages/tools/index.ts`** - export `HttpClient`, `httpClient`, `HttpClientError`
2. **Replace ad-hoc `fetch` calls** in `packages/tools/web.ts` and `packages/tools/browser/` with this client
3. **Add auth interceptor** in `packages/eight/agent.ts` for any authenticated API calls
4. **Optional:** promote to `packages/http/` if it grows beyond ~200 lines

## Files

- `packages/tools/http-client.ts` - implementation (~140 lines)
