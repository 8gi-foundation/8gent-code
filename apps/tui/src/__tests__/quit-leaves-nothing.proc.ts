/**
 * "Quit or closing the terminal leaves nothing running": a long command is left
 * running for each way the app can end, then the process is ended that way and
 * the test checks, within a bounded wait, that the command is gone.
 *
 * Level: a child process (fixtures/quit-harness.ts) built from the real
 * run_command, the real `!cmd` runner and the real exit handlers, wired as
 * app.tsx wires them. Not the full TUI: it could not be driven here (see the
 * pull request). About 25 s, so it is not named *.test.ts and is not in
 * `bun run test`; run it with `bun run test:quit-clean`.
 *
 * Checked by recorded pid only: each command writes its own pid and the pid of
 * a background job in its group; nothing is matched by name, and the test only
 * ever signals pids it recorded from commands it started.
 *
 * A `test.failing` is a fault found: the child outlives the exit. It turns red
 * the day the fault is fixed, which is the cue to make it a plain `test`.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allGone, running } from "./fixtures/process-check";

const HARNESS = join(import.meta.dir, "fixtures", "quit-harness.ts");
/** After the exit, how long a command may take to disappear. */
const GONE_WITHIN_MS = 6000;

interface Outcome {
	runCommand: number[];
	bang: number[];
	/** Of the pids above, those still running after the wait. */
	leftRunCommand: number[];
	leftBang: number[];
	/** Did the harness process itself end within the wait. */
	harnessEnded: boolean;
	startedOk: boolean;
}

async function scenario(
	exit: "SIGTERM" | "SIGHUP" | "SIGINT" | "ctrl-c" | "quit-command",
): Promise<Outcome> {
	const dir = mkdtempSync(join(tmpdir(), "8gent-quit-"));
	const proc = Bun.spawn(["bun", "--no-env-file", "--config=bin/bunfig.empty.toml", HARNESS, dir], {
		cwd: join(import.meta.dir, "..", "..", "..", ".."),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "ignore",
		env: { ...process.env, EIGHT_HOME: dir, HOME: dir },
	});
	let out = "";
	(async () => {
		for await (const d of proc.stdout as unknown as AsyncIterable<Uint8Array>)
			out += Buffer.from(d).toString();
	})();
	const o: Outcome = {
		runCommand: [],
		bang: [],
		leftRunCommand: [],
		leftBang: [],
		harnessEnded: false,
		startedOk: false,
	};
	try {
		const t0 = Date.now();
		const lines = () => out.split("\n");
		while (
			!lines().includes("ready") &&
			!lines().includes("never-ready") &&
			Date.now() - t0 < 30_000
		)
			await Bun.sleep(50);
		if (!lines().includes("ready")) return o;
		const first = lines().find((l) => l.startsWith("{")) as string;
		const rec = JSON.parse(first) as { runCommand: number[]; bang: number[] };
		o.runCommand = rec.runCommand;
		o.bang = rec.bang;
		o.startedOk = [...o.runCommand, ...o.bang].every(running);
		if (exit === "ctrl-c" || exit === "quit-command") {
			proc.stdin.write(`${exit}\n`);
			proc.stdin.flush();
		} else {
			proc.kill(exit);
		}
		const ended = Promise.race([
			proc.exited.then(() => true),
			Bun.sleep(GONE_WITHIN_MS).then(() => false),
		]);
		o.leftRunCommand = await allGone(o.runCommand, GONE_WITHIN_MS);
		o.leftBang = await allGone(o.bang, GONE_WITHIN_MS);
		o.harnessEnded = await ended;
		return o;
	} finally {
		// Only recorded pids from this scenario, and the harness it started.
		for (const pid of [...o.runCommand, ...o.bang]) {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {}
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
		proc.kill(9);
		await proc.exited;
		rmSync(dir, { recursive: true, force: true });
	}
}

const live = process.platform !== "win32";

interface Case {
	exit: Parameters<typeof scenario>[0];
	label: string;
	/** Faults found: which sources are left running. */
	failing: { runCommand?: boolean; bang?: boolean; harness?: boolean };
}

const CASES: Case[] = [
	{
		exit: "quit-command",
		label: "quit command (/quit)",
		failing: { runCommand: true, harness: true },
	},
	{ exit: "ctrl-c", label: "Ctrl-C key", failing: {} },
	{ exit: "SIGINT", label: "SIGINT to the process", failing: { runCommand: true, bang: true } },
	{ exit: "SIGTERM", label: "SIGTERM", failing: {} },
	{ exit: "SIGHUP", label: "SIGHUP (terminal closed)", failing: {} },
];

describe.skipIf(!live)("quit leaves nothing running (harness level)", () => {
	for (const c of CASES) {
		describe(c.label, () => {
			let o: Outcome;
			beforeAll(async () => {
				o = await scenario(c.exit);
			}, 90_000);

			test("both commands were running before the exit", () => {
				expect(o.startedOk).toBe(true);
			});
			const t = (src: "runCommand" | "bang", name: string) => {
				const body = () => {
					expect(o.startedOk).toBe(true);
					expect(
						src === "runCommand" ? o.leftRunCommand : o.leftBang,
						`still running: ${name}`,
					).toEqual([]);
				};
				const title = `${name}: nothing left within ${GONE_WITHIN_MS / 1000}s`;
				if (c.failing[src]) test.failing(`FAULT ${c.label}: ${title}`, body);
				else test(title, body);
			};
			t("runCommand", "model run_command (and its background job)");
			t("bang", "typed !cmd (and its background job)");
			if (c.failing.harness)
				test.failing(
					`FAULT ${c.label}: the app process itself ends within ${GONE_WITHIN_MS / 1000}s`,
					() => {
						expect(o.startedOk).toBe(true);
						expect(o.harnessEnded).toBe(true);
					},
				);
		});
	}
});
