# Quarantine: port-scanner

**Status:** quarantine - unreviewed, not wired into any index

**File:** `packages/tools/port-scanner.ts`

---

## What it does

Three operations, zero external dependencies:

| Function | Signature | Description |
|----------|-----------|-------------|
| `checkPort` | `(port, host?) => Promise<PortInfo>` | Is a port in use? If yes, returns pid, process name, and address. |
| `findAvailable` | `(start?, end?, host?) => Promise<number \| null>` | First free port in [start, end] range. |
| `scanRange` | `(start?, end?, host?) => Promise<PortInfo[]>` | All occupied ports in a range. Batches 50 at a time to avoid fd exhaustion. |

`PortInfo` shape:
```ts
{
  port: number;
  inUse: boolean;
  pid?: number;
  process?: string;
  address?: string;
}
```

---

## CLI usage

```bash
# Check a single port
bun packages/tools/port-scanner.ts check 3000

# Find first free port in default range (3000-9999)
bun packages/tools/port-scanner.ts find

# Find in custom range
bun packages/tools/port-scanner.ts find 8000 8100

# Scan a range for all occupied ports
bun packages/tools/port-scanner.ts scan 3000 4000
```

---

## Implementation notes

- Port availability probed via a temporary `net.createServer()` attempt - no shell calls needed for the check itself.
- Process owner resolved via `lsof -nP -iTCP:<port> -sTCP:LISTEN` (macOS/Linux). Falls back to `ss -tlnp` if lsof is absent.
- `execSync` has a 3-second timeout per lookup to avoid hanging on slow systems.
- `scanRange` runs checks in parallel batches of 50.

---

## Integration notes

Not wired into `packages/tools/index.ts` or any agent tool registry. Export the functions and register them when needed.

Potential uses:
- Dev environment startup check (avoid port collisions before launching services)
- Onboarding: auto-select a free port for the TUI or daemon
- Debugger view: show active ports in the system info panel
