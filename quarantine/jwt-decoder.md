# jwt-decoder

## Tool Name
`jwt-decoder`

## Description
Decodes and inspects JWT tokens without signature verification. Useful for debugging agent auth flows, inspecting claims, checking expiry, and identifying the signing algorithm. Handles standard registered claims (iss, sub, aud, exp, nbf, iat, jti) as well as arbitrary custom claims.

## Exports
- `decodeJWT(token)` - Decode a JWT string into structured `{ header, payload, signature, raw }`. Throws on malformed tokens.
- `isExpired(token)` - Returns `true` if the token's `exp` claim is in the past. Returns `false` if no `exp` claim is present.
- `getClaims(token)` - Returns all payload claims as a flat `Record<string, unknown>`.
- `inspectJWT(token)` - Full inspection: decodes, checks expiry, extracts all metadata, and produces a human-readable formatted summary string.

## Status
`quarantine`

No external dependencies. Self-contained TypeScript using only the Node.js built-in `Buffer` for base64url decoding. Not yet wired into the agent tool registry or permissions policy.

## Integration Path
1. Register in `packages/eight/tools.ts` under a `utilities` or `auth` category.
2. Add a NemoClaw policy entry in `packages/permissions/policy-engine.ts` - this tool is read-only (no network, no disk writes) so it can be allow-listed broadly.
3. Expose as a CLI tool via the agent tool dispatch in `packages/tools/index.ts`.
4. Consider surfacing `inspectJWT` output in the TUI debugger view when agent auth errors are detected.
