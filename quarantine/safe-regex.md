# safe-regex

## Tool name
`isSafe` / `safeExec`

## Description
Validates regex patterns against ReDoS (Regular Expression Denial of Service) vulnerabilities. Zero external dependencies - pure TypeScript.

**Capabilities:**
- Detects exponential backtracking patterns (e.g. `(a+)+`, `(.*)*`)
- Detects nested quantifiers that create ambiguous NFA paths
- Detects overlapping alternation under quantifiers (e.g. `(a|ab)+`)
- Star height analysis - flags patterns with height >= 2
- `isSafe(pattern)` - static analysis, returns `{ safe: true }` or `{ safe: false, reason, pattern }`
- `safeExec(pattern, input, timeoutMs?)` - execute with hard 100ms default deadline, returns matched/timedOut/false

## Status
`quarantine`

## Integration path

**Target location:** `packages/tools/safe-regex.ts` (already placed)

**Candidate consumers:**

| Consumer | Use case |
|----------|----------|
| `packages/permissions/policy-engine.ts` | Validate any user-supplied regex in YAML policies before compilation |
| `packages/eight/tools.ts` | Gate regex tool calls through `isSafe` before execution |
| `packages/validation/` | Audit stored patterns during checkpoint verification |
| `packages/memory/store.ts` | Validate FTS5 pattern inputs at query boundary |

**Integration steps:**
1. Wire `isSafe` into `packages/permissions/policy-engine.ts` - reject policy rules containing unsafe regex patterns at parse time
2. Add `safeExec` as an agent-callable tool in `packages/eight/tools.ts` so Eight can run pattern matching without ReDoS risk
3. Add a validation pass in `packages/validation/` that scans loaded config files for regex fields

**Graduation criteria:**
- `isSafe` integrated into at least one policy or tool execution path
- At least one regression test covering a known ReDoS pattern (e.g. `(a+)+`)
- `safeExec` timeout verified against a pathological input on a real benchmark
- No new external deps introduced
