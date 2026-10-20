# 8gent Code Permission System

The permission system provides security controls for command execution in 8gent Code.

To change how much 8gent may do without asking, press Shift+Tab. See [permission-modes.md](permission-modes.md).

## Configuration

Permissions are stored in `~/.8gent/permissions.json`:

```json
{
  "allowedPatterns": ["npm *", "bun *", "git *", "ls *", "cat *"],
  "deniedPatterns": ["rm -rf /", "sudo rm -rf"],
  "autoApprove": false,
  "logPath": "~/.8gent/logs/permissions.log"
}
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `/permissions` | Show current permission config and stats |
| `/allow <pattern>` | Add pattern to allowed list |
| `/deny <pattern>` | Add pattern to denied list |
| `/auto-approve` | Toggle auto-approve mode |

## Dangerous Commands

The following commands always require explicit user approval:

- **Destructive**: `rm -rf`, `rm -r`, `rmdir`
- **Privilege escalation**: `sudo`, `su`, `doas`
- **Permission changes**: `chmod`, `chown`, `chgrp`
- **Disk operations**: `dd`, `mkfs`, `fdisk`
- **System modification**: `systemctl`, `reboot`, `shutdown`
- **Git destructive**: `git push --force`, `git reset --hard`
- **Code execution**: `curl | sh`, `wget | bash`

## Writing files from a shell line

A shell line that writes a file with a heredoc or a multi-line command is refused, and the refusal now opens with the fix: `Use the write_file tool to create or change a file.` The model reads that first sentence, so it switches to `write_file` instead of retrying the shell form. The older text still follows for the one allowed form, a quoted heredoc into a relative path inside the project (`cat > .tmp/x.py << 'EOF'`). A chained command is refused with `Send each command as its own run_command call.` first. The wording lives in `packages/permissions/shell-sanitizer.ts` and `packages/permissions/refusal-lead.ts`.

## Safe Patterns (Auto-approved)

These patterns are automatically approved:

- Package managers: `npm install`, `bun run`, `yarn add`
- Git read-only: `git status`, `git log`, `git diff`
- Build tools: `tsc`, `vite`, `webpack`
- Testing: `jest`, `vitest`, `pytest`
- Linting: `eslint`, `prettier`, `biome`
- File reading: `ls`, `cat`, `head`, `tail`, `grep`

## Pattern Matching

Patterns use glob-like syntax:
- `*` matches anything
- `?` matches single character

Examples:
- `npm *` matches all npm commands
- `git commit *` matches git commits with any message
- `bun run dev*` matches `bun run dev`, `bun run dev:watch`, etc.

## API Usage

```typescript
import { getPermissionManager, requestCommandPermission } from "8gent-code/permissions";

// Check if command needs permission
const manager = getPermissionManager();
const check = manager.checkPermission("rm -rf ./dist");
// Returns: "allowed" | "denied" | "ask"

// Request permission interactively
const allowed = await requestCommandPermission("npm run build");

// Add patterns programmatically
manager.allowPattern("docker *");
manager.denyPattern("docker rm *");
```
