/**
 * Harness for settings-tab.test.tsx (#4588), run in its own bun process.
 * HOME and OLLAMA_BASE_URL are set by the parent.
 *
 * Mounts the real App on a fake TTY with the mouse layer installed, runs
 * /settings, and checks what the body shows after the Settings tab is
 * selected by a click on the tab bar and by Ctrl+2. Prints one JSON line per
 * check.
 */

import { EventEmitter } from "node:events";
import { Writable } from "node:stream";

class FakeStdin extends EventEmitter {
	isTTY = true;
	private queue: string[] = [];
	setRawMode() {}
	setEncoding() {}
	ref() {}
	unref() {}
	read(): string | null {
		return this.queue.shift() ?? null;
	}
	feed(...chunks: string[]) {
		this.queue.push(...chunks);
		this.emit("readable");
	}
}

type FakeStdout = Writable & { columns: number; rows: number; written: string };

function makeStdout(cols: number, rows: number): FakeStdout {
	const out = new Writable({
		write(chunk, _enc, cb) {
			out.written += chunk.toString();
			if (out.written.length > 2_000_000) out.written = out.written.slice(-1_000_000);
			cb();
		},
	}) as FakeStdout;
	out.written = "";
	out.columns = cols;
	out.rows = rows;
	return out;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const strip = (s: string) => s.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "");
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, label: string, timeoutMs = 20000) {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
		await tick(25);
	}
}

const COLS = 160;
const ROWS = 44;

async function main() {
	const { render } = await import("ink");
	const { App } = await import("../app.js");
	const ct = await import("../lib/click-targets.js");
	const mi = await import("../lib/mouse-input.js");
	const stdin = new FakeStdin();
	const stdout = makeStdout(COLS, ROWS);
	mi.installMouse(
		stdin as unknown as NodeJS.ReadStream,
		{ write: () => true },
		{ enabled: true, processHooks: false },
	);
	mi.onMouse((e) => {
		if (e.kind !== "wheel" && e.kind !== "move") ct.handleMouse(e);
	});
	let exited = false;
	const app = render(<App initialCommand="" args={[]} cliProvider="ollama" cliModel="none" />, {
		stdin: stdin as unknown as NodeJS.ReadStream,
		stdout: stdout as unknown as NodeJS.WriteStream,
		stderr: makeStdout(COLS, ROWS) as unknown as NodeJS.WriteStream,
		debug: false,
		// As the CLI renders it: Ink's own Ctrl+C handling.
		exitOnCtrlC: true,
		patchConsole: false,
	});
	app.waitUntilExit().then(() => {
		exited = true;
	});

	/** The frame Ink drew last: everything after the last header. */
	const screen = () => {
		const s = strip(stdout.written);
		return s.slice(s.lastIndexOf("8gent Code v"));
	};
	const emit = (o: Record<string, unknown>) => console.log(JSON.stringify(o));
	const typeAndEnter = async (text: string) => {
		const m = stdout.written.length;
		stdin.feed(text);
		await waitFor(() => strip(stdout.written.slice(m)).includes(text), `typed ${text}`);
		await tick(50);
		stdin.feed("\r");
	};
	/** Click the middle of `label` on the tab bar row, where the screen draws it. */
	const clickTab = async (label: string) => {
		const lines = screen().split("\n");
		const row = lines.findIndex((l) => l.includes("1] Orchestrator"));
		if (row < 0) throw new Error(`no tab row with ${label}`);
		// The footer is the frame's last row (ROWS - 2, zero-based); count up from it.
		const footerRow = lines.findLastIndex((l) => l.startsWith("mode "));
		const y = row - footerRow + (ROWS - 2);
		const x = lines[row].indexOf(label) + Math.floor(label.length / 2);
		stdin.feed(`\x1b[<0;${x + 1};${y + 1}M`);
		await tick(30);
		stdin.feed(`\x1b[<0;${x + 1};${y + 1}m`);
	};
	const check = async (phase: string, want: () => boolean) => {
		let ok = true;
		try {
			await waitFor(want, phase, 4000);
		} catch {
			ok = false;
		}
		const s = screen();
		emit({
			phase,
			ok,
			hasSettings: s.includes("Categories"),
			hasChat: s.includes("Permission mode: Plan"),
			hasInput: s.includes("Type a command or ask a question"),
		});
	};
	const showsSettings = () =>
		screen().includes("Categories") && !screen().includes("Permission mode: Plan");
	const showsChat = () =>
		screen().includes("Permission mode: Plan") && !screen().includes("Categories");

	await waitFor(() => strip(stdout.written).includes("Enter to begin"), "setup placeholder");
	await typeAndEnter("/skip all");
	await waitFor(() => screen().includes("Type a command or ask a question"), "normal input");
	await tick(1500);

	// Chat content that must disappear when the Settings tab is the body.
	await typeAndEnter("/help");
	await waitFor(() => screen().includes("Permission mode: Plan"), "/help output");
	await tick(300);

	await typeAndEnter("/settings");
	await check("opened", showsSettings);

	// Back to chat by the tab bar, then to Settings by a click.
	await clickTab("Orchestrator");
	await check("click-chat", showsChat);
	await clickTab("Settings");
	await check("click-settings", showsSettings);

	// The same by keyboard: Ctrl+1 and Ctrl+5 (Settings is the fifth tab) (kitty keyboard encoding).
	stdin.feed("\x1b[49;5u");
	await check("key-chat", showsChat);
	stdin.feed("\x1b[53;5u");
	await check("key-settings", showsSettings);

	process.exit(0);
}

main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.message ?? e) }));
	process.exit(1);
});
