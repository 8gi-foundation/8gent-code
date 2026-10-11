# Extensions

Four ways to extend 8gent today. None needs a rebuild.

## 1. Extension folders

Put a folder in `~/.8gent/extensions/<name>/` with an `8gent-extension.json` manifest:

```json
{
  "name": "hello",
  "version": "0.1.0",
  "description": "Says hello",
  "entry": "index.ts",
  "tools": [
    {
      "name": "hello",
      "description": "Greet someone",
      "parameters": { "who": { "type": "string", "required": true } }
    }
  ]
}
```

`index.ts` exports the function (or a `tools` object):

```ts
export async function hello(args: { who: string }) {
  return `hello ${args.who}`;
}
```

Extensions load when 8gent starts, and the tools they export become available to the model. A folder with a bad manifest or a missing entry file is skipped with an error line. Run with `DEBUG=1` to see what loaded.

Coming soon: a revertible extension scope behind `EIGHT_EXT_SCOPE` (#3440).

## 2. MCP servers

List servers in `~/.8gent/mcp.json`:

```json
{
  "servers": {
    "memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] },
    "remote": { "url": "https://mcp.example.com/sse", "headers": { "Authorization": "Bearer ..." } }
  }
}
```

Their tools appear to the model. Example file: [../guides/mcp-config.example.json](../guides/mcp-config.example.json).

## 3. Hooks

`~/.8gent/hooks.json` runs a shell command or script at `beforeTool`, `afterTool`, `beforeCommand`, `afterCommand`, `onError`, `onComplete`, `onStart` and `onExit`. Full format: [../guides/hooks.md](../guides/hooks.md).

## 4. Skills

A skill is a markdown file that becomes a slash command.

- Personal: `~/.8gent/skills/<name>.md`
- Per project: `.claude/skills/<name>/SKILL.md`

`/skills` lists what loaded. Typing `/<skill>` expands it to its prompt. Format and bundled skills: [../../packages/skills/README.md](../../packages/skills/README.md).

## Mini-apps

`/create-app <name>` scaffolds a small personal app at `~/.8gent/apps/<name>/`.
