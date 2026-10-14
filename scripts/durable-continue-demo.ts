#!/usr/bin/env bun
/**
 * kill -9 demo for durable turns (#4082).
 *
 * Starts a throwaway daemon with EIGHT_RESUME_ON_BOOT=1 and
 * EIGHT_AUTO_CONTINUE=1 on a temp data dir, sends it a multi-step task over
 * the WebSocket protocol, SIGKILLs the daemon after a few tool calls, starts
 * it again, and shows the journal and the daemon log as the interrupted turn
 * is continued without anyone typing. Only the daemon pid this script spawned
 * is ever signalled.
 *
 *   bun scripts/durable-continue-demo.ts [--model qwen3.5:9b] [--runtime ollama] [--kill-after 3]
 *
 * Needs a local model the daemon can reach (Ollama on 11434 by default).
 * Exit 0 when the second daemon journaled and ran the continuation and the
 * turn finished; 1 otherwise. Nothing is written outside the temp dirs.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bunFlagsFor } from "../packages/core/bun-flags";

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
	const i = args.indexOf(name);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const MODEL = arg("--model", process.env.DEFAULT_MODEL || "qwen3.5:9b");
const RUNTIME = arg("--runtime", process.env.DEFAULT_RUNTIME || "ollama");
const KILL_AFTER = Number(arg("--kill-after", "3"));
const TASK =
	"Create a file named lines.txt in the current directory and fill it with the numbered lines 1 to 12. Write exactly one line per tool call: twelve separate append calls. Then read the file back and report how many lines it has.";

const repo = path.resolve(import.meta.dir, "..");
const daemonEntry = path.join(repo, "packages", "daemon", "index.ts");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "durable-demo-data-"));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "durable-demo-work-"));
const port = 18900 + Math.floor(Math.random() * 500);
const journalPath = path.join(dataDir, "sessions-journal.json");
fs.writeFileSync(
	path.join(dataDir, "config.json"),
	JSON.stringify({ daemon: { heartbeatEnabled: false } }),
);

const env: Record<string, string> = {
	...(process.env as Record<string, string>),
	EIGHT_DATA_DIR: dataDir,
	EIGHT_TIMETRAVEL_DIR: path.join(dataDir, "timetravel"),
	EIGHT_DAEMON_PORT: String(port),
	EIGHT_DAEMON_LOCAL: "1",
	EIGHT_RESUME_ON_BOOT: "1",
	EIGHT_AUTO_CONTINUE: "1",
	EIGHT_AUTO_APPROVE: "1",
	EIGHT_CHECKPOINT_EVERY: "2",
	DEFAULT_MODEL: MODEL,
	DEFAULT_RUNTIME: RUNTIME,
};

// A throwaway daemon never attaches the Telegram bridge, whatever the shell has set.
delete env.EIGHT_TELEGRAM_LOCAL;
delete env.TELEGRAM_BOT_TOKEN;

const say = (line: string) => console.log(`[demo] ${line}`);

function readJournal(): string {
	try {
		const parsed = JSON.parse(fs.readFileSync(journalPath, "utf8"));
		return JSON.stringify(
			parsed.sessions.map((s: any) => ({
				sessionId: s.sessionId,
				inFlight: (s.inFlight ?? []).map((c: any) => c.tool),
				pendingTurn: s.pendingTurn
					? {
							id: s.pendingTurn.id,
							attempts: s.pendingTurn.attempts,
							text: `${s.pendingTurn.text.slice(0, 40)}...`,
						}
					: undefined,
			})),
		);
	} catch (err) {
		return `(no journal: ${String(err)})`;
	}
}

function pendingAttempts(): number | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(journalPath, "utf8"));
		return parsed.sessions[0]?.pendingTurn?.attempts;
	} catch {
		return undefined;
	}
}

interface Daemon {
	proc: ReturnType<typeof Bun.spawn>;
	log: string[];
}

async function startDaemon(label: string): Promise<Daemon> {
	const log: string[] = [];
	const proc = Bun.spawn(
		[process.execPath, ...bunFlagsFor(process.execPath), daemonEntry, "--local"],
		{
			cwd: workDir,
			env,
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const tail = async (stream: ReadableStream<Uint8Array>) => {
		let buf = "";
		for await (const chunk of stream) {
			buf += new TextDecoder().decode(chunk);
			let nl = buf.indexOf("\n");
			while (nl >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				log.push(line);
				if (/\[resume\]|\[daemon\] resume-on-boot|TIME_TRAVEL|\[agent-pool\]/.test(line)) {
					console.log(`  ${label} | ${line}`);
				}
				nl = buf.indexOf("\n");
			}
		}
	};
	tail(proc.stdout as ReadableStream<Uint8Array>);
	tail(proc.stderr as ReadableStream<Uint8Array>);
	say(`${label}: daemon pid ${proc.pid} starting on port ${port}`);
	for (let i = 0; i < 300; i++) {
		if (proc.exitCode !== null) throw new Error(`${label}: daemon exited early (${proc.exitCode})`);
		try {
			const res = await fetch(`http://127.0.0.1:${port}/health`);
			if (res.ok || res.status < 500) break;
		} catch {}
		await Bun.sleep(100);
	}
	return { proc, log };
}

function connect(): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://127.0.0.1:${port}`);
		ws.onopen = () => resolve(ws);
		ws.onerror = (e) => reject(new Error(`ws error: ${String((e as any).message ?? e)}`));
	});
}

async function waitFor(check: () => boolean, ms: number, step = 250): Promise<boolean> {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		if (check()) return true;
		await Bun.sleep(step);
	}
	return check();
}

async function main(): Promise<number> {
	say(`model=${MODEL} runtime=${RUNTIME} data=${dataDir} work=${workDir}`);

	// 1. First daemon: open a session, send the task, kill after KILL_AFTER tool calls.
	const first = await startDaemon("run-1");
	const ws = await connect();
	let sessionId = "";
	let toolStarts = 0;
	const killed = new Promise<void>((resolve) => {
		ws.onmessage = (ev) => {
			const frame = JSON.parse(String(ev.data));
			// Bus events arrive wrapped: { type: "event", event, payload }.
			const msg = frame.type === "event" ? { type: frame.event, ...frame.payload } : frame;
			if (msg.type === "session:created") {
				sessionId = msg.sessionId;
				// The pool creates the session just after replying; the journal
				// entry is the sign it exists, so the prompt never races it.
				waitFor(() => readJournal().includes(sessionId), 10_000, 50).then(() => {
					say(`run-1: session ${sessionId}, sending task`);
					ws.send(JSON.stringify({ type: "prompt", text: TASK }));
				});
			} else if (msg.type === "error" || msg.type === "agent:error") {
				say(`run-1: daemon error: ${msg.message ?? msg.error}`);
			} else if (msg.type === "tool:start") {
				toolStarts++;
				say(
					`run-1: tool call ${toolStarts}: ${msg.tool} ${JSON.stringify(msg.input ?? {}).slice(0, 80)}`,
				);
				if (toolStarts === KILL_AFTER) {
					say(`run-1: journal before kill: ${readJournal()}`);
					say(`run-1: kill -9 ${first.proc.pid} (the daemon this script started)`);
					first.proc.kill(9);
					resolve();
				}
			} else if (msg.type === "session:end") {
				say("run-1: the turn finished before the kill; raise --kill-after or use a slower task");
				first.proc.kill(9);
				resolve();
			}
		};
		ws.send(JSON.stringify({ type: "session:create", channel: "api" }));
	});
	const timer = Bun.sleep(240_000).then(() => {
		say("run-1: no tool call within 240s; killing anyway");
		first.proc.kill(9);
	});
	await Promise.race([killed, timer]);
	await first.proc.exited;
	say(`run-1: daemon exited, signal=${first.proc.signalCode}`);
	try {
		ws.close();
	} catch {}
	say(`after crash: journal ${readJournal()}`);
	if (pendingAttempts() !== 0) {
		say("FAIL: no pending turn with attempts=0 in the journal after the crash");
		return 1;
	}

	// 2. Second daemon: resume, settle, continue once.
	const second = await startDaemon("run-2");
	const continued = await waitFor(
		() => second.log.some((l) => l.includes("continued") && l.includes("[resume]")),
		30_000,
	);
	say(`after restart: journal ${readJournal()}`);
	if (!continued) {
		say("FAIL: the second daemon logged no continuation");
		second.proc.kill();
		return 1;
	}
	say(
		"run-2: continuation running (attempts=1 journaled before the run); waiting for the turn to finish",
	);
	const finished = await waitFor(() => pendingAttempts() === undefined, 300_000, 1000);
	say(`after continuation: journal ${readJournal()}`);
	const out = path.join(workDir, "lines.txt");
	say(
		`lines.txt: ${fs.existsSync(out) ? `${fs.readFileSync(out, "utf8").split("\n").filter(Boolean).length} line(s)` : "missing"}`,
	);
	second.proc.kill();
	await second.proc.exited;
	if (!finished) {
		say("FAIL: the continued turn did not finish within 300s");
		return 1;
	}
	say("PASS: the interrupted turn was journaled, continued once after kill -9, and finished");
	return 0;
}

main()
	.then((code) => process.exit(code))
	.catch((err) => {
		console.error(`[demo] ${String(err)}`);
		process.exit(1);
	});
