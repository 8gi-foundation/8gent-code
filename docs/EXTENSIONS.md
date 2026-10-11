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

Files you write in `~/.8gent/extensions` are on in the interactive TUI;
start it with `--no-extensions` to turn them off. Headless runs
(`8gent run`) load extensions only with `--extensions` or
`EIGHT_EXTENSIONS=1`. They never load in daemon, Table, channel (Telegram,
Discord) or no-tool sessions. Extensions you import are off until you turn
each one on (see below). An extension
runs with your own rights, so only add code you trust. Every extension tool
call still goes through 8gent's policy check, and in an unattended session it
needs approval, so it does not run there.

Extensions load local files only. 8gent runs Bun with `--no-install`, so no
import, however it is written, ever downloads a package; an import of an npm
package 8gent does not provide is also named in the load error.

An extension cannot register a tool named `bash`, `read`, `write`, `edit`,
`ls`, `grep` or `find`, or one starting with `mcp__`, `term_`, `git_`,
`desktop_` or `browser_`: those belong to 8gent's own tools and their checks.

## Bring your Pi extensions

8gent runs extensions written for Pi. Your tools, `/commands` and
`tool_call` guards work the same way, through 8gent's own checks.

### macOS and Linux

```sh
8gent ext import-pi
8gent ext enable pi-<name>      # for each one you want on
```

This reads `~/.pi/agent/extensions` (or `$PI_CODING_AGENT_DIR/extensions`
when you set that for Pi). To import from somewhere else:

```sh
8gent ext import-pi ~/code/my-pi-extensions
```

### Windows (PowerShell)

```powershell
8gent ext import-pi
8gent ext enable pi-<name>      # for each one you want on
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
- Nothing imported runs yet: import reads the files, it does not run them.
  Every imported extension starts **off**. Turn one on with
  `8gent ext enable pi-<name>` (and off with `8gent ext disable pi-<name>`).
- Every time 8gent loads an imported extension it checks the sha256 again.
  If the copy changed since you imported it, it does not load and 8gent
  says so; import it again to accept the change.
- Restart 8gent to use the ones you enabled.

### What works and what does not

Works: `pi.registerTool` (with `Type` from `typebox`, `@sinclair/typebox` or
`@earendil-works/pi-ai`, and `defineTool`), `pi.registerCommand`, and
`pi.on("tool_call")` with `{ block, reason }`. In a `tool_call` event,
`run_command` is called `bash`, `read_file` is `read`, `write_file` is
`write`, `edit_file` is `edit` and `list_files` is `ls`, as in Pi. Other
8gent tools keep their own names, so a Pi guard written for `bash` does not
see `git_*`, `term_*` or other tools that also run commands; check those by
name if your guard needs to.
`ctx.ui.notify` text shows as the command's output; there are no dialogs,
so `ctx.hasUI` is false and `ctx.ui.confirm` answers no.

Loads as partial (accepted, not run): other `pi.on` events,
`registerShortcut`, `registerFlag`, renderers, `registerProvider`,
`registerMcpServer`, `registerVirtualModel`.

Fails with the name of what is missing: session control (`sendMessage`,
`sendUserMessage`, `appendEntry`, `exec`, `setActiveTools`, `setModel`,
`events`), terminal UI components (`@earendil-works/pi-tui`, `CustomEditor`),
changing a tool call's input from `tool_call`, and npm dependencies.
