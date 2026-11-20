/**
 * Child process for quit-leaves-nothing.proc.ts. It starts ONE resource (argv[3])
 * with the real code, wires the exit handlers the way apps/tui/src/app.tsx
 * wires them, and waits. The test sends the exit. One resource per process, so
 * a timer or handle of one cannot keep the process alive for another.
 *
 * Resources, all real code: runCommand (the executor of a real Agent), bang
 * (startBang), mcp (ensureConnected, as the lean MCP path does, with a stand-in
 * server), browser (wsTransport launching a stand-in app binary), moshi
 * (MoshiMLXProvider, with a stand-in python3 first on PATH) and recorder (a real
 * VoiceEngine recording through a stand-in `rec` first on PATH). The stand-ins
 * only record their pid and sleep.
 *
 * Exit handlers: killBangsOnExit, installProgramStatusCleanup, quitNow and
 * live-shells are real, and the quit command calls the real Agent.cleanup().
 * The only copies of app code are the order of calls in the quit command and in
 * the Ctrl-C key (inside the App component) and the voice hook's unmount line
 * `engine.destroy()` (inside useVoiceInput); none can be imported.
 *
 * stdout: one JSON line {"<resource>":[pid,...]} once the resource has written
 * its pid, then "ready"; or "never-ready" after 20 s.
 * argv[2]: working directory (also HOME and EIGHT_HOME). argv[3]: the resource.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "../../../../../packages/eight/agent";
import { killLiveShells } from "../../../../../packages/eight/live-shells";
import { MCPClient } from "../../../../../packages/mcp/client";
import { ensureConnected } from "../../../../../packages/mcp/lean";
import { wsTransport } from "../../../../../packages/tools/eight-browser";
import { VoiceEngine } from "../../../../../packages/voice";
import { MoshiMLXProvider } from "../../../../../packages/voice/backends/moshi-mlx";
import { killBangsOnExit, startBang } from "../../lib/bang-command";
import { installProgramStatusCleanup } from "../../lib/program-status";
import { quitNow } from "../../lib/quit";

const dir = process.argv[2] as string;
const only = process.argv[3] as string;
const file = (name: string, body: string, mode = 0o755) => {
	const f = join(dir, name);
	writeFileSync(f, body);
	chmodSync(f, mode);
	return f;
};

// The real Agent. Its tool executor runs run_command; its cleanup() is what the quit command calls.
const agent = new Agent({ model: "quit-harness", runtime: "ollama", workingDirectory: dir });
const ex = (agent as unknown as { executor: Record<string, unknown> }).executor as {
	runCommand: (c: string, t?: number) => Promise<string>;
	permissionManager: { checkPermission: () => string };
	hookManager: { executeHooks: () => Promise<void> };
};
// The tool's permission and hook layers are not under test here (as in tools-live-shell.test.ts).
ex.permissionManager.checkPermission = () => "allowed";
ex.hookManager.executeHooks = async () => {};

// A script file, because run_command refuses `;` chains and `$$` lines in its own text.
const withBackgroundJob = (tag: string) =>
	file(
		`${tag}.sh`,
		`#!/bin/sh\nsleep 302 &\necho $! > ${join(dir, `${tag}.bg`)}\necho $$ > ${join(dir, `${tag}.pid`)}\nexec sleep 300\n`,
	);

if (only === "runCommand")
	void ex
		.runCommand(`sh ${withBackgroundJob("run")}`, 600)
		.then((r) => console.log(`run_command returned: ${r.slice(0, 120)}`));
const bangs = new Set<{ cancel: () => void }>();
if (only === "bang") bangs.add(startBang(`sh ${withBackgroundJob("bang")}`, dir, 600_000));

// MCP stdio server: answers initialize and tools/list, ends when its stdin closes (a well-behaved server).
const mcpServer = file(
	"mcp-server.ts",
	`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(dir, "mcp.pid"))}, String(process.pid));
let buf = "";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
for await (const chunk of process.stdin) {
	buf += chunk;
	let i;
	while ((i = buf.indexOf("\\n")) >= 0) {
		const m = JSON.parse(buf.slice(0, i) || "{}");
		buf = buf.slice(i + 1);
		if (m.id === undefined) continue;
		if (m.method === "initialize") reply(m.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "stand-in", version: "0" } });
		else if (m.method === "tools/list") reply(m.id, { tools: [] });
	}
}
`,
	0o644,
);
mkdirSync(join(dir, ".8gent"), { recursive: true });
writeFileSync(
	join(dir, ".8gent", "mcp.json"),
	JSON.stringify({ servers: { standin: { command: process.execPath, args: [mcpServer] } } }),
);
if (only === "mcp") void ensureConnected(new MCPClient(), true, async () => null);

// 8gent Browser: a stand-in app binary that publishes the port and token files a profile needs.
const browserApp = file(
	"browser-app.sh",
	`#!/bin/sh\nd="$HOME/.8gent/browser-profiles/$EIGHT_BROWSER_PROFILE"\nmkdir -p "$d"\necho $$ > ${join(dir, "browser.pid")}\necho 51999 > "$d/browser-control.port"\necho token > "$d/browser-control.token"\nexec sleep 300\n`,
);
if (only === "browser")
	void wsTransport({
		env: {
			HOME: dir,
			PATH: process.env.PATH,
			EIGHT_BROWSER_APP: browserApp,
			EIGHT_BROWSER_PROFILE: "quitcheck",
		},
	})("ping").catch(() => {});

// moshi server: `python3 -m moshi.server` resolves to a stand-in first on PATH.
mkdirSync(join(dir, "bin"), { recursive: true });
file("bin/python3", `#!/bin/sh\necho $$ > ${join(dir, "moshi.pid")}\nexec sleep 300\n`);
// The test started this process with `${dir}/bin` first on PATH.
if (only === "moshi")
	void (new MoshiMLXProvider() as unknown as { _ensureServer: () => Promise<void> })
		._ensureServer()
		.catch(() => {});

// Microphone: a real VoiceEngine records through a stand-in `rec` found first on PATH.
file("bin/rec", `#!/bin/sh\necho $$ > ${join(dir, "recorder.pid")}\nexec sleep 300\n`);
const engine = new VoiceEngine();
if (only === "recorder") {
	engine.on("error", () => {});
	void engine.startRecording().catch(() => {});
}

const stopBangRuns = () => {
	for (const b of bangs) b.cancel();
	bangs.clear();
};

// app.tsx: useEffect(() => killBangsOnExit(...)) (the lines under "Never leave a shell command behind").
const uninstallBangs = killBangsOnExit(() => {
	stopBangRuns();
	killLiveShells("SIGKILL");
});
// app.tsx: useEffect(() => installProgramStatusCleanup(emitter)).
installProgramStatusCleanup({ clear: () => {} });

const unmount = () => {
	// Ink's exit(): React runs the effect cleanups and releases stdin.
	uninstallBangs();
	stopBangRuns();
	// useVoiceInput: useEffect(() => () => { engine.destroy() }, [engine]).
	engine.destroy().catch(() => {});
	process.stdin.pause();
	process.stdin.unref?.();
};

function read(f: string): number[] {
	const p = join(dir, f);
	return existsSync(p)
		? readFileSync(p, "utf8")
				.split("\n")
				.map((s) => Number.parseInt(s, 10))
				.filter((n) => n > 1)
		: [];
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	for (const word of chunk.split("\n")) {
		if (word === "quit-command") {
			// app.tsx case "quit": stopBangRuns(); agent.cleanup(); exit().
			stopBangRuns();
			agent.cleanup().catch(() => {});
			unmount();
		}
		if (word === "ctrl-c") {
			// app.tsx Ctrl+C: stopBangRuns(); quitNow({abortAll: abort, killLiveShells("SIGTERM"), cleanup}).
			stopBangRuns();
			quitNow({
				abortAll: () => {
					agent.abort();
					killLiveShells("SIGTERM");
					agent.cleanup().catch(() => {});
				},
				unmount,
			});
		}
	}
});

const WANT = { runCommand: 2, bang: 2, mcp: 1, browser: 1, moshi: 1, recorder: 1 }[only] ?? 0;
const files: Record<string, string[]> = {
	runCommand: ["run.pid", "run.bg"],
	bang: ["bang.pid", "bang.bg"],
	mcp: ["mcp.pid"],
	browser: ["browser.pid"],
	moshi: ["moshi.pid"],
	recorder: ["recorder.pid"],
};
const t0 = Date.now();
const wait = setInterval(() => {
	const pids = (files[only] ?? []).flatMap(read);
	if (WANT > 0 && pids.length === WANT) {
		clearInterval(wait);
		console.log(JSON.stringify({ [only]: pids }));
		console.log("ready");
	} else if (Date.now() - t0 > 20_000) {
		clearInterval(wait);
		console.log(`never-ready ${JSON.stringify(pids)}`);
	}
}, 50);
