# Quarantine: permission-checker

## What

Checks filesystem read/write/execute permissions before operations. Prevents access errors by validating permissions upfront rather than catching exceptions mid-operation. Handles non-existent paths by falling back to parent directory write checks, and resolves file ownership info on Unix systems.

## File

`packages/tools/permission-checker.ts` (~110 lines)

## Status

**quarantine** - new file, untested in CI, not yet wired into tool registry.

## API

```ts
import {
  canRead,
  canWrite,
  canExecute,
  checkAll,
  ensureWritable,
  getOwner,
} from './packages/tools/permission-checker.ts';

// Individual checks
canRead('/etc/hosts')          // true
canWrite('/etc/hosts')         // false (root-owned)
canExecute('/usr/bin/node')    // true

// Combined check
checkAll('/tmp/workdir')
// { read: true, write: true, execute: true }

// Guard before write operations (throws on failure)
ensureWritable('/tmp/output.json')

// Ownership info
getOwner('/etc/hosts')
// { uid: 0, gid: 0, isOwner: false, username: 'root' }
```

## Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `canRead` | `(path: string) => boolean` | Returns true if current process has read access |
| `canWrite` | `(path: string) => boolean` | Returns true if writable; checks parent dir for non-existent paths |
| `canExecute` | `(path: string) => boolean` | Returns true if current process has execute access |
| `checkAll` | `(path: string) => PermissionResult` | Returns `{read, write, execute}` booleans in one call |
| `ensureWritable` | `(path: string) => void` | Throws a descriptive error if path is not writable |
| `getOwner` | `(path: string) => OwnerInfo` | Returns uid, gid, isOwner flag, and resolved username |

## Integration path

- [ ] Add export to `packages/tools/index.ts`
- [ ] Register as an agent-callable tool in `packages/eight/tools.ts`
- [ ] Add unit tests: canWrite on non-existent path (parent check), ensureWritable throw message, getOwner on root-owned file, checkAll on symlink
- [ ] Wire into agent file-write operations as a preflight check before `fs.writeFile`
- [ ] Use in `packages/validation/` checkpoint-revert loop to verify stash target is writable
- [ ] Consider async variants (`canReadAsync` etc.) using `fs.promises.access` for non-blocking agent pipelines
