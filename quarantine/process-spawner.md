# process-spawner

**Status:** quarantine

## Description

Spawns and manages child processes with full output capture. Handles timeout enforcement (SIGKILL on expiry), stdout/stderr streaming via callbacks, environment inheritance with optional override, and shell mode for pipeline commands. Safe by default - shell not invoked unless shell:true is passed.

## API

- spawn(cmd, args?, options?) - spawn by executable + args array (shell-safe)
- exec(command, options?) - convenience wrapper running via /bin/sh -c

## Options

| Option | Default | Description |
|--------|---------|-------------|
| timeout | 30000ms | Kill process after N ms |
| cwd | process.cwd() | Working directory |
| env | {} | Extra env vars merged onto inherited env |
| inheritEnv | true | Inherit parent process environment |
| onStdout | - | Streaming stdout callback |
| onStderr | - | Streaming stderr callback |
| shell | false | Run via /bin/sh -c |
| maxOutputBytes | 10MB | Truncate output above this size |

## Integration Path

1. Wire into packages/tools/index.ts exports once validated.
2. Use in packages/eight/tools.ts to replace ad-hoc Bun.spawn calls.
3. packages/orchestration/ sub-agent delegation can use this for sandboxed subprocess execution.
4. packages/validation/ checkpoint-verify loop can use exec() for running test commands.
