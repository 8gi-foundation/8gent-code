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
