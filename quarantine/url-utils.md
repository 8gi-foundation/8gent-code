# quarantine/url-utils

**Status:** quarantine - ready for review
**File:** `packages/tools/url-utils.ts`
**Size:** ~260 lines, zero dependencies

---

## What it does

Full URL utility belt. Pure functions, no side effects, no deps beyond the platform `URL` API.

### Exported surface

| Export | Description |
|--------|-------------|
| `parseUrl(raw)` | Parse any URL string into a `ParsedUrl` struct. Returns `null` on failure. |
| `buildUrl(components)` | Construct a URL from parts (protocol, host, path, query, hash, auth). |
| `parseQueryString(qs)` | Parse a query string into a record. Multi-value keys become arrays. |
| `buildQueryString(params)` | Serialise a record to a query string. Arrays expand to repeated keys. |
| `mergeQueryParams(url, params)` | Add/overwrite/remove params on an existing URL. `undefined` removes a key. |
| `joinPaths(...segments)` | Join path segments, collapse slashes, resolve `.` and `..`. Works with full URLs. |
| `isValidUrl(url)` | True if the string is a valid absolute URL. |
| `isHttpUrl(url)` | True if protocol is `http` or `https`. |
| `isSecureUrl(url)` | True if protocol is `https`. |
| `extractDomain(urlOrHostname)` | Returns `{ subdomain, domain, tld, registrable }`. Handles two-part TLDs (co.uk, com.au, etc.). |
| `extractTld(urlOrHostname)` | Returns just the TLD string. |
| `extractRegistrableDomain(urlOrHostname)` | Returns `domain.tld` without subdomain. |
| `isLocalUrl(url)` | True for localhost, 127.x, RFC-1918, link-local, and `.local` TLD. |
| `addTrailingSlash(url)` | Ensures pathname ends with `/`. |
| `removeTrailingSlash(url)` | Strips trailing `/` from pathname (never removes root `/`). |
| `stripQueryAndHash(url)` | Returns origin + pathname only. |
| `stripHash(url)` | Returns URL without hash fragment. |

### Types

- `ParsedUrl` - structured result of `parseUrl`
- `UrlComponents` - input shape for `buildUrl`
- `DomainInfo` - result of `extractDomain`

---

## Usage examples

```ts
import { parseUrl, buildUrl, mergeQueryParams, isLocalUrl } from "./packages/tools/url-utils";

// Parse
const p = parseUrl("https://api.8gent.dev/v1/chat?model=qwen&stream=true");
// { protocol: "https", hostname: "api.8gent.dev", pathname: "/v1/chat", ... }

// Build
const url = buildUrl({ hostname: "api.8gent.dev", pathname: "/v1/chat", query: { model: "qwen" } });
// "https://api.8gent.dev/v1/chat?model=qwen"

// Merge params
mergeQueryParams("https://example.com/search?q=hello", { page: "2", q: undefined });
// "https://example.com/search?page=2"

// Local check
isLocalUrl("http://192.168.1.100:3000"); // true
isLocalUrl("https://api.8gent.dev");     // false
```

---

## Review checklist

- [ ] Two-part TLD list is non-exhaustive - extend `twoPartTlds` set if needed
- [ ] `buildUrl` uses native `URL` constructor for final validation - throws on bad input
- [ ] `isLocalUrl` IPv6 patterns cover ULA and link-local but not all edge cases
- [ ] No dependency on Node `url` module - works in Bun, browser, Deno
