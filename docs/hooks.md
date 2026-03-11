# 8gent Code Hooks System

Hooks allow you to run custom code at key points in the agent workflow.

## Configuration

Hooks are stored in `~/.8gent/hooks.json`:

```json
{
  "hooks": [
    {
      "id": "hook_123",
      "type": "onComplete",
      "name": "Voice Notification",
      "description": "Speaks completion message",
      "mode": "shell",
      "command": "say -v Ava 'Task completed'",
      "enabled": true,
      "async": true,
      "continueOnError": true
    }
  ],
  "globalTimeout": 30000,
  "enabled": true
}
```

## Hook Types

| Type | Trigger |
|------|---------|
| `beforeTool` | Before any tool executes |
| `afterTool` | After any tool completes |
| `beforeCommand` | Before shell command runs |
| `afterCommand` | After shell command completes |
| `onError` | When a tool or command fails |
| `onComplete` | When a task/conversation finishes |
| `onStart` | When agent session starts |
| `onExit` | When agent session ends |

## Hook Modes

### Shell Mode
Run shell commands with variable substitution:

```json
{
  "mode": "shell",
  "command": "echo 'Tool {tool} completed in {duration}ms'"
}
```

### Script Mode
Run external script files:

```json
{
  "mode": "script",
  "scriptPath": "~/.8gent/hooks/notify.ts"
}
```

### Function Mode
Run inline JavaScript:

```json
{
  "mode": "function",
  "functionBody": "console.log('Tool:', context.tool); return 'done';"
}
```

## Context Variables

Available in shell mode (via `{variable}`) and function mode (via `context.variable`):

| Variable | Description |
|----------|-------------|
| `{tool}` | Current tool name |
| `{command}` | Shell command being run |
| `{result}` | Tool/command output |
| `{error}` | Error message if failed |
| `{sessionId}` | Current session ID |
| `{workingDirectory}` | Working directory |
| `{duration}` | Execution time in ms |
| `{exitCode}` | Command exit code |
| `{stdout}` | Command stdout |
| `{stderr}` | Command stderr |

## CLI Commands

| Command | Description |
|---------|-------------|
| `/hooks` | List all registered hooks |
| `/hooks enable <id>` | Enable a hook |
| `/hooks disable <id>` | Disable a hook |

## Default Hooks

Import and register default hooks:

```typescript
import { setupNotificationHooks, setupGitHooks } from "8gent-code/hooks/defaults";

// Enable macOS notifications
setupNotificationHooks();

// Enable git auto-staging
setupGitHooks();
```

### Available Defaults

| Name | Type | Description |
|------|------|-------------|
| Tool Logger | afterTool | Logs tool executions |
| Command Logger | afterCommand | Logs shell commands |
| Error Logger | onError | Logs errors |
| Execution Timer | afterTool | Tracks timing |
| macOS Notification | onComplete | Shows notification |
| Voice Notification | onComplete | TTS announcement |
| Terminal Bell | onComplete | Plays bell sound |
| Telegram Notification | onComplete | Sends Telegram message |
| Auto Git Add | afterTool | Stages changed files |
| Backup Before Edit | beforeTool | Backs up files |
| Command Validator | beforeCommand | Warns on dangerous commands |
| Auto Lint | afterTool | Runs linter after writes |

## API Usage

```typescript
import { getHookManager, registerShellHook } from "8gent-code/hooks";

const manager = getHookManager();

// Register a custom hook
const hook = registerShellHook(
  "onComplete",
  "My Notification",
  "say 'Done: {result}'"
);

// Execute hooks manually
await manager.executeHooks("onComplete", {
  result: "Task finished",
  duration: 1500
});

// Disable a hook
manager.disableHook(hook.id);
```
