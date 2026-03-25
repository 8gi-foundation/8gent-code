# quarantine/output-sanitizer

## Tool name

`output-sanitizer`

## Description

Sanitizes agent output before display or logging by detecting and redacting sensitive data patterns. Covers API keys, bearer tokens, JWTs, PEM private keys, email addresses, IPv4 addresses, home-directory file paths, and passwords embedded in URLs.

Returns a `SanitizerResult` with the cleaned text, a redaction count, and which rule types fired - useful for observability without exposing what was redacted.

## Status

**quarantine** - implemented, not yet wired into any pipeline.

## Location

`packages/tools/output-sanitizer.ts` (~130 lines)

## API

```ts
import { sanitize, sanitizeText } from "./packages/tools/output-sanitizer";

// Full result with metadata
const result = sanitize(rawOutput);
// result.text  - cleaned string
// result.count - number of redactions applied
// result.types - which rule categories fired, e.g. ["apiKey", "email"]

// Simple string-only convenience wrapper
const clean = sanitizeText(rawOutput);

// Disable specific rules
const partial = sanitize(rawOutput, { disable: ["ipAddress", "homePath"] });

// Custom placeholder
const starred = sanitize(rawOutput, { placeholder: "***" });
```

### Rules

| Rule | What it catches |
|------|----------------|
| `awsKey` | AWS access key IDs (`AKIA...`) |
| `apiKey` | Generic keys prefixed with `sk-`, `pk-`, `rk-`, `api-`, `token-`, `key-` |
| `bearerToken` | `Authorization: Bearer <token>` patterns |
| `jwtToken` | Three-segment base64url JWT tokens |
| `privateKey` | PEM-encoded private key blocks |
| `urlPassword` | Passwords in `https://user:password@host` URLs |
| `email` | Standard email addresses |
| `ipAddress` | IPv4 addresses (non-loopback) |
| `homePath` | Paths starting with `~/`, `/Users/<name>/`, `/home/<name>/` |

## Design decisions

- Returns metadata (`count`, `types`) alongside cleaned text so callers can log redaction events without logging what was redacted.
- All rules are opt-out via `disable` array - safe defaults, explicit overrides.
- Private key replacement preserves the PEM header/footer so structure is visible but content is gone.
- URL password replacement keeps user and host intact - only credential is redacted.
- Zero dependencies.

## Integration path

1. **Agent output pipeline** - wrap `packages/eight/agent.ts` response stream through `sanitizeText()` before writing to chat history or logs.
2. **Memory store** - run sanitizer in `packages/memory/store.ts` before persisting any episodic memory entry.
3. **Debugger export** - apply in `apps/debugger/` before any log export to file or remote.
4. **Daemon logging** - apply in `packages/daemon/` before any structured log emission.

## Graduation criteria

- Unit tests covering each of the 9 rule types, including false-positive checks (loopback IPs, relative paths).
- Wire into `packages/eight/agent.ts` response handler as a configurable middleware step.
- Confirm no performance regression on streaming output (sanitize per-chunk, not per-session).
- Add `sanitizer.enabled` flag to `.8gent/config.json` schema.
