# Extensions

An extension is one TypeScript or JavaScript file in `~/.8gent/extensions/`
(or a folder there with an `index.ts`). It can add a tool the model can call,
add a `/command`, and block a tool call. No build step and no manifest.

```ts
// ~/.8gent/extensions/shout.ts
export default function (api) {
	api.registerTool({
		name: "shout",
		description: "Upper-case some text",
		parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
		execute: ({ text }) => String(text).toUpperCase(),
	});
	api.registerCommand({ name: "hello", description: "Say hi", run: (args) => `hi ${args}` });
	api.on("tool_call", (e) =>
		e.toolName === "run_command" && String(e.args.command).includes("rm -rf")
			? { block: true, reason: "no recursive deletes here" }
			: undefined,
	);
}
```

Extensions are on in the interactive TUI and in `8gent -p` on your own
machine. Start with `--no-extensions` to turn them off. They never load in
daemon, Table, channel (Telegram, Discord) or no-tool sessions. An extension
runs with your own rights, so only add code you trust. Every extension tool
call still goes through 8gent's policy check, and in an unattended session it
needs approval, so it does not run there.

Extensions load local files only: an import of an npm package is refused
with a message naming the package, and 8gent never downloads one.

## Bring your Pi extensions

8gent runs extensions written for Pi. Your tools, `/commands` and
`tool_call` guards work the same way, through 8gent's own checks.

### macOS and Linux

```sh
8gent ext import-pi
```

This reads `~/.pi/agent/extensions` (or `$PI_CODING_AGENT_DIR/extensions`
when you set that for Pi). To import from somewhere else:

```sh
8gent ext import-pi ~/code/my-pi-extensions
```

### Windows (PowerShell)

```powershell
8gent ext import-pi
```

This reads `C:\Users\<you>\.pi\agent\extensions` (or
`$env:PI_CODING_AGENT_DIR\extensions`). To import from somewhere else:

```powershell
8gent ext import-pi "C:\Users\<you>\code\my-pi-extensions"
```

### In the TUI

```
/extensions import-pi
```

### What happens

- Each extension is copied into `~/.8gent/extensions` as `pi-<name>` (a
  copy, not a link: editing the Pi copy later changes nothing until you
  import again). Folders are copied without `node_modules`.
- Its source path and sha256 go into `~/.8gent/extensions/pi-imports.json`.
- Each one is checked and reported:
  - `loaded`: everything it registers works.
  - `partial`: it loaded, but it also uses Pi features 8gent does not run
    yet; the line names them (for example `pi.on("session_start")`).
  - `failed`: it uses something 8gent does not provide; the line names it
    (for example `Pi API CustomEditor` or `"@earendil-works/pi-tui"`).
- Restart 8gent to use them.

### What works and what does not

Works: `pi.registerTool` (with `Type` from `typebox`, `@sinclair/typebox` or
`@earendil-works/pi-ai`, and `defineTool`), `pi.registerCommand`, and
`pi.on("tool_call")` with `{ block, reason }`. In a `tool_call` event,
`run_command` is called `bash`, `read_file` is `read`, `write_file` is
`write`, `edit_file` is `edit` and `list_files` is `ls`, as in Pi.
`ctx.ui.notify` text shows as the command's output; there are no dialogs,
so `ctx.hasUI` is false and `ctx.ui.confirm` answers no.

Loads as partial (accepted, not run): other `pi.on` events,
`registerShortcut`, `registerFlag`, renderers, `registerProvider`,
`registerMcpServer`, `registerVirtualModel`.

Fails with the name of what is missing: session control (`sendMessage`,
`sendUserMessage`, `appendEntry`, `exec`, `setActiveTools`, `setModel`,
`events`), terminal UI components (`@earendil-works/pi-tui`, `CustomEditor`),
changing a tool call's input from `tool_call`, and npm dependencies.

## Bring Claude Code commands and MCP servers

The same command reads other tools. Nothing is fetched, and nothing is
translated by a model: each item maps across as it is, or the report says
exactly what does not carry over. Every item records its source, path and
sha256 in `~/.8gent/imports.json`.

```sh
8gent ext import claude-code            # stage ~/.claude/commands as /claude-<name>
8gent ext import claude-code --enable   # and turn them on
8gent ext import mcp                    # MCP servers from Claude Code and Pi, pending
8gent ext import mcp --from pi          # only Pi's mcp.json
8gent ext approve-mcp github            # let one pending server start
```

- **Claude Code commands** (`~/.claude/commands/*.md`) become prompt
  templates named `/claude-<name>`. They are staged in
  `~/.8gent/imports/claude-code/prompts` and only used once you pass
  `--enable`. `$ARGUMENTS` and `$1` work. The report names what does not
  carry over: `allowed-tools` and `model` front matter, `` !`command` ``
  lines and `@file` references stay as plain text.
- **Claude Code skills** (`~/.claude/skills/*/SKILL.md`) need no import:
  8gent already reads that folder. The import records their hashes.
- **MCP servers** from `~/.claude.json` (yours and this project's),
  `./.mcp.json` and Pi's `mcp.json` are added to `~/.8gent/mcp.json` under
  `pendingServers`. A pending server never starts. `8gent ext approve-mcp
  <name>` moves it into your server list, and it starts the next time 8gent
  starts. Environment values and headers are copied but never printed.
- **Anything else** is refused with the reason, and nothing is imported.

In the TUI the same commands work as `/extensions import claude-code`,
`/extensions import mcp` and `/extensions approve-mcp <name>`.
