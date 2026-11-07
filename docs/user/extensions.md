# Extensions

**Extension folder.** `~/.8gent/extensions/<name>/` with an `8gent-extension.json` (`name`, `version`, `description`, `entry`, `tools`) and an entry file that exports the tool functions. Loaded at start.

**MCP servers.** List them in `~/.8gent/mcp.json`; see [the example](../guides/mcp-config.example.json).

**Hooks.** `~/.8gent/hooks.json` runs a command at `beforeTool`, `afterTool`, `onComplete` and more. See [hooks](../guides/hooks.md).

**Flights (LetsFG).** A ready-made extension lives in `packages/extensions/bundled/letsfg/`. It is not installed and it is off until you enable it. To try it: copy the folder to `~/.8gent/extensions/letsfg/`, run `bun packages/extensions/process.ts enable letsfg` (the question defaults to No), and store your LetsFG token in the keychain under the service name `8gent-letsfg` (macOS: `security add-generic-password -s 8gent-letsfg -a "$USER" -w`). Searching only reads. Booking is a separate step: you are shown the flight and the price and must type yes, every time. Your card is held for that price and charged only when the airline confirms. With no terminal, or in CI, the answer is No. LetsFG is a third-party service under its own terms; searches and bookings go to it.

**Skills.** A markdown file at `~/.8gent/skills/<name>.md` or `.claude/skills/<name>/SKILL.md` becomes `/<name>`. `/skills` lists them. See [skills](../../packages/skills/README.md).
