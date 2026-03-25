# Quarantine: token-generator

**File:** `packages/tools/token-generator.ts`
**Status:** Quarantine - awaiting integration review
**Branch:** `quarantine/token-generator`

## What it does

Provides crypto-safe token generation for auth and session workflows. All entropy
comes from `crypto.getRandomValues` - no `Math.random`.

## Exports

| Function | Signature | Purpose |
|----------|-----------|---------|
| `generateToken` | `(length?: number, charset?: string) => string` | Generic random token from a charset. Default 32 chars, URL-safe alphabet. |
| `generateApiKey` | `(prefix?: string) => string` | API key with vendor prefix. Format: `sk_<48 alphanumeric chars>`. |
| `generateSessionId` | `() => string` | 40-char URL-safe session ID. |
| `generateOTP` | `(digits?: number) => string` | Numeric OTP. Default 6 digits, max 10. |
| `generateSecret` | `(bytes?: number) => string` | Hex-encoded secret. Default 32 bytes (256-bit). |

Also exports charsets: `CHARSET_ALPHANUMERIC`, `CHARSET_HEX`, `CHARSET_URL_SAFE`, `CHARSET_NUMERIC`.

## Design notes

- Rejection sampling in `pickFromCharset` eliminates modulo bias for any charset size.
- `generateSecret` returns raw hex rather than base64 for easy copy-paste and env-var use.
- All functions throw `RangeError` on invalid params rather than silently returning bad output.

## Usage examples

```ts
import {
  generateToken,
  generateApiKey,
  generateSessionId,
  generateOTP,
  generateSecret,
} from "../packages/tools/token-generator";

// 32-char URL-safe token (default)
const csrf = generateToken();

// Custom: 64-char hex token
const hex64 = generateToken(64, "0123456789abcdef");

// API key with custom prefix
const key = generateApiKey("live"); // "live_<48 chars>"

// Session
const sid = generateSessionId(); // 40-char URL-safe

// OTP
const otp = generateOTP(6); // "847291"

// 64-byte secret as hex
const secret = generateSecret(64);
```

## Integration checklist

- [ ] Wire into auth middleware (session creation, CSRF tokens)
- [ ] Replace any existing `Math.random`-based token generation in the codebase
- [ ] Add to `packages/tools/index.ts` barrel export once reviewed
- [ ] Add unit tests covering bias distribution and boundary error cases
