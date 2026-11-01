/**
 * Harness for first-run-unreachable-ollama.test.tsx, run in its own bun
 * process with an empty HOME and OLLAMA_HOST pointed at a host that never
 * answers (set by the parent). Mounts the real App and reports, in ms since
 * this process started, when the setup welcome first shows and when the
 * welcome says what became of the Ollama check (#3115).
 *
 * Prints one JSON line: { ok, welcomeMs, welcomeText, settledMs, settledText }
 * or { ok: false, error }.
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

async function waitFor(check: () => boolean, label: string, timeoutMs: number) {
	const start = performance.now();
	while (!check()) {
		if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
		await tick(20);
	}
}

/** The last rendered frame that contains `marker`, as plain text. */
function lastFrameWith(written: string, marker: string): string {
	const plain = strip(written);
	const at = plain.lastIndexOf(marker);
	return at < 0 ? "" : plain.slice(Math.max(0, at - 1500), at + marker.length);
}

const WELCOME = "A short setup follows";
const WAIT_MS = Number(process.env.HARNESS_WAIT_MS || 20000);
let welcomeMs: number | null = null;
let welcomeText = "";

async function main() {
	const { render } = await import("ink");
	const { App } = await import("../app.js");
	const stdout = makeStdout(160, 48);
	const app = render(<App initialCommand="" args={[]} cliProvider="ollama" cliModel="none" />, {
		stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
		stdout: stdout as unknown as NodeJS.WriteStream,
		stderr: makeStdout(160, 48) as unknown as NodeJS.WriteStream,
		debug: false,
		exitOnCtrlC: false,
		patchConsole: false,
	});
	await waitFor(() => strip(stdout.written).includes(WELCOME), "setup welcome", WAIT_MS);
	welcomeMs = Math.round(performance.now());
	welcomeText = lastFrameWith(stdout.written, WELCOME);
	// The welcome must end up saying what happened to the Ollama check.
	const settled = () => {
		const f = lastFrameWith(stdout.written, WELCOME);
		return /could not be reached|Found on this machine/.test(f) && !/Checking this machine/.test(f);
	};
	await waitFor(settled, "the Ollama check to land in the welcome", WAIT_MS);
	const settledMs = Math.round(performance.now());
	const settledText = lastFrameWith(stdout.written, WELCOME);
	app.unmount();
	console.log(JSON.stringify({ ok: true, welcomeMs, welcomeText, settledMs, settledText }));
	process.exit(0);
}

main().catch((e) => {
	console.log(
		JSON.stringify({
			ok: false,
			error: String(e?.message ?? e),
			atMs: Math.round(performance.now()),
			welcomeMs,
			welcomeText,
		}),
	);
	process.exit(1);
});
