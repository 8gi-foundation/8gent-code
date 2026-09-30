/**
 * Harness for idle-agent-init.test.tsx, run in its own bun process so the
 * App's module-level state never leaks into other test files. HOME and
 * OLLAMA_BASE_URL are set by the parent, which also runs the fake ollama and
 * counts its /api/tags calls.
 *
 * Mounts the real App with provider ollama, skips the first-run setup, then
 * sits idle (default), or with HARNESS_MODE=recovery waits for the provider to
 * come up and sends a prompt. The parent counts /api/tags calls during the idle window: the
 * agent-init effect re-running on every render used to call
 * TaskRouter.autoAssign (one /api/tags each) about 2.7 times a second (#3087).
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

async function main() {
	const { render } = await import("ink");
	const { App } = await import("../app.js");
	const stdin = new FakeStdin();
	const stdout = makeStdout(160, 48);
	const app = render(
		<App initialCommand="" args={[]} cliProvider="ollama" cliModel={process.env.IDLE_MODEL ?? "none"} />,
		{
			stdin: stdin as unknown as NodeJS.ReadStream,
			stdout: stdout as unknown as NodeJS.WriteStream,
			stderr: makeStdout(160, 48) as unknown as NodeJS.WriteStream,
			debug: false,
			exitOnCtrlC: false,
			patchConsole: false,
		},
	);
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
	if (process.env.HARNESS_MODE === "recovery") {
		// The provider was down at launch and comes up while we wait. The
		// agent must be built on a later retry, so a prompt reaches it.
		await tick(Number(process.env.RECOVERY_WAIT_MS ?? 16000));
		const before = stdout.written.length;
		stdin.feed("hello there");
		await waitFor(() => strip(stdout.written.slice(before)).includes("hello there"), "typed prompt");
		await tick(50);
		stdin.feed("\r");
		await tick(4000);
		const after = strip(stdout.written.slice(before));
		console.log(JSON.stringify({ phase: "submitted", notReady: after.includes("Agent not ready") }));
		app.unmount();
		process.exit(0);
	}
	// Settle: the agent is built and startup probes finish.
	await tick(Number(process.env.IDLE_SETTLE_MS ?? 3000));
	console.log(JSON.stringify({ phase: "idle-start", t: Date.now() }));
	await tick(Number(process.env.IDLE_WINDOW_MS ?? 8000));
	console.log(JSON.stringify({ phase: "idle-end", t: Date.now(), written: stdout.written.length }));
	app.unmount();
	process.exit(0);
}

main().catch((e) => {
	console.log(JSON.stringify({ phase: "error", error: String(e?.message ?? e) }));
	process.exit(1);
});
