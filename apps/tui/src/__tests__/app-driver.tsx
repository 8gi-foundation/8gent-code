/**
 * Drive the real App on a fake TTY, for the Pi-parity shell tests (#3918).
 *
 * Two halves. The harness half (bootApp) runs inside a child bun process,
 * mounts <App> on a fake stdin/stdout and gets past first-run setup to the
 * normal input. The test half (runAppHarness) serves a fake ollama, spawns a
 * harness file with a throwaway HOME, and returns the JSON lines it printed.
 * Same approach as footer-clicks.harness.tsx, shared so each shell feature
 * can prove itself in the App a person runs, not only in a unit.
 */

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

type FakeStdout = Writable & {
	columns: number;
	rows: number;
	written: string;
	/** The last whole multi-row frame Ink drew, the screen as a person sees it. */
	lastFrame: string;
	isTTY?: boolean;
	/** Every write with its time, so a test can count frames per second. */
	writes: { at: number; text: string }[];
};

function makeStdout(cols: number, rows: number, tty = false): FakeStdout {
	const out = new Writable({
		write(chunk, _enc, cb) {
			const text = chunk.toString();
			out.writes.push({ at: Date.now(), text });
			if (out.writes.length > 20_000) out.writes.splice(0, 10_000);
			// Ink writes one whole frame per call; the last multi-row one is the screen.
			if (text.split("\n").length >= 3) out.lastFrame = text;
			out.written += text;
			if (out.written.length > 2_000_000) out.written = out.written.slice(-1_000_000);
			cb();
		},
	}) as FakeStdout;
	out.written = "";
	out.writes = [];
	out.lastFrame = "";
	out.columns = cols;
	out.rows = rows;
	// A real terminal is a TTY. Ink keys its fullscreen and synchronized-output
	// paths off isTTY, so a test about what a phone sees opts in (#4938).
	if (tty) out.isTTY = true;
	return out;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
export const strip = (s: string) => s.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "");
export const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(check: () => boolean, label: string, timeoutMs = 20000) {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
		await tick(25);
	}
}

export interface DrivenApp {
	/** Send raw bytes, as a terminal would. */
	feed: (chunk: string) => void;
	/** Everything written since `from` (a value of `mark()`), ANSI stripped. */
	since: (from: number) => string;
	mark: () => number;
	/** Type text, wait for it to echo, then press Enter. */
	submit: (text: string) => Promise<number>;
	/** The screen as the last frame Ink drew it, ANSI stripped, one string per row. */
	frame: () => string[];
	/** Raw bytes written to stdout so far (OSC sequences included). */
	raw: () => string;
	emit: (o: Record<string, unknown>) => void;
	exited: () => boolean;
	/** Every stdout write since `sinceMs` (epoch ms), raw, with its time. */
	writesSince: (sinceMs: number) => { at: number; text: string }[];
	/** Change the terminal size, as Termux does when the keyboard opens. */
	resize: (cols: number, rows: number) => void;
}

export async function bootApp(
	cols = 160,
	rows = 44,
	/** Launch flags. The default pins ollama, as most harnesses want; pass `{}` for a plain launch. */
	cli: { provider?: string; model?: string; resume?: string } = {
		provider: "ollama",
		model: "none",
	},
	/**
	 * Behave as bin/8gent on a real terminal: stdout is a TTY and Ink gets the
	 * TUI's own render options (#4938). Off by default, because incremental
	 * rendering does not rewrite unchanged rows, and older harnesses look for
	 * text in what was written after a mark.
	 */
	tty = false,
): Promise<DrivenApp> {
	const { render } = await import("ink");
	const { App } = await import("../app.js");
	const { tuiRenderOptions } = await import("../lib/render-options.js");
	const stdin = new FakeStdin();
	const stdout = makeStdout(cols, rows, tty);
	let exited = false;
	const app = render(
		<App
			initialCommand=""
			args={[]}
			cliProvider={cli.provider}
			cliModel={cli.model}
			sessionResume={cli.resume}
		/>,
		{
			stdin: stdin as unknown as NodeJS.ReadStream,
			stdout: stdout as unknown as NodeJS.WriteStream,
			stderr: makeStdout(cols, rows) as unknown as NodeJS.WriteStream,
			...(tty ? tuiRenderOptions() : {}),
			debug: false,
			exitOnCtrlC: true,
			patchConsole: false,
		},
	);
	app.waitUntilExit().then(() => {
		exited = true;
	});
	const mark = () => stdout.written.length;
	const since = (from: number) => strip(stdout.written.slice(from));
	const driven: DrivenApp = {
		feed: (c) => stdin.feed(c),
		mark,
		since,
		raw: () => stdout.written,
		frame: () => strip(stdout.lastFrame).split("\n"),
		emit: (o) => console.log(JSON.stringify(o)),
		exited: () => exited,
		writesSince: (sinceMs) => stdout.writes.filter((w) => w.at >= sinceMs),
		resize: (c, r) => {
			stdout.columns = c;
			stdout.rows = r;
			stdout.emit("resize");
		},
		submit: async (text) => {
			const m = mark();
			stdin.feed(text);
			await waitFor(() => since(m).includes(text), `typed ${text}`);
			await tick(50);
			const after = mark();
			stdin.feed("\r");
			return after;
		},
	};
	await waitFor(() => strip(stdout.written).includes("Enter to begin"), "setup placeholder");
	const m = await driven.submit("/skip all");
	await waitFor(() => since(m).includes("Type a command or ask a question"), "normal input");
	await tick(800);
	return driven;
}

/**
 * The child's environment: this process's, minus every *_API_KEY (a test
 * must never reach a hosted provider), pointed at the fake model. The decider
 * reads EIGHT_DECIDE_OLLAMA_HOST, not OLLAMA_HOST, so it is pointed too.
 */
export function harnessEnv(
	base: string,
	home: string,
	extraEnv: Record<string, string>,
	parent: Record<string, string | undefined> = process.env,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(parent)) {
		if (v !== undefined && !k.endsWith("_API_KEY")) env[k] = v;
	}
	Object.assign(env, {
		HOME: home,
		// Windows os.homedir() reads USERPROFILE and ignores HOME, so the throwaway home needs both.
		USERPROFILE: home,
		// The test process pins these to ONE shared temp dir for the whole run
		// (tests/preload-temp-home.ts), and the store prefers EIGHT_DATA_DIR over
		// HOME. Inherited, every harness would write its sessions into that shared
		// dir and a later one would list the earlier ones. Each harness owns its home.
		EIGHT_HOME: home,
		EIGHT_DATA_DIR: path.join(home, ".8gent"),
		OLLAMA_BASE_URL: base,
		OLLAMA_HOST: base,
		"8GENT_NO_INTRO": "1",
		"8GENT_REDUCED_MOTION": "1",
		...extraEnv,
	});
	env.EIGHT_DECIDE_OLLAMA_HOST = extraEnv.EIGHT_DECIDE_OLLAMA_HOST ?? env.OLLAMA_HOST;
	return env;
}

/** How long a harness may run before it is killed. */
export const HARNESS_DEADLINE_MS = 75_000;

/**
 * Spawn `harness` with a throwaway HOME and a fake ollama; return its JSON
 * lines. A harness that overruns the deadline is killed. When it fails (an
 * error line, no lines, a non-zero exit, or the kill), its stderr is printed.
 */
export async function runAppHarness(
	harness: string,
	extraEnv: Record<string, string> = {},
	deadlineMs = HARNESS_DEADLINE_MS,
): Promise<Record<string, unknown>[]> {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "8gent-shell-"));
	const model = "shell-test:1b";
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/api/tags") {
				return Response.json({ models: [{ name: model, model, size: 1 }] });
			}
			if (url.pathname === "/api/version") return Response.json({ version: "0.0.0" });
			return new Response("not found", { status: 404 });
		},
	});
	const base = `http://127.0.0.1:${server.port}`;
	try {
		const proc = Bun.spawn(
			[
				process.execPath,
				"--preload",
				path.join(import.meta.dir, "../../../../tests/preload-ink-interactive.ts"),
				harness,
			],
			{ env: harnessEnv(base, home, extraEnv), stdout: "pipe", stderr: "pipe" },
		);
		let killed = false;
		const timer = setTimeout(() => {
			killed = true;
			proc.kill("SIGKILL");
		}, deadlineMs);
		const [out, err] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const code = await proc.exited;
		clearTimeout(timer);
		const events = out
			.trim()
			.split("\n")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping BEL
			.map((l) => l.replace(/^[\x00-\x1f]+/, ""))
			.filter((l) => l.startsWith("{"))
			.map((l) => JSON.parse(l) as Record<string, unknown>);
		if (killed) events.push({ phase: "error", message: `harness killed after ${deadlineMs} ms` });
		if (killed || code !== 0 || events.length === 0 || events.some((e) => e.phase === "error")) {
			console.error(
				`[app-driver] ${path.basename(harness)} failed (exit ${code}${killed ? ", killed" : ""}). stderr:\n${err.slice(-8000)}`,
			);
		}
		return events;
	} finally {
		server.stop(true);
		fs.rmSync(home, { recursive: true, force: true });
	}
}
