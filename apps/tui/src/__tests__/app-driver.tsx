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
	/** Raw bytes written to stdout so far (OSC sequences included). */
	raw: () => string;
	emit: (o: Record<string, unknown>) => void;
	exited: () => boolean;
}

export async function bootApp(cols = 160, rows = 44): Promise<DrivenApp> {
	const { render } = await import("ink");
	const { App } = await import("../app.js");
	const stdin = new FakeStdin();
	const stdout = makeStdout(cols, rows);
	let exited = false;
	const app = render(<App initialCommand="" args={[]} cliProvider="ollama" cliModel="none" />, {
		stdin: stdin as unknown as NodeJS.ReadStream,
		stdout: stdout as unknown as NodeJS.WriteStream,
		stderr: makeStdout(cols, rows) as unknown as NodeJS.WriteStream,
		debug: false,
		exitOnCtrlC: true,
		patchConsole: false,
	});
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
		emit: (o) => console.log(JSON.stringify(o)),
		exited: () => exited,
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

/** Spawn `harness` with a throwaway HOME and a fake ollama; return its JSON lines. */
export async function runAppHarness(
	harness: string,
	extraEnv: Record<string, string> = {},
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
			{
				env: {
					...process.env,
					HOME: home,
					OLLAMA_BASE_URL: base,
					OLLAMA_HOST: base,
					"8GENT_NO_INTRO": "1",
					"8GENT_REDUCED_MOTION": "1",
					...extraEnv,
				},
				stdout: "pipe",
				stderr: "ignore",
			},
		);
		const out = await new Response(proc.stdout).text();
		await proc.exited;
		return (
			out
				.trim()
				.split("\n")
				// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping BEL
				.map((l) => l.replace(/^[\x00-\x1f]+/, ""))
				.filter((l) => l.startsWith("{"))
				.map((l) => JSON.parse(l))
		);
	} finally {
		server.stop(true);
		fs.rmSync(home, { recursive: true, force: true });
	}
}
