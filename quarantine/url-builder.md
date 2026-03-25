# Quarantine: url-builder

**Package:** `packages/tools/url-builder.ts`
**Status:** Quarantine - review before wiring into agent tools

## What It Does

Fluent URL construction with chainable methods for path segments, query params, hash fragments, HTTP Basic Auth, and port overrides. Handles percent-encoding throughout.

## Exported API

| Export | Signature | Notes |
|--------|-----------|-------|
| `UrlBuilder` | `class UrlBuilder` | Full builder class |
| `url` | `(base: string) => UrlBuilder` | Factory shorthand |

### Methods (all chainable)

| Method | Signature | Description |
|--------|-----------|-------------|
| `path` | `(segment: string) => this` | Append a path segment. Strips leading/trailing slashes. |
| `query` | `(key: string, value: string|number|boolean) => this` | Add a query param. Supports multi-value keys. |
| `hash` | `(fragment: string) => this` | Set the URL fragment. Do not include `#`. |
| `auth` | `(user: string, pass: string) => this` | Inject HTTP Basic Auth credentials. |
| `port` | `(n: number|null) => this` | Override the port number. |
| `build` | `() => string` | Return the final URL string. |
| `clone` | `() => UrlBuilder` | Branch without mutating the original. |
| `toString` | `() => string` | Alias for `build()`. |

## Design Decisions

- All query keys and values are `encodeURIComponent`-encoded. Multi-value keys repeat the key rather than using bracket notation.
- Auth credentials are injected into the URL authority (`user:pass@host`) and are also percent-encoded.
- Port injection strips any existing port from the base URL before inserting the new one.
- `clone()` enables forking a base config for multiple endpoint variants without mutation.
- No dependency on the `URL` Web API - keeps it compatible with any runtime including Bun, Node, and edge workers where `URL` construction from relative strings may differ.

## Use Cases

```ts
import { url, UrlBuilder } from "./packages/tools/url-builder";

// Basic path + query
url("https://api.example.com")
  .path("v1").path("users")
  .query("page", 2)
  .query("limit", 50)
  .build();
// => "https://api.example.com/v1/users?page=2&limit=50"

// Multi-value query param
url("https://search.example.com")
  .path("search")
  .query("tag", "ai")
  .query("tag", "oss")
  .build();
// => "https://search.example.com/search?tag=ai&tag=oss"

// Auth + port
url("https://internal.example.com")
  .auth("admin", "s3cr3t")
  .port(8443)
  .path("api/health")
  .build();
// => "https://admin:s3cr3t@internal.example.com:8443/api/health"

// Hash fragment
url("https://docs.example.com")
  .path("guide")
  .hash("installation")
  .build();
// => "https://docs.example.com/guide#installation"

// Clone for base config variants
const base = url("https://api.example.com").path("v2");
const users = base.clone().path("users").query("active", true).build();
const orgs  = base.clone().path("orgs").build();
```

## Quarantine Checklist

- [ ] Unit tests written and passing
- [ ] Integrated into agent tool registry (`packages/eight/tools.ts`)
- [ ] Edge cases reviewed: empty segments, special characters in auth, existing port in base, fragment with `#` prefix
- [ ] Verified behavior matches `new URL()` Web API for standard cases
