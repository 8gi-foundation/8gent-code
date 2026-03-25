# Quarantine: Environment Variable Manager

## What

CLI tool to list, validate, and manage 8gent environment variables across `.env`, `.env.local`, and `process.env`.

## Why

No single place to see which env vars are set, missing, or misconfigured. Developers waste time debugging missing keys. Secrets leak into logs when printed raw.

## Files

- `packages/tools/env-manager.ts` - ~110 lines, zero dependencies beyond Bun builtins

## Usage

```bash
bun run packages/tools/env-manager.ts list          # show all known vars with masked secrets
bun run packages/tools/env-manager.ts check         # validate required vars, exit 1 if missing
bun run packages/tools/env-manager.ts set KEY=VALUE # write to .env.local
```

## Behavior

- Reads `.env`, then `.env.local`, then `process.env` (last wins)
- Knows 17 8gent-related vars with descriptions
- Masks secrets (shows first 4 chars + `***`)
- `check` exits with code 1 if required vars are missing
- `set` writes to `.env.local` (never touches `.env`)

## Promotion criteria

- [ ] Manual test of list/check/set commands
- [ ] Confirm secret masking works correctly
- [ ] Consider adding to `bun run doctor` flow
- [ ] Review whether any vars should be marked `required: true`

## Blast radius

- 1 new file in `packages/tools/`
- 0 existing files modified
- No new dependencies
