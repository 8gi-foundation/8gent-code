# safe-storage

**Status:** Quarantine - awaiting review
**File:** `packages/tools/safe-storage.ts`
**Lines:** ~130

## What it does

AES-256-GCM encrypted key-value file storage for sensitive configuration. Designed for API keys, tokens, and credentials that should never sit in plaintext on disk. Each value is encrypted independently with its own IV and PBKDF2-derived key, so compromising one entry does not expose others.

## API

```ts
import { SafeStorage } from './packages/tools/safe-storage';

const store = new SafeStorage('.8gent/secrets.enc', 'my-passphrase');

// Write
store.set('OPENROUTER_API_KEY', 'sk-...');
store.set('FLY_TOKEN', 'fo1-...');

// Read
const key = store.get('OPENROUTER_API_KEY'); // 'sk-...' or null

// Delete
store.delete('FLY_TOKEN');

// Enumerate keys (values are not decrypted)
const keys = store.list(); // ['OPENROUTER_API_KEY']
```

## Exports

| Export | Signature | Purpose |
|--------|-----------|---------|
| `SafeStorage` | `class` | Encrypted key-value store backed by a JSON file |

## Methods

| Method | Signature | Notes |
|--------|-----------|-------|
| `set` | `(key: string, value: string) => void` | Encrypts and writes. Overwrites existing key. |
| `get` | `(key: string) => string \| null` | Decrypts and returns value. Null if key absent. |
| `delete` | `(key: string) => void` | Removes key. No-op if absent. |
| `list` | `() => string[]` | Returns all stored keys. No decryption. |

## Encryption details

| Property | Value |
|----------|-------|
| Algorithm | AES-256-GCM |
| Key derivation | PBKDF2 (SHA-256, 100k iterations) |
| IV | 96-bit random per entry |
| Auth tag | 128-bit (GCM default) |
| Salt | 256-bit random per entry |
| File permissions | 0o600 (owner read/write only) |

Each entry stores `{ iv, tag, salt, data }` as hex strings inside a versioned JSON file.

## Why quarantine?

No external dependencies - uses Node.js built-in `crypto`. Needs review before wiring into:
- `packages/eight/agent.ts` as the default secret store
- Onboarding flow for initial API key capture
- Config loader as a secure fallback for sensitive values

Open question: passphrase source. Options are env var (`EIGHT_PASSPHRASE`), `.8gent/passphrase` file (chmod 600), or OS keychain via a future `keychain.ts` adapter.
