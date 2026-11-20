/**
 * "Quit or closing the terminal leaves nothing running": every process the
 * harness (fixtures/quit-harness.ts) starts is left running, the process is
 * ended each way the app can end, and the test checks, within a bounded wait,
 * which of them are gone.
 *
 * Level: a child process built from the real code that starts each resource
 * (see the harness header for which parts are stand-in binaries) with the real
 * exit handlers and the real Agent.cleanup(). Not the full TUI: it could not be
 * driven here (see the pull request). About 40 s, so it is not named *.test.ts
 * and is not in `bun run test`; run it with `bun run test:quit-clean`.
 *
 * Precondition, outside every test: all five scenarios run at module load. If
 * the harness cannot start, or a recorded pid is not running before the exit is
 * sent, loading throws and the file errors with the reason. No test, expected
 * failure or not, is reported in that case.
 *
 * Checked by recorded pid only: each stand-in writes its own pid; nothing is
 * matched by name, and the test only ever signals pids it recorded from
 * processes it started.
 *
 * A `test.failing` is a fault found: the process outlives the exit. It turns
 * red the day the fault is fixed, which is the cue to make it a plain `test`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allGone, running } from "./fixtures/process-check";

const HARNESS = join(import.meta.dir, "fixtures", "quit-harness.ts");
/** After the exit, how long a process may take to disappear. */
const GONE_WITHIN_MS = 6000;
const START_WITHIN_MS = 30_000;

type Exit = "SIGTERM" | "SIGHUP" | "SIGINT" | "ctrl-c" | "quit-command";
type Resource = "runCommand" | "bang" | "mcp" | "browser" | "moshi" | "recorder";

const RESOURCES: { id: Resource; name: string }[] = [
	{ id: "runCommand", name: "model run_command (and its background job)" },
	{ id: "bang", name: "typed !cmd (and its background job)" },
	{ id: "mcp", name: "MCP stdio server" },
	{ id: "browser", name: "8gent Browser (started detached)" },
	{ id: "moshi", name: "moshi server" },
	{ id: "recorder", name: "microphone recorder" },
];

interface Outcome {
	pids: number[];
	/** Of the pids above, those still running after the wait. */
	left: number[];
}

async function scenario(exit: Exit, resource: Resource): Promise<Outcome> {
	const tag = `${resource} / ${exit}`;
	const dir = mkdtempSync(join(tmpdir(), "8gent-quit-"));
	const proc = Bun.spawn(
		["bun", "--no-env-file", "--config=bin/bunfig.empty.toml", HARNESS, dir, resource],
		{
			cwd: join(import.meta.dir, "..", "..", "..", ".."),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "ignore",
			env: {
				...process.env,
				EIGHT_HOME: dir,
				HOME: dir,
				// Stand-ins for python3 and rec are written into this directory by the harness.
				PATH: `${join(dir, "bin")}:${process.env.PATH}`,
			},
		},
	);
	let out = "";
	(async () => {
		for await (const d of proc.stdout as unknown as AsyncIterable<Uint8Array>)
			out += Buffer.from(d).toString();
	})();
	let pids: number[] = [];
	let died = false;
	void proc.exited.then(() => {
		died = true;
	});
	try {
		const t0 = Date.now();
		const lines = () => out.split("\n");
		while (
			!lines().includes("ready") &&
			!lines().some((l) => l.startsWith("never-ready")) &&
			Date.now() - t0 < START_WITHIN_MS &&
			!died
		)
			await Bun.sleep(50);
		if (!lines().includes("ready"))
			throw new Error(
				`quit harness (${tag}) did not start; no exit was sent and nothing was checked. Output: ${out.slice(0, 300) || "(none)"}`,
			);
		pids = (
			JSON.parse(lines().find((l) => l.startsWith("{")) as string) as Record<string, number[]>
		)[resource];
		const notRunning = pids.filter((p) => !running(p));
		if (pids.length === 0 || notRunning.length > 0)
			throw new Error(
				`quit harness (${tag}): not running before the exit was sent: ${notRunning.join(", ") || "no pid recorded"}`,
			);
		if (exit === "ctrl-c" || exit === "quit-command") {
			proc.stdin.write(`${exit}\n`);
			proc.stdin.flush();
		} else {
			proc.kill(exit);
		}
		return { pids, left: await allGone(pids, GONE_WITHIN_MS) };
	} finally {
		// Only recorded pids from this scenario, and the harness it started.
		for (const pid of pids) {
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
	exit: Exit;
	label: string;
	/** Faults found: the resources left running. */
	failing: Resource[];
}

const CASES: Case[] = [
	{
		exit: "quit-command",
		label: "quit command (/quit)",
		failing: ["runCommand", "mcp", "browser", "moshi"],
	},
	{ exit: "ctrl-c", label: "Ctrl-C key", failing: ["browser", "moshi"] },
	{
		exit: "SIGINT",
		label: "SIGINT to the process",
		failing: ["runCommand", "bang", "browser", "moshi", "recorder"],
	},
	{ exit: "SIGTERM", label: "SIGTERM", failing: ["browser", "moshi", "recorder"] },
	{
		exit: "SIGHUP",
		label: "SIGHUP sent to the process",
		failing: ["browser", "moshi", "recorder"],
	},
];

// Module-level await: a harness that cannot start errors the file, it never reports a pass.
// Six at a time: each is a process of its own with its own temp directory.
const outcomes = new Map<string, Outcome>();
if (live) {
	const jobs = CASES.flatMap((c) => RESOURCES.map((r) => ({ c, r })));
	// Every scenario finishes (and kills what it started) before the first failure is thrown.
	const failures: unknown[] = [];
	for (let i = 0; i < jobs.length; i += 6) {
		const settled = await Promise.allSettled(
			jobs.slice(i, i + 6).map(async ({ c, r }) => {
				outcomes.set(`${c.exit}/${r.id}`, await scenario(c.exit, r.id));
			}),
		);
		for (const r of settled) if (r.status === "rejected") failures.push(r.reason);
		if (failures.length > 0) break;
	}
	if (failures.length > 0) throw failures[0];
}

describe.skipIf(!live)("quit leaves nothing running (harness level)", () => {
	for (const c of CASES) {
		describe(c.label, () => {
			for (const r of RESOURCES) {
				const body = () => {
					expect(
						(outcomes.get(`${c.exit}/${r.id}`) as Outcome).left,
						`still running: ${r.name}`,
					).toEqual([]);
				};
				const title = `${r.name}: nothing left within ${GONE_WITHIN_MS / 1000}s`;
				if (c.failing.includes(r.id)) test.failing(`FAULT ${c.label}: ${title}`, body);
				else test(title, body);
			}
		});
	}
});
