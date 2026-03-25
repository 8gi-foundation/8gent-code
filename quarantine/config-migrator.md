# Quarantine: Config Version Migrator

## Status: Quarantined

Not wired into agent startup or CLI yet. Needs integration testing against real
config files at each version before promotion.

## What it does

`packages/tools/config-migrator.ts` provides a sequential migration system for
`~/.8gent/config.json`. It:

1. Reads the `version` field (defaults to `"0.1.0"` if absent)
2. Writes an atomic timestamped backup before touching anything
3. Runs only the migrations needed to reach the current target version (`0.4.0`)
4. Writes the updated config back in place
5. Returns a structured result with every step applied

## API

```ts
import { migrate, getCurrentVersion } from "packages/tools/config-migrator";

// Read version from a loaded config object
const ver = getCurrentVersion(config); // "0.2.0"

// Migrate in place (defaults to ~/.8gent/config.json)
const result = await migrate();
// result: { from, to, backupPath, applied: string[], config }

// Dry run - no writes
const preview = await migrate({ dryRun: true });

// Custom path
const result = await migrate({ configPath: "/custom/.8gent/config.json" });
```

## CLI

```bash
# Show what would change, no writes
bun packages/tools/config-migrator.ts --dry-run

# Migrate default config
bun packages/tools/config-migrator.ts

# Migrate a specific file
bun packages/tools/config-migrator.ts --path /path/to/config.json
```

## Migrations registered (0.1.0 -> 0.4.0)

| From | To | What changes |
|------|----|--------------|
| 0.1.0 | 0.2.0 | Add `skills.session-memory` defaults if missing |
| 0.2.0 | 0.3.0 | Add `training_proxy` block (disabled) and `controlPlane` block |
| 0.3.0 | 0.4.0 | Add `voice` block; promote `syncToConvex` top-level key into `db.syncOnLogin` |

## Backup scheme

Before any writes, the original file is copied to:

```
~/.8gent/config.json.backup-2026-03-25T12-00-00-000Z
```

Old backups are not pruned automatically - left to log-rotation or a future
cleanup task.

## Integration path

- Hook into daemon startup: detect outdated config, migrate before loading
- Add CLI command: `8gent config migrate`
- Add to onboarding flow: run migrate before first session
- Pair with `packages/tools/schema-validator.ts` to validate post-migration shape

## Files

- `packages/tools/config-migrator.ts` - implementation (~175 lines)
- `quarantine/config-migrator.md` - this file
