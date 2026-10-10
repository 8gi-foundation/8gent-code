/**
 * Harness for footer-clicks.test.tsx, run in its own bun process so the
 * App's module-level state never leaks into other test files. HOME and
 * OLLAMA_BASE_URL are set by the parent.
 *
 * Mounts the real App on a fake TTY with the mouse layer installed on its
 * stdin, as startMouse() does, and Ink's default Ctrl+C handling (the CLI
 * renders with exitOnCtrlC on). Then it clicks every footer item the way a
 * terminal reports a click, and prints one JSON line per item with what the
 * screen showed afterwards. James, 2026-10-02: "only plan from the buttons
 * in the footer actually works".
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
	/** The footer row of the last frame. */
	const footer = () =>
		screen()
			.split("\n")
			.filter((l) => l.startsWith("mode "))
			.at(-1) ?? "";
	const emit = (o: Record<string, unknown>) => console.log(JSON.stringify(o));

	await waitFor(() => strip(stdout.written).includes("Enter to begin"), "setup placeholder");
	const mark = stdout.written.length;
	stdin.feed("/skip all");
	await waitFor(() => strip(stdout.written.slice(mark)).includes("/skip all"), "typed /skip all");
	await tick(50);
	stdin.feed("\r");
	await waitFor(
		() => strip(stdout.written.slice(mark)).includes("Type a command or ask a question"),
		"normal input",
	);
	await tick(1500);
	emit({ phase: "footer", row: footer() });

	/**
	 * Click the middle of what the footer draws for `text`, found on the
	 * screen rather than in the click registry: the cell a person aims at.
	 */
	const click = async (text: string) => {
		await waitFor(() => footer().includes(text), `footer shows ${text}`, 6000);
		const x = footer().indexOf(text) + Math.floor(text.length / 2);
		// index.tsx clears and homes, the frame is one row shorter than the
		// terminal (FixedFrame), and the footer is its last row.
		const y = ROWS - 2;
		stdin.feed(`\x1b[<0;${x + 1};${y + 1}M`);
		await tick(30);
		stdin.feed(`\x1b[<0;${x + 1};${y + 1}m`);
	};
	const after = async (item: string, check: () => boolean) => {
		let ok = true;
		try {
			await waitFor(check, item, 4000);
		} catch {
			ok = false;
		}
		emit({ phase: "click", item, ok });
	};

	await click("mode Planning [^Y]");
	await after("mode", () => footer().startsWith("mode Researching"));

	await click("[^P] palette");
	await after("palette opens", () => screen().includes("type to filter"));
	await click("[^P] palette");
	await after("palette closes", () => !screen().includes("type to filter"));

	const planBefore = screen().includes(" PLAN ");
	await click("[^X] plan");
	await after("plan", () => screen().includes(" PLAN ") !== planBefore);

	await click("[^A] anim");
	await after("anim", () => footer().includes("motion off"));

	await click("[^S] sound");
	await after("sound", () => footer().includes("sound on"));

	await click("[⇧Tab] perm");
	await after("perm", () => footer().includes("perm Guarded"));

	await click("[^C] quit");
	await after("quit", () => exited);
	process.exit(0);
}

main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", message: String(e?.message ?? e) }));
	process.exit(1);
});
