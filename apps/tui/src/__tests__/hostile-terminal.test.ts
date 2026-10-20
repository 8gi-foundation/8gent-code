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
 * A terminal that answers the probe at once is covered by the "answers at once"
 * case: on Bun, ending the probe from inside the 'data' event and pausing stdin
 * there left Ink deaf, so no key was ever read (a real bug, not a pipe artefact).
 * Fixed in theme/terminal-probe.ts; see probe-then-typing.test.ts.
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
/**
 * Proof that the Enter was taken: the name question, or the hint line of any
 * later setup step. The test matches the first hint it sees after the key, not
 * one fixed step, because Ink coalesces frames: a burst of Enters under load
 * can move past the name step before that step is ever painted.
 */
const AFTER_KEY = /What should I call you|(?:A number|A name|Your answer), or Enter/;
/** Time after the first key within which it must show on screen. */
const KEY_BUDGET_MS = 15000;
/** A key is sent again only if the screen has not moved this long after it. */
const KEY_RETRY_MS = 2000;

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
	{ name: "answers at once (0 ms)", term: "xterm-256color", replyAfterMs: 0 },
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
				// Ink treats CI=true as "not interactive" and paints only on exit, so a
				// CI runner would never show a first screen. Users are not in CI.
				CI: "false",
			},
		},
	);
	const t0 = Date.now();
	let raw = "";
	let probeAsked = false;
	let paintedMs: number | null = null;
	let keySentAt: number | null = null;
	let keyOffset = 0;
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
			if (
				keySentAt !== null &&
				keyMs === null &&
				AFTER_KEY.test(raw.slice(keyOffset).replace(ANSI, ""))
			) {
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
			// attached, so a key sent too early is lost. Send one key, wait for
			// the screen to move, and send again only after a quiet spell. Never
			// a burst: queued Enters all land at once under load and skip steps.
			keySentAt = Date.now();
			while (keyMs === null && Date.now() - keySentAt < KEY_BUDGET_MS) {
				keyOffset = raw.length;
				send("\r");
				await waitFor(() => keyMs !== null, KEY_RETRY_MS);
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
