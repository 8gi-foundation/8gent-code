# Extensions

**Extension folder.** `~/.8gent/extensions/<name>/` with an `8gent-extension.json` (`name`, `version`, `description`, `entry`, `tools`) and an entry file that exports the tool functions. Loaded at start.

**MCP servers.** List them in `~/.8gent/mcp.json`; see [the example](../guides/mcp-config.example.json).

**Hooks.** `~/.8gent/hooks.json` runs a command at `beforeTool`, `afterTool`, `onComplete` and more. See [hooks](../guides/hooks.md).

**Skills.** A markdown file at `~/.8gent/skills/<name>.md` or `.claude/skills/<name>/SKILL.md` becomes `/<name>`. `/skills` lists them. See [skills](../../packages/skills/README.md).
