/**
 * Typing right after the start-up probe (#4540 follow-up): a terminal that
 * answers OSC 11 + DA1 at once (a multiplexer such as herdr, tmux, a local
 * emulator) must not cost the person a single key. A real Readable stands in
 * for stdin, and an Ink-shaped consumer (setEncoding, a 'readable' listener,
 * a read() loop, raw mode requested, as Ink 6 does in App.js) reads from it
 * after the probe returns. The reply and the keys arrive in one chunk, in
 * back-to-back chunks, and with the keys first.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { probeTerminalBackground } from "../theme/terminal-probe.js";

const ESC = "\x1b";
const BEL = "\x07";
const OSC11 = `${ESC}]11;rgb:1e1e/1e1e/1e1e${BEL}`;
const DA1 = `${ESC}[?62;4c`;

type TtyLike = PassThrough & {
	isTTY: boolean;
	isRaw: boolean;
	setRawMode: (m: boolean) => unknown;
	rawCalls: boolean[];
};

function fakeTty(startRaw = true): TtyLike {
	const s = new PassThrough() as TtyLike;
	s.isTTY = true;
	s.isRaw = startRaw;
	s.rawCalls = [];
	s.setRawMode = (m: boolean) => {
		s.rawCalls.push(m);
		s.isRaw = m;
		return s;
	};
	return s;
}

/** What Ink 6 does in App.js handleSetRawMode, then reads until `want` bytes or timeout. */
function inkRead(stdin: TtyLike, want: number, waitMs = 600): Promise<string> {
	return new Promise((resolve) => {
		let got = "";
		stdin.setEncoding("utf8");
		stdin.setRawMode(true);
		const onReadable = () => {
			let chunk: string | null;
			while ((chunk = stdin.read() as string | null) !== null) got += chunk;
			if (got.length >= want) done();
		};
		const timer = setTimeout(done, waitMs);
		function done() {
			clearTimeout(timer);
			stdin.removeListener("readable", onReadable);
			resolve(got);
		}
		stdin.addListener("readable", onReadable);
	});
}

async function scenario(
	feed: (stdin: TtyLike) => void,
	opts: { startRaw?: boolean; lateAfterMs?: number } = {},
) {
	const stdin = fakeTty(opts.startRaw ?? true);
	const stdout = { isTTY: true, write: () => true };
	// The terminal answers the instant the query is written.
	stdout.write = () => {
		queueMicrotask(() => feed(stdin));
		return true;
	};
	await probeTerminalBackground({
		stdin: stdin as never,
		stdout,
		env: {},
		timeoutMs: 100,
	});
	// Ink mounts some time later, with typing already waiting.
	await new Promise((r) => setTimeout(r, opts.lateAfterMs ?? 30));
	return stdin;
}

describe("keys typed around the probe reply reach Ink", () => {
	test("reply then keys in one chunk", async () => {
		const stdin = await scenario((s) => s.write(`${OSC11}${DA1}hi`));
		expect(await inkRead(stdin, 2)).toBe("hi");
		expect(stdin.isRaw).toBe(true);
	});

	test("reply then keys in back-to-back chunks", async () => {
		const stdin = await scenario((s) => {
			s.write(OSC11);
			s.write(DA1);
			s.write("h");
			s.write("i");
		});
		expect(await inkRead(stdin, 2)).toBe("hi");
	});

	test("keys typed before the reply, in the same chunk", async () => {
		const stdin = await scenario((s) => s.write(`ab${OSC11}${DA1}`));
		expect(await inkRead(stdin, 2)).toBe("ab");
	});

	test("OSC 11 reply ends the probe; DA1 and keys land after it", async () => {
		const stdin = await scenario((s) => {
			s.write(OSC11);
			setTimeout(() => s.write(`${DA1}hi`), 5);
		});
		expect(await inkRead(stdin, 2)).toBe("hi");
	});

	test("keys typed after the probe ended still arrive", async () => {
		const stdin = await scenario((s) => s.write(`${OSC11}${DA1}`));
		stdin.write("yo");
		expect(await inkRead(stdin, 2)).toBe("yo");
	});

	test("works when early raw mode was off (probe turns it on, then off)", async () => {
		const stdin = await scenario((s) => s.write(`${OSC11}${DA1}hi`), { startRaw: false });
		expect(await inkRead(stdin, 2)).toBe("hi");
		expect(stdin.isRaw).toBe(true);
	});

	test("keys still arrive when Ink mounts after the late-reply window", async () => {
		const stdin = await scenario((s) => s.write(`${OSC11}${DA1}hi`), { lateAfterMs: 1200 });
		expect(await inkRead(stdin, 2)).toBe("hi");
	});
});

// The in-process cases above pass on a Node Readable. The bug they cannot see
// lives in Bun's stdin: a reply that arrives at once ended the probe from
// inside the 'data' event, the probe paused stdin there, and Ink's 'readable'
// listener then never fired, so no key was ever read. This runs the real probe
// and real Ink in a child on Bun pipes (a pty cannot be opened in the sandbox).
describe("real probe then real Ink on Bun stdin", () => {
	const REPO = join(import.meta.dir, "..", "..", "..", "..");
	const PRELOAD = join(import.meta.dir, "hostile-terminal.preload.ts");
	const CHILD = join(import.meta.dir, "probe-then-typing.child.tsx");

	async function keysSeen(reply: (w: (s: string) => void) => void): Promise<string[]> {
		const proc = Bun.spawn(["bun", "--no-env-file", "--preload", PRELOAD, CHILD], {
			cwd: REPO,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, CI: "false", NODE_ENV: "", EIGHT_BOOT_TRACE: "0" },
		});
		const w = (s: string) => {
			try {
				proc.stdin.write(s);
				proc.stdin.flush();
			} catch {}
		};
		let asked = false;
		(async () => {
			for await (const d of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
				if (!asked && Buffer.from(d).toString().includes("\x1b[c")) {
					asked = true;
					reply(w);
				}
			}
		})();
		// A person typing a key every 300 ms from 600 ms on.
		for (const [i, k] of ["a", "b", "c"].entries()) setTimeout(() => w(k), 600 + i * 300);
		let err = "";
		for await (const d of proc.stderr as unknown as AsyncIterable<Uint8Array>)
			err += Buffer.from(d).toString();
		return [...err.matchAll(/KEY="(.*?)"/g)].map((m) => m[1]);
	}

	test("terminal answers OSC 11 + DA1 at once: every later key reaches Ink", async () => {
		expect(await keysSeen((w) => w(`${OSC11}${DA1}`))).toEqual(["a", "b", "c"]);
	}, 30_000);

	test("terminal answers at once and the first key rides in the same chunk", async () => {
		const keys = await keysSeen((w) => w(`${OSC11}${DA1}z`));
		expect(keys.slice(-3)).toEqual(["a", "b", "c"]);
		expect(keys).toContain("z");
	}, 30_000);

	test("terminal answers nothing: keys still reach Ink", async () => {
		expect(await keysSeen(() => {})).toEqual(["a", "b", "c"]);
	}, 30_000);
});
