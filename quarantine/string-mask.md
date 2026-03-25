# quarantine: string-mask

**Status:** Quarantined - ready for review and integration
**Package:** `packages/tools/string-mask.ts`
**Size:** ~150 lines

## What it does

Format-preserving string masking for sensitive data. Reveals just enough
context to identify a value while hiding the sensitive portion. No deps.

## API

```ts
import { mask, maskEmail, maskPhone, maskCard, maskApiKey } from './packages/tools/string-mask';

mask("supersecret")                            // "s*********t"
mask("hellothere", { showStart: 2, showEnd: 2, maskChar: "-" }) // "he------re"

maskEmail("user@example.com")                  // "u***@e******.com"
maskEmail("ab@cd.io")                          // "a*@c*.io"

maskPhone("+1 555-867-5309")                   // "+1 ***-***-5309"
maskPhone("0867530900")                        // "0*******00"

maskCard("4242 4242 4242 4242")               // "**** **** **** 4242"
maskCard("4111111111111111")                   // "************1111"

maskApiKey("sk-abc123xyz789def456")            // "sk-a***********f456"
maskApiKey("short")                            // "*****"
```

## Options (mask only)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `showStart` | number | 1 | Chars to reveal at start |
| `showEnd` | number | 1 | Chars to reveal at end |
| `maskChar` | string | `*` | Replacement character |

## Integration notes

- No external dependencies
- All functions are pure and synchronous
- Safe to use in TUI output, logs, and API responses
- Does not validate input format - pass validated data in
- `maskPhone` and `maskCard` preserve separator characters (spaces, dashes)

## Use cases

- Logging: mask tokens/keys before writing to disk
- UI display: show masked card/email in account settings
- Audit trails: record masked sensitive fields without storing plaintext
- Error messages: include partial context without leaking full secret

## Related quarantine entries

- `safe-storage.md` - encrypted local storage
- `secret-scanner.md` - detect secrets in code/text
