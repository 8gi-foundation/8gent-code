// Kill-and-resume proof for the daemon (#4107). Runs on Windows CI and locally.
//
// Starts the daemon with resume-on-boot and auto-continue on, has a session
// read a file and then start a slow shell command, hard-kills the daemon
// mid-command (TerminateProcess on Windows, SIGKILL elsewhere: no shutdown
// handler runs, like a power cut or Stop-Process -Force), starts it again and
// requires that:
//   - the journal was written on this platform's paths while the command ran,
//   - the session comes back and the turn is continued and finishes,
//   - each interrupted call is handled by its replay class (#4113): the shell
//     call (class "never") is reported not replayed and ran exactly once; the
//     read (class "replay") is re-run on boot, completes, and ran twice.
//
// One reply's calls run in sequence (packages/ai/text-tool-loop.ts), so a kill
// cannot catch a read and a shell call in flight together. The read runs for
// real before the kill; after the kill this script records it as in flight
// with the daemon's own SessionJournal.markToolStart, as if the kill had landed
// during it. Everything after that is the real daemon boot.
// The model is a stub served from this process, so no model or network is used.
//
// Usage: bun scripts/ci/durable-kill-resume.ts <daemon command...>
//   e.g. bun scripts/ci/durable-kill-resume.ts .\dist\bin\8gent-windows-x64.exe daemon run
//        bun scripts/ci/durable-kill-resume.ts bun bin/8gent.ts daemon run
// KILL_RESUME_DAEMON_PORT (default 18798) and STUB_PORT (default 8191) pick the ports.
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionJournal } from "../../packages/daemon/session-journal";
import { toolReplayClass } from "../../packages/eight/tools";

// The daemon runs in its own work dir, so existing relative paths (bin/8gent.ts)
// are resolved here first.
const daemonArgv = process.argv.slice(2).map((a) => (fs.existsSync(a) ? path.resolve(a) : a));
if (daemonArgv.length === 0) {
	console.error("usage: bun scripts/ci/durable-kill-resume.ts <daemon command...>");
	process.exit(2);
}
const MODEL_PORT = Number(process.env.STUB_PORT ?? 8191);
// Its own variable: an inherited EIGHT_DAEMON_PORT could point at a real daemon.
const DAEMON_PORT = Number(process.env.KILL_RESUME_DAEMON_PORT ?? 18798);
const root = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), "kill-resume-"));
const home = path.join(root, "home");
const dataDir = path.join(home, ".8gent");
const work = path.join(root, "work");
for (const d of [dataDir, work]) fs.mkdirSync(d, { recursive: true });
const journalPath = path.join(dataDir, "sessions-journal.json");
const runsFile = path.join(work, "runs.txt");
// One command, because run_command refuses chaining: a script that records its
// start, then outlives the kill. A hard kill orphans it, so it stops itself
// when cleanup() creates work/stop, or after 120 s. Git Bash runs it on
// windows-latest (packages/core/shell.ts), sh elsewhere.
const COMMAND = "sh slow.sh";
const stopFile = path.join(work, "stop");
fs.writeFileSync(
	path.join(work, "slow.sh"),
	"echo start >> runs.txt; i=0; while [ ! -f stop ] && [ $i -lt 120 ]; do sleep 1; i=$((i+1)); done\n",
);
const RESUME_MARK = "[resume] continued-after-crash";
// The read: a file whose content proves the re-run completed and returned it.
const READ_PATH = "notes.txt";
const READ_TOKEN = `read-token-${process.pid}-${Date.now()}`;
fs.writeFileSync(path.join(work, READ_PATH), `${READ_TOKEN}\n`);
// The invariant is the replay class, not a bare count.
const SHELL_CLASS = toolReplayClass("run_command");
const READ_CLASS = toolReplayClass("read_file");
if (SHELL_CLASS !== "never")
	throw new Error(`run_command replay class is ${SHELL_CLASS}, expected never`);
if (READ_CLASS !== "replay")
	throw new Error(`read_file replay class is ${READ_CLASS}, expected replay`);
// Before the kill each call runs once; on boot a "replay" call runs again, a "never" call does not.
const expectedRuns = (cls: string) => (cls === "replay" ? 2 : 1);

const fail = (msg: string): never => {
	console.error(`FAIL: ${msg}`);
	for (const f of ["daemon-1.log", "daemon-2.log"]) {
		const p = path.join(root, f);
		if (fs.existsSync(p))
			console.error(
				`--- ${f} (last 40 lines)\n${fs.readFileSync(p, "utf8").split("\n").slice(-40).join("\n")}`,
			);
	}
	cleanup();
	process.exit(1);
};

// ----- stub model -----
let continuation = "";
const toolCall = (name: string, args: Record<string, unknown>) =>
	`\`\`\`tool_call\n${JSON.stringify({ name, arguments: args })}\n\`\`\``;
const model = Bun.serve({
	port: MODEL_PORT,
	hostname: "127.0.0.1",
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname.endsWith("/models"))
			return Response.json({ object: "list", data: [{ id: "stub", object: "model" }] });
		if (!url.pathname.endsWith("/chat/completions"))
			return new Response("not found", { status: 404 });
		const body = (await req.json()) as {
			stream?: boolean;
			messages?: Array<{ role: string; content?: unknown }>;
		};
		const msgs = body.messages ?? [];
		const text = msgs
			.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")))
			.join("\n");
		let content: string;
		if (text.includes(RESUME_MARK)) {
			continuation = text;
			content = "DONE: checked runs.txt after the restart, the command already ran once";
		} else {
			// First reply reads the file, the second starts the slow command.
			const replies = msgs.filter((m) => m.role === "assistant").length;
			content =
				replies === 0
					? toolCall("read_file", { path: READ_PATH })
					: replies === 1
						? toolCall("run_command", { command: COMMAND })
						: "DONE";
		}
		if (!body.stream) {
			return Response.json({
				id: "stub",
				object: "chat.completion",
				model: "stub",
				choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
				usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
			});
		}
		const frame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
		const stream = [
			frame({
				id: "stub",
				choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
			}),
			frame({ id: "stub", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
			"data: [DONE]\n\n",
		].join("");
		return new Response(stream, { headers: { "content-type": "text/event-stream" } });
	},
});

// ----- daemon -----
// No credentials reach the daemon, so it cannot fail over to a rented model.
const childEnv = Object.fromEntries(
	Object.entries(process.env).filter(([k]) => !/_API_KEY$|_TOKEN$/.test(k)),
);
let daemon: ChildProcess | null = null;
function startDaemon(n: number): ChildProcess {
	const log = fs.openSync(path.join(root, `daemon-${n}.log`), "w");
	const child = spawn(daemonArgv[0], daemonArgv.slice(1), {
		cwd: work,
		stdio: ["ignore", log, log],
		env: {
			...childEnv,
			// Loopback only, whatever the parent shell says (origin-guard.ts).
			DAEMON_HOSTNAME: "127.0.0.1",
			HOME: home,
			USERPROFILE: home,
			EIGHT_DATA_DIR: dataDir,
			EIGHT_TIMETRAVEL_DIR: path.join(dataDir, "timetravel"),
			EIGHT_DAEMON_PORT: String(DAEMON_PORT),
			EIGHT_RESUME_ON_BOOT: "1",
			EIGHT_AUTO_CONTINUE: "1",
			EIGHT_CHECKPOINT_EVERY: "1",
			DEFAULT_RUNTIME: "ollama",
			DEFAULT_MODEL: "stub",
			OLLAMA_HOST: `http://127.0.0.1:${MODEL_PORT}`,
			EIGHT_DECIDE_OLLAMA_HOST: "http://127.0.0.1:9",
		},
	});
	fs.closeSync(log);
	return child;
}
function cleanup() {
	try {
		daemon?.kill("SIGKILL");
	} catch {}
	try {
		fs.writeFileSync(stopFile, "");
	} catch {}
	model.stop(true);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(
	what: string,
	ms: number,
	probe: () => T | undefined | false | Promise<T | undefined | false>,
): Promise<T> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		try {
			const v = await probe();
			if (v) return v;
		} catch {}
		await sleep(250);
	}
	return fail(`timed out after ${ms / 1000}s waiting for ${what}`);
}
const health = async () => (await fetch(`http://127.0.0.1:${DAEMON_PORT}/health`)).ok;
// Only the daemon this script started counts: one that exited is a failure,
// not a reason to keep polling a port something else may answer on.
const healthy = () =>
	until("daemon /health", 60_000, () => {
		if (daemon && (daemon.exitCode !== null || daemon.signalCode !== null))
			fail(`the daemon exited early (code ${daemon.exitCode}, signal ${daemon.signalCode})`);
		return health();
	});
type JournalEntry = {
	sessionId: string;
	inFlight?: Array<{ tool: string }>;
	pendingTurn?: unknown;
};
const journal = (): JournalEntry[] =>
	JSON.parse(fs.readFileSync(journalPath, "utf8")).sessions ?? [];
// The daemon logs "  -> <tool>(" for each call the model makes (packages/eight/agent.ts).
const readCallsLogged = (n: number) =>
	(fs.readFileSync(path.join(root, `daemon-${n}.log`), "utf8").match(/-> read_file\(/g) ?? [])
		.length;
const runs = () =>
	fs.existsSync(runsFile)
		? fs
				.readFileSync(runsFile, "utf8")
				.split(/\r?\n/)
				.filter((l) => l.trim() === "start").length
		: 0;

// ----- 1. start work, wait until the command is running -----
if (await health().catch(() => false))
	fail(`something already answers /health on port ${DAEMON_PORT}; set KILL_RESUME_DAEMON_PORT`);
daemon = startDaemon(1);
await healthy();
const ws = new WebSocket(`ws://127.0.0.1:${DAEMON_PORT}`);
await until("websocket open", 10_000, () => ws.readyState === WebSocket.OPEN);
let sessionId = "";
let lastError = "";
ws.onmessage = (e) => {
	const m = JSON.parse(String(e.data));
	if (m.type === "session:created") sessionId = m.sessionId;
	if (m.type === "error") lastError = String(m.message);
};
ws.send(JSON.stringify({ type: "session:create", channel: "api" }));
await until("session:created", 10_000, () => sessionId);
// The session's 8gent is built asynchronously after session:created, so a
// prompt sent too early is refused with "session not found". Resend only then.
for (let attempt = 1; ; attempt++) {
	lastError = "";
	ws.send(JSON.stringify({ type: "prompt", text: "Record a start line in runs.txt, then wait." }));
	const outcome = await until("the prompt to be accepted or refused", 30_000, () =>
		/session not found/.test(lastError)
			? "retry"
			: runs() > 0 || journal().some((e) => e.sessionId === sessionId && e.pendingTurn)
				? "ok"
				: false,
	);
	if (outcome === "ok") break;
	if (attempt >= 20) fail("the session never accepted the prompt");
	await sleep(1_000);
}
await until("the command to start", 60_000, () => runs() === 1);
if (readCallsLogged(1) !== 1)
	fail(`expected the read to run once before the kill, saw ${readCallsLogged(1)}`);
const before = await until("the journal to record the running command", 10_000, () =>
	journal().find(
		(e) =>
			e.sessionId === sessionId &&
			e.inFlight?.some((c) => c.tool === "run_command") &&
			e.pendingTurn,
	),
);
console.log(
	`journal written at ${journalPath}: in-flight ${before.inFlight?.map((c) => c.tool).join(",")}, turn pending`,
);
ws.close();

// ----- 2. hard kill mid-command -----
const t0 = Date.now();
daemon.kill("SIGKILL");
await until(
	"the daemon to die",
	15_000,
	() => daemon?.exitCode !== null || daemon?.signalCode !== null,
);
console.log(`daemon hard-killed mid-command (${process.platform})`);
// The read as in flight, written by the daemon's own journal code (see header).
const shellCall = before.inFlight?.find((c) => c.tool === "run_command") as
	| { startedAt?: number }
	| undefined;
new SessionJournal(journalPath).markToolStart(sessionId, {
	id: "tt-read-before-kill",
	tool: "read_file",
	args: { path: READ_PATH },
	startedAt: (shellCall?.startedAt ?? Date.now()) - 1,
});
if (
	!journal()
		.find((e) => e.sessionId === sessionId)
		?.inFlight?.some((c) => c.tool === "read_file")
)
	fail("the journal did not keep the in-flight read");

// ----- 3. restart and require the work to come back and finish -----
daemon = startDaemon(2);
await healthy();
const log2 = () => fs.readFileSync(path.join(root, "daemon-2.log"), "utf8");
const restored = await until(
	"resume-on-boot to restore the session",
	30_000,
	() =>
		log2().match(/resume-on-boot: (\d+) session\(s\) restored from journal in (\d+)ms/) ??
		undefined,
);
if (restored[1] !== "1") fail(`expected 1 restored session, got ${restored[1]}`);
await until("the read re-run and the cut command reported as not replayed", 10_000, () =>
	/1 interrupted read\(s\) re-run, 1 call\(s\) not replayed/.test(log2()),
);
await until("the continuation to reach the model", 60_000, () => continuation);
if (!continuation.includes("not replayed"))
	fail("the continuation did not tell the model the command was not replayed");
// The re-run read completed: its result, with the file's content, reached the model.
if (!/read_file .*: re-run \(read only, safe to replay\)\. Result:/.test(continuation))
	fail("the continuation did not report the read as re-run");
if (!continuation.includes(READ_TOKEN)) fail("the re-run read did not return the file's content");
await until("the continued turn to finish", 60_000, () => {
	const e = journal().find((x) => x.sessionId === sessionId);
	return e && !e.pendingTurn && !(e.inFlight?.length ?? 0);
});
const count = runs();
if (count !== 1) fail(`the command ran ${count} times, expected exactly 1`);
if (count !== expectedRuns(SHELL_CLASS))
	fail(
		`run_command (class ${SHELL_CLASS}) ran ${count} times, expected ${expectedRuns(SHELL_CLASS)}`,
	);
// Once in daemon 1 (logged call), once on boot (the "re-run" line above). The
// continuation must not have asked for it a third time.
const readRuns = readCallsLogged(1) + 1 + readCallsLogged(2);
if (readRuns !== expectedRuns(READ_CLASS))
	fail(
		`read_file (class ${READ_CLASS}) ran ${readRuns} times, expected ${expectedRuns(READ_CLASS)}`,
	);
console.log(
	`PASS: session restored in ${restored[2]}ms (${Date.now() - t0}ms kill to finished), turn continued and finished; run_command (${SHELL_CLASS}) not replayed, ran ${count} time; read_file (${READ_CLASS}) re-run and completed, ran ${readRuns} times`,
);
cleanup();
// Windows keeps the work dir busy until the orphaned slow.sh sees the stop file.
try {
	fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
} catch (err) {
	console.warn(`could not remove ${root}: ${String(err)}`);
}
process.exit(0);
