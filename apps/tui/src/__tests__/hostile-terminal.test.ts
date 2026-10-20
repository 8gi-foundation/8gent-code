/**
 * #4540: the first screen must paint, and take a key, on a terminal that does
 * not answer the start-up probes (OSC 11 + DA1), answers late, reports a zero
 * or missing size, or has TERM=dumb. Artale hits a blank first screen over an
 * SSH client on Windows and we have no Windows machine, so this is the repro
 * that runs anywhere.
 *
 * The real entry (apps/tui/src/index.tsx) runs in a child process. The test is
 * the far end of the terminal: it reads what the TUI writes, answers (or does
 * not answer) the probe queries on a schedule, and then types a key. stdio are
 * pipes made to look like a tty by hostile-terminal.preload.ts, because a real
 * pty cannot be opened from a sandboxed shell. What it proves: the probe,
 * early raw-mode hand-off, size read and first render never wait on the
 * terminal. What it cannot prove: Windows console or ConPTY behaviour.
 *
 * Not covered, on purpose: a terminal that answers the probe at once. Over a
 * pipe, a reply written inside the probe window leaves later keys unread (seen
 * with Bun pipe stdin only; real terminals answer at once for every Mac user
 * and work). It needs a real pty to tell a harness artefact from a bug.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..", "..");
const PRELOAD = join(import.meta.dir, "hostile-terminal.preload.ts");
const DA1_QUERY = "\x1b[c";
const OSC11_REPLY = "\x1b]11;rgb:1e1e/1e1e/1e1e\x07";
const DA1_REPLY = "\x1b[?62;4c";
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escapes.
const ANSI = /\x1b\[[0-9;?$]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]/g;

/** Time from spawn within which the first screen must be painted. */
const FIRST_PAINT_BUDGET_MS = 8000;
/** Time from spawn within which the welcome is ready for a key. */
const READY_BUDGET_MS = 15000;
const BEFORE_KEY = "Enter to begin";
const AFTER_KEY = "What should I call you";
/** Time after a key press within which it must show on screen. */
const KEY_BUDGET_MS = 4000;

interface Case {
	name: string;
	term: string;
	cols?: string;
	rows?: string;
	/** ms after the DA1 query at which the terminal replies; undefined = never. */
	replyAfterMs?: number;
}

const CASES: Case[] = [
	{ name: "answers nothing (no OSC 11, no DA1 reply)", term: "xterm" },
	{ name: "answers after the cap (400 ms)", term: "xterm-256color", replyAfterMs: 400 },
	{ name: "reports size 0 by 0", term: "xterm-256color", cols: "0", rows: "0" },
	{ name: "reports no size at all", term: "xterm-256color", cols: "none", rows: "none" },
	{ name: "TERM=dumb, no replies", term: "dumb" },
	{ name: "TERM=xterm-256color, no replies", term: "xterm-256color" },
];

interface Outcome {
	paintedMs: number | null;
	keyShown: boolean;
	keyMs: number | null;
	probeAsked: boolean;
	stderr: string;
	screen: string;
}

async function run(c: Case): Promise<Outcome> {
	const home = mkdtempSync(join(tmpdir(), "8gent-hostile-"));
	const proc = Bun.spawn(
		[
			"bun",
			"--no-env-file",
			"--config=bin/bunfig.empty.toml",
			"--preload",
			PRELOAD,
			"apps/tui/src/index.tsx",
		],
		{
			cwd: REPO,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				HOME: home,
				TERM: c.term,
				H_COLS: c.cols ?? "100",
				H_ROWS: c.rows ?? "30",
				NODE_ENV: "",
				EIGHT_BOOT_TRACE: "0",
			},
		},
	);
	const t0 = Date.now();
	let raw = "";
	let probeAsked = false;
	let paintedMs: number | null = null;
	let keySentAt: number | null = null;
	let keyMs: number | null = null;
	let stderr = "";
	const text = () => raw.replace(ANSI, "");

	const send = (s: string) => {
		try {
			proc.stdin.write(s);
			proc.stdin.flush();
		} catch {}
	};

	(async () => {
		for await (const d of proc.stderr as unknown as AsyncIterable<Uint8Array>)
			stderr += Buffer.from(d).toString();
	})();
	(async () => {
		for await (const d of proc.stdout as unknown as AsyncIterable<Uint8Array>) {
			raw += Buffer.from(d).toString();
			if (!probeAsked && raw.includes(DA1_QUERY)) {
				probeAsked = true;
				if (c.replyAfterMs !== undefined)
					setTimeout(() => send(OSC11_REPLY + DA1_REPLY), c.replyAfterMs);
			}
			if (paintedMs === null && text().includes("8gent Code")) paintedMs = Date.now() - t0;
			if (keySentAt !== null && keyMs === null && text().includes(AFTER_KEY)) {
				keyMs = Date.now() - keySentAt;
			}
		}
	})();

	const waitFor = async (pred: () => boolean, ms: number) => {
		const end = Date.now() + ms;
		while (Date.now() < end && !pred()) await Bun.sleep(25);
		return pred();
	};

	try {
		await waitFor(() => paintedMs !== null, FIRST_PAINT_BUDGET_MS);
		if (paintedMs !== null) {
			// A fresh HOME lands on the first-run welcome; Enter moves it to the
			// name question. That proves the input loop is live, not just painted.
			await waitFor(() => text().includes(BEFORE_KEY), READY_BUDGET_MS);
			// The welcome is on screen a moment before its input handler is
			// attached, so press again every 400 ms, as a person would.
			keySentAt = Date.now();
			while (keyMs === null && Date.now() - keySentAt < KEY_BUDGET_MS) {
				send("\r");
				await waitFor(() => keyMs !== null, 400);
			}
		}
	} finally {
		proc.kill(9);
		await proc.exited;
		rmSync(home, { recursive: true, force: true });
	}
	return {
		paintedMs,
		keyShown: keyMs !== null,
		keyMs,
		probeAsked,
		stderr: stderr.slice(-500),
		screen: text().slice(-600),
	};
}

describe("first screen under a hostile terminal (#4540)", () => {
	for (const c of CASES) {
		test(c.name, async () => {
			const o = await run(c);
			const why = JSON.stringify(o);
			expect(o.paintedMs, `first screen never painted: ${why}`).not.toBeNull();
			expect(o.paintedMs as number, why).toBeLessThanOrEqual(FIRST_PAINT_BUDGET_MS);
			expect(o.keyShown, `key press not accepted: ${why}`).toBe(true);
		}, 45_000);
	}
});
