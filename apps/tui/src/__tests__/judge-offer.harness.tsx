/**
 * Harness for judge-offer.test.tsx, run in its own bun process (HOME set by the parent).
 * Exit 0 = pass. Real App, fake TTY, EIGHT_JUDGE_RUNTIME=llama-server (the phone path), no intro,
 * a fresh HOME so first-run setup is needed.
 *
 * Proves the in-TUI safety judge offer (apps/tui/src/app.tsx) never fires while setup is up:
 * before setup ends no judge line is posted and the first submit reaches setup (it is not
 * swallowed as the judge answer); once setup ends the judge line appears exactly once.
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
const strip = (s: string) => s.replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, "");
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, label: string, timeoutMs = 20000) {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
		await tick(25);
	}
}

const JUDGE_Q = "Set up the safety judge on this device";
const count = (s: string) => s.split(JUDGE_Q).length - 1;

async function main() {
	// Ink is on a fake TTY; the offer's own interactive guard reads process.*, so make those a TTY too.
	(process.stdin as unknown as { isTTY: boolean }).isTTY = true;
	(process.stdout as unknown as { isTTY: boolean }).isTTY = true;
	const { render } = await import("ink");
	const { App } = await import("../app.js");
	const stdin = new FakeStdin();
	const stdout = makeStdout(160, 48);
	const app = render(<App initialCommand="" args={[]} cliProvider="ollama" cliModel="none" />, {
		stdin: stdin as unknown as NodeJS.ReadStream,
		stdout: stdout as unknown as NodeJS.WriteStream,
		stderr: makeStdout(160, 48) as unknown as NodeJS.WriteStream,
		debug: false,
		exitOnCtrlC: false,
		patchConsole: false,
	});
	await waitFor(() => strip(stdout.written).includes("Enter to begin"), "setup placeholder");
	// Give the offer every chance to fire wrongly while setup is up.
	await tick(2500);
	const judgeDuringSetup = count(strip(stdout.written));
	// The first submit must reach setup: "/skip all" ends it.
	const mark = stdout.written.length;
	stdin.feed("/skip all");
	await waitFor(() => strip(stdout.written.slice(mark)).includes("/skip all"), "typed /skip all");
	await tick(50);
	stdin.feed("\r");
	await waitFor(
		() => strip(stdout.written.slice(mark)).includes("Type a command or ask a question"),
		"normal input",
	);
	const setupEnded = true;
	// Setup is over: the judge line appears, once.
	let appeared = true;
	try {
		await waitFor(() => count(strip(stdout.written)) >= 1, "judge question after setup", 15000);
	} catch {
		appeared = false;
	}
	await tick(1500);
	// One fresh frame holds the whole chat once; the raw stream repeats frames, so count in one.
	const at = stdout.written.length;
	stdin.feed("x");
	await waitFor(() => /❯ x/.test(strip(stdout.written.slice(at))), "a fresh frame");
	await tick(300);
	const judgeAfterSetup = count(strip(stdout.written.slice(at)));
	app.unmount();
	console.log(
		JSON.stringify({ ok: true, judgeDuringSetup, setupEnded, appeared, judgeAfterSetup }),
	);
	process.exit(0);
}

main().catch((e) => {
	console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
	process.exit(1);
});
