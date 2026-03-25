# Quarantine: Backup Tool

## Status: Quarantined

Not yet wired into the main tool index or TUI. Needs review and integration testing.

## What it does

`packages/tools/backup.ts` backs up `~/.8gent/` user data (config, memory DB, sessions, training data, checkpoints) into a timestamped zip archive stored at `~/.8gent/backups/`.

Supports restore from any backup archive.

## API

```ts
import { backup, restore, listBackups } from "./packages/tools/backup.ts";

// Create backup
const result = await backup();
// { success, path, sizeBytes, itemsIncluded, timestamp }

// Restore from archive
const restored = await restore("/path/to/8gent-backup-2026-03-25T12-00-00.zip");
// { success, restoredFrom, itemsRestored, timestamp }

// List available backups
const list = await listBackups();
// [{ name, sizeBytes, created }]
```

## CLI usage

```bash
bun run packages/tools/backup.ts              # create backup
bun run packages/tools/backup.ts list          # list backups
bun run packages/tools/backup.ts restore /path/to/archive.zip  # restore
```

## Backup targets

- `config.json`, `user.json`, `permissions.json`, `hooks.json`, `cron.json`, `tasks.json`
- `memory.db`
- `sessions/`, `training-data/`, `skills/`, `checkpoints/`, `intelligence/`, `models/`, `context/`

## Integration TODO

- [ ] Wire into `packages/tools/index.ts` exports
- [ ] Add TUI command (`/backup`, `/restore`)
- [ ] Add scheduled backup via cron.json
- [ ] Add backup size limit / rotation (keep last N)
- [ ] Add integrity check (verify zip before restore)
