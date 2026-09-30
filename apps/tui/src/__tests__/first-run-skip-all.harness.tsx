/**
 * Harness for first-run-skip-all.test.tsx, run in its own bun process so the
 * App's module-level state (session logger paths, settings caches) never
 * leaks into other test files. HOME is set by the parent. Exit 0 = pass.
 *
 * First run, end to end through the real App: the chat-based setup shows,
 * "/skip all" typed at its very first step ("Enter to begin") ends it, the
 * normal input comes back, and nothing is added to the chat. Rishi's overnight pilot does exactly this at
 * the start of every run, so a setup that cannot be skipped blocks the loop.
 *
 * The App is mounted in-process with a TTY-shaped stdin and an empty HOME,
 * so OnboardingManager sees a fresh first run.
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

async function main() {
	const home = process.env.HOME as string;
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
	// The setup's first step: the welcome, waiting on "Enter to begin".
	await waitFor(() => strip(stdout.written).includes("A short setup follows"), "setup welcome");
	await waitFor(() => strip(stdout.written).includes("Enter to begin"), "setup placeholder");
	const mark = stdout.written.length;
	const perQuestion = process.env.SKIP_MODE === "each";
	if (perQuestion) {
		// "/skip" at every question until setup runs out of questions.
		for (let i = 0; i < 30; i++) {
			if (strip(stdout.written.slice(mark)).includes("Type a command or ask a question")) break;
			const at = stdout.written.length;
			stdin.feed("/skip");
			await waitFor(() => strip(stdout.written.slice(at)).includes("/skip"), "typed /skip");
			await tick(50);
			stdin.feed("\r");
			await tick(400);
		}
	} else {
		stdin.feed("/skip all");
		await waitFor(() => strip(stdout.written.slice(mark)).includes("/skip all"), "typed /skip all");
		await tick(50);
		stdin.feed("\r");
	}
	await waitFor(
		() => strip(stdout.written.slice(mark)).includes("Type a command or ask a question"),
		"normal input",
	);
	await tick(300);
	// The input coming back is the whole answer: a skip leaves no status line
	// in the transcript, and makes no promise to ask again (#3088, #3090).
	const after = strip(stdout.written.slice(mark));
	if (after.includes("ask again later") || after.includes("Understood.") || after.includes("Onboarding complete")) {
		throw new Error("a skip left a status line in the chat");
	}
	// Setup is over, so no card may still ask for setup input (#3090). A key
	// forces a fresh frame; the whole chat is read from it.
	const settledAt = stdout.written.length;
	stdin.feed("x");
	await waitFor(() => /❯ x/.test(strip(stdout.written.slice(settledAt))), "a fresh frame");
	await tick(200);
	const settled = strip(stdout.written.slice(settledAt));
	if (!perQuestion && !settled.includes("Good day")) throw new Error("the welcome's greeting is gone");
	for (const stale of ["Press Enter to begin", "/skip skips a question", "Ready to begin?"]) {
		if (settled.includes(stale)) throw new Error(`setup is over but the chat still says "${stale}"`);
	}
	const user = JSON.parse(fs.readFileSync(path.join(home, ".8gent", "user.json"), "utf-8"));
	app.unmount();
	console.log(
		JSON.stringify({
			ok: true,
			onboardingComplete: user.onboardingComplete,
			name: user.identity.name ?? null,
		}),
	);
	process.exit(0);
}

main().catch((e) => {
	console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) }));
	process.exit(1);
});
