import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	closeSync,
	existsSync,
	constants as fsc,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLAMA_PORT, LLAMA_URL } from "../decide/backends/llamaserver";
import { JUDGE_MODEL } from "../decide/judge-model";
import {
	type ProcInfo,
	type RunRecord,
	type StartDeps,
	isLocalDefaultHost,
	isOurs,
	keyPath,
	llamaServerArgs,
	logPath,
	openPrivate,
	parseRecord,
	pidPath,
	runtimeEnv,
	startLlamaServer,
	startOllama,
	stopLocal,
} from "./local-runtime";

const roots: string[] = [];
const kids: number[] = [];
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), "local-runtime-"));
	roots.push(d);
	return d;
};
afterAll(() => {
	for (const p of kids)
		try {
			process.kill(p, "SIGKILL");
		} catch {}
	for (const d of roots) rmSync(d, { recursive: true, force: true });
});

// Some sandboxes forbid ps. There the process lookup is injected; everywhere else the real one runs.
const psWorks = !spawnSync("ps", ["-p", String(process.pid), "-o", "command="]).error;
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const until = async (f: () => boolean, ms = 3000) => {
	const end = Date.now() + ms;
	while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
	return f();
};

const HOSTILE = {
	PATH: "/usr/bin",
	HOME: "/h",
	LANG: "C",
	OLLAMA_HOST: "0.0.0.0:11434",
	OLLAMA_ORIGINS: "*",
	OLLAMA_DEBUG: "1",
	OLLAMA_MODELS: "/models",
	OLLAMA_NO_CLOUD: "0",
	LLAMA_ARG_HOST: "0.0.0.0",
	LLAMA_ARG_ENDPOINT_METRICS: "1",
	LLAMA_ARG_ENDPOINT_SLOTS: "1",
	LLAMA_API_KEY: "secret",
	OPENAI_API_KEY: "sk-secret",
	LD_PRELOAD: "/evil.so",
};

/** Fake deps: nothing real starts. */
function fakes(over: Partial<StartDeps> = {}) {
	const home = tmp();
	const log = {
		spawned: [] as { bin: string; args: string[]; env: Record<string, string>; logFile: string }[],
		writes: {} as Record<string, string>,
		sleeps: 0,
	};
	let t = 1_000_000;
	const deps: StartDeps = {
		env: { ...HOSTILE, EIGHT_HOME: home },
		platform: "darwin",
		alive: () => true,
		makeKey: () => "test-key",
		find: (n) => (n === "ollama" ? "/x/ollama" : null),
		spawnServer: (bin, args, env, logFile) => {
			log.spawned.push({ bin, args, env, logFile });
			return 4242;
		},
		fetchImpl: async () => new Response("{}", { status: 200 }),
		sleep: async (ms) => {
			log.sleeps++;
			t += ms;
		},
		now: () => t,
		write: (p, text) => {
			log.writes[p] = text;
		},
		...over,
	};
	return { deps, log, home };
}

describe("environment allowlist", () => {
	test("llama-server inherits nothing that can change what it listens on or logs", () => {
		const env = runtimeEnv(HOSTILE, "llama-server", "darwin");
		expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "PATH"]);
	});

	test("ollama gets its models dir, loopback and no cloud, and none of the dangerous variables", () => {
		const env = runtimeEnv(HOSTILE, "ollama", "darwin");
		expect(env.OLLAMA_HOST).toBe("127.0.0.1:11434");
		expect(env.OLLAMA_NO_CLOUD).toBe("1");
		expect(env.OLLAMA_MODELS).toBe("/models");
		expect(env.OLLAMA_ORIGINS).toBeUndefined();
		expect(env.OLLAMA_DEBUG).toBeUndefined();
		expect(env.OPENAI_API_KEY).toBeUndefined();
		expect(env.LD_PRELOAD).toBeUndefined();
	});

	test("on Android the Termux variables pass, LD_PRELOAD included, still no LLAMA_ARG_*", () => {
		const env = runtimeEnv(
			{ ...HOSTILE, TERMUX_VERSION: "0.118", PREFIX: "/p" },
			"llama-server",
			"linux",
		);
		expect(env.LD_PRELOAD).toBe("/evil.so");
		expect(env.PREFIX).toBe("/p");
		expect(Object.keys(env).some((k) => k.startsWith("LLAMA_"))).toBe(false);
	});
});

describe("llama-server start", () => {
	test("args: loopback, the fixed port, one slot, no slots endpoint, no metrics, a key file", () => {
		const a = llamaServerArgs("/m/judge.gguf", "/s/llama-server.key");
		expect(a).toEqual([
			"-m",
			"/m/judge.gguf",
			"--host",
			"127.0.0.1",
			"--port",
			String(LLAMA_PORT),
			"-c",
			"4096",
			"-np",
			"1",
			"--no-slots",
			"--api-key-file",
			"/s/llama-server.key",
		]);
		expect(LLAMA_PORT).toBe(8091);
		for (const bad of ["0.0.0.0", "--metrics", "--props", "-hf", "--api-key "]) {
			expect(a.join(" ")).not.toContain(bad);
		}
	});

	test("spawns with those args and the allowlisted env, and records pid, bin, start, port, model, gguf", async () => {
		const { deps, log, home } = fakes();
		const r = await startLlamaServer("/b/llama-server", "/m/j.gguf", JUDGE_MODEL, deps);
		expect(r).toEqual({ ok: true });
		const s = log.spawned[0];
		expect(s.bin).toBe("/b/llama-server");
		const keyFile = join(home, ".8gent", "state", "llama-server.key");
		expect(s.args).toEqual(llamaServerArgs("/m/j.gguf", keyFile));
		// The key is in a 0600 file we wrote, never on the command line.
		expect(log.writes[keyFile]).toBe("test-key\n");
		expect(s.args.join(" ")).not.toContain("test-key");
		expect(Object.keys(s.env).sort()).toEqual(["HOME", "LANG", "PATH"]);
		expect(s.logFile).toBe(join(home, ".8gent", "logs", "llama-server.log"));
		const rec = JSON.parse(
			log.writes[join(home, ".8gent", "state", "llama-server.pid")],
		) as RunRecord;
		expect(rec).toMatchObject({
			pid: 4242,
			bin: "/b/llama-server",
			port: LLAMA_PORT,
			model: JUDGE_MODEL,
			gguf: "/m/j.gguf",
			keyFile,
		});
		expect(rec.startMs).toBe(1_000_000);
	});

	test("waits on /health: 503 while loading, then ok; a real fake server that comes up late", async () => {
		let ready = false;
		const seen: string[] = [];
		const srv = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (req) => {
				seen.push(new URL(req.url).pathname);
				return new URL(req.url).pathname === "/health" && ready
					? Response.json({ status: "ok" })
					: new Response("loading", { status: 503 });
			},
		});
		try {
			setTimeout(() => {
				ready = true;
			}, 700);
			const { deps } = fakes({
				baseUrl: `http://127.0.0.1:${srv.port}`,
				fetchImpl: undefined,
				sleep: undefined,
				now: undefined,
			});
			const t0 = Date.now();
			const r = await startLlamaServer("/b/llama-server", "/m/j.gguf", JUDGE_MODEL, deps);
			expect(r.ok).toBe(true);
			expect(Date.now() - t0).toBeLessThan(5000);
			expect(seen.every((p) => p === "/health")).toBe(true);
			expect(seen.length).toBeGreaterThan(1);
		} finally {
			srv.stop(true);
		}
	});

	test("never answers: gives up at the deadline with one line naming the log", async () => {
		const { deps, log, home } = fakes({
			waitMs: 10_000,
			fetchImpl: async () => new Response("no", { status: 503 }),
		});
		const r = await startLlamaServer("/b/llama-server", "/m/j.gguf", JUDGE_MODEL, deps);
		expect(r).toEqual({
			ok: false,
			line: `llama-server did not answer within 10 s. Its log is ${join(home, ".8gent", "logs", "llama-server.log")}.`,
		});
		expect(log.sleeps).toBe(40);
	});

	test("a server that exits at once is reported at once, not after the wait", async () => {
		const { deps, log, home } = fakes({
			alive: () => false,
			fetchImpl: async () => new Response("no", { status: 503 }),
		});
		const r = await startLlamaServer("/b/llama-server", "/m/j.gguf", JUDGE_MODEL, deps);
		expect(r).toEqual({
			ok: false,
			line: `llama-server exited right after starting. Its log is ${join(home, ".8gent", "logs", "llama-server.log")}.`,
		});
		expect(log.sleeps).toBe(0);
	});

	test("a spawn that throws or has no pid is a failure with no record", async () => {
		for (const spawnServer of [
			() => {
				throw new Error("EACCES");
			},
			() => undefined,
		]) {
			const { deps, log } = fakes({ spawnServer });
			const r = await startLlamaServer("/b/llama-server", "/m/j.gguf", JUDGE_MODEL, deps);
			expect(r.ok).toBe(false);
			expect(Object.keys(log.writes).every((k) => k.endsWith(".key"))).toBe(true);
		}
	});
});

describe("ollama fallback start", () => {
	test("detached serve: loopback and cloud off whatever the caller exported, models dir kept", async () => {
		const { deps, log, home } = fakes();
		const r = await startOllama(deps);
		expect(r).toEqual({ ok: true });
		const s = log.spawned[0];
		expect(s.bin).toBe("/x/ollama");
		expect(s.args).toEqual(["serve"]);
		expect(s.env.OLLAMA_HOST).toBe("127.0.0.1:11434");
		expect(s.env.OLLAMA_NO_CLOUD).toBe("1");
		expect(s.env.OLLAMA_MODELS).toBe("/models");
		expect(s.env.OLLAMA_ORIGINS).toBeUndefined();
		expect(s.env.OLLAMA_DEBUG).toBeUndefined();
		expect(s.logFile).toBe(join(home, ".8gent", "logs", "ollama.log"));
		expect(JSON.parse(log.writes[join(home, ".8gent", "state", "ollama.pid")])).toMatchObject({
			pid: 4242,
			bin: "/x/ollama",
		});
	});

	test("no ollama on PATH: one plain line, nothing spawned", async () => {
		const { deps, log } = fakes({ find: () => null });
		expect((await startOllama(deps)).ok).toBe(false);
		expect(log.spawned).toEqual([]);
	});

	test("10 s wait on /api/tags, then one line", async () => {
		const urls: string[] = [];
		const { deps, log } = fakes({
			fetchImpl: async (u) => {
				urls.push(u);
				return new Response("no", { status: 503 });
			},
		});
		const r = await startOllama(deps);
		expect(r.ok).toBe(false);
		expect(log.sleeps).toBe(40);
		expect(urls[0]).toBe("http://127.0.0.1:11434/api/tags");
	});

	test("isLocalDefaultHost: only this machine's default port", () => {
		expect(isLocalDefaultHost("http://localhost:11434")).toBe(true);
		expect(isLocalDefaultHost("http://gpu-box:11434")).toBe(false);
		expect(isLocalDefaultHost("http://127.0.0.1:21434")).toBe(false);
		expect(isLocalDefaultHost("nonsense")).toBe(false);
	});
});

describe("pid and log files: O_NOFOLLOW and 0600", () => {
	test("a symlinked log is refused and its target is untouched", () => {
		const dir = tmp();
		const victim = join(dir, "victim.txt");
		writeFileSync(victim, "keep");
		const link = join(dir, "x.log");
		symlinkSync(victim, link);
		expect(() => openPrivate(link, fsc.O_WRONLY | fsc.O_APPEND)).toThrow();
		expect(readFileSync(victim, "utf-8")).toBe("keep");
	});

	test("an existing file with wider rights is tightened to 0600, not only a new one", () => {
		const dir = tmp();
		const f = join(dir, "state", "ollama.pid");
		mkdirSync(join(dir, "state"));
		writeFileSync(f, "old", { mode: 0o644 });
		chmodSync(f, 0o644);
		closeSync(openPrivate(f, fsc.O_WRONLY));
		expect(statSync(f).mode & 0o777).toBe(0o600);
	});

	test("a directory is not a file we will write", () => {
		expect(() => openPrivate(tmp(), fsc.O_RDONLY)).toThrow();
	});
});

describe("stop identity", () => {
	const rec: RunRecord = { pid: 777, bin: "/home/u/.8gent/bin/llama-server", startMs: 1_000_000 };
	const argv = (...a: string[]): ProcInfo => ({ argv: a, startMs: 999_000 });

	test("isOurs: the exact binary, argv[0] or an interpreter's argv[1], started just before the record", () => {
		expect(isOurs(rec, argv(rec.bin, "-m", "x"))).toBe(true);
		expect(isOurs(rec, argv("/bin/sh", rec.bin, "serve"))).toBe(true);
		expect(isOurs(rec, { argv: [rec.bin], startMs: null })).toBe(true);
	});

	test("isOurs: a substring is not a match", () => {
		expect(isOurs(rec, argv("/usr/bin/not-llama-server-at-all"))).toBe(false);
		expect(isOurs(rec, argv("/opt/ollama-notes", "serve"))).toBe(false);
		expect(isOurs(rec, argv("vim", "/home/u/.8gent/bin/llama-server.log"))).toBe(false);
		expect(isOurs(rec, argv("/x", "/y", rec.bin))).toBe(false);
		expect(isOurs(rec, { argv: null, startMs: 999_000 })).toBe(false);
	});

	test("isOurs: the same path started long after the record is a reused pid", () => {
		expect(isOurs(rec, { argv: [rec.bin], startMs: 1_000_000 + 60_000 })).toBe(false);
		expect(isOurs(rec, { argv: [rec.bin], startMs: 1_000_000 - 3_600_000 })).toBe(false);
	});

	function stop(raw: string | null, proc: ProcInfo | null | "unknown") {
		const kills: number[] = [];
		const removed: string[] = [];
		const env = { EIGHT_HOME: "/h" };
		const lines = stopLocal({
			env,
			read: (p) => (p === pidPath("llama-server", env) ? raw : null),
			remove: (p) => removed.push(p),
			proc: () => proc,
			kill: (p) => kills.push(p),
		});
		return { kills, removed, lines };
	}

	test("ours: signalled once, record removed", () => {
		const r = stop(JSON.stringify(rec), argv(rec.bin));
		expect(r.kills).toEqual([777]);
		expect(r.lines).toEqual(["Stopped the llama-server 8gent started (pid 777)."]);
		// The pid record and the key file both go.
		expect(r.removed).toEqual([
			pidPath("llama-server", { EIGHT_HOME: "/h" }),
			keyPath({ EIGHT_HOME: "/h" }),
		]);
	});

	test("not ours, dead, unverifiable, garbage: never signalled", () => {
		expect(stop(JSON.stringify(rec), argv("/usr/bin/python3")).kills).toEqual([]);
		expect(stop(JSON.stringify(rec), null).kills).toEqual([]);
		const unknown = stop(JSON.stringify(rec), "unknown");
		expect(unknown.kills).toEqual([]);
		expect(unknown.lines[0]).toContain("kill 777");
		expect(unknown.removed).toEqual([]);
		for (const raw of [
			"abc",
			"4242\n",
			JSON.stringify({ ...rec, pid: 1 }),
			JSON.stringify({ ...rec, pid: -5 }),
			"{}",
		]) {
			const g = stop(raw, argv(rec.bin));
			expect(g.kills).toEqual([]);
			expect(g.removed.length).toBe(2);
		}
	});

	test("nothing recorded: says so", () => {
		expect(stop(null, null).lines).toEqual([
			"8gent did not start a local model server, so there is nothing to stop.",
		]);
	});

	test("parseRecord needs pid, bin and a start time", () => {
		expect(parseRecord(JSON.stringify(rec))).toMatchObject({ pid: 777 });
		expect(parseRecord(JSON.stringify({ pid: 5, bin: "x" }))).toBeNull();
		expect(parseRecord(null)).toBeNull();
	});
});

describe("real spawn, real files: production call shape", () => {
	function fakeServer(dir: string, name: string) {
		const bin = join(dir, "bin");
		mkdirSync(bin, { recursive: true });
		const script = join(bin, name);
		// Records how it was started, then idles until TERM. Not an exec: its command line stays the script.
		writeFileSync(
			script,
			`#!/bin/sh\n[ $# -gt 0 ] && { echo "ARGS=$*"; env; } > "${dir}/seen"\ntrap 'kill $!; exit 0' TERM\nsleep 300 &\nwait\n`,
		);
		chmodSync(script, 0o755);
		return script;
	}
	const decoy = (cmd: string[]) => {
		const c = spawn(cmd[0], cmd.slice(1), { stdio: "ignore", detached: true });
		c.unref();
		kids.push(c.pid as number);
		return c.pid as number;
	};

	test("llama-server: allowlisted env, exact args, 0600 log and record, stop ends only our pid", async () => {
		const dir = tmp();
		const script = fakeServer(dir, "llama-server");
		const env = { ...HOSTILE, EIGHT_HOME: dir, HOME: dir, PATH: process.env.PATH };
		const bystander = decoy(["sleep", "300"]);
		const namedBystander = decoy([script]);

		// A pre-existing, too-open log must come out 0600.
		mkdirSync(join(dir, ".8gent", "logs"), { recursive: true });
		writeFileSync(logPath("llama-server", env), "old\n", { mode: 0o644 });
		chmodSync(logPath("llama-server", env), 0o644);

		let ready = false;
		const srv = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => (ready ? Response.json({ status: "ok" }) : new Response("x", { status: 503 })),
		});
		try {
			setTimeout(() => {
				ready = true;
			}, 400);
			const r = await startLlamaServer(script, "/m/judge.gguf", JUDGE_MODEL, {
				env,
				platform: "darwin",
				baseUrl: `http://127.0.0.1:${srv.port}`,
			});
			expect(r).toEqual({ ok: true });

			const pidFile = pidPath("llama-server", env);
			expect(statSync(pidFile).mode & 0o777).toBe(0o600);
			expect(statSync(logPath("llama-server", env)).mode & 0o777).toBe(0o600);
			expect(statSync(keyPath(env)).mode & 0o777).toBe(0o600);
			const rec = parseRecord(readFileSync(pidFile, "utf-8")) as RunRecord;
			kids.push(rec.pid);
			expect(alive(rec.pid)).toBe(true);

			expect(await until(() => existsSync(join(dir, "seen")))).toBe(true);
			const seen = readFileSync(join(dir, "seen"), "utf-8");
			expect(seen).toContain(`ARGS=${llamaServerArgs("/m/judge.gguf", keyPath(env)).join(" ")}`);
			for (const leaked of [
				"LLAMA_ARG_HOST",
				"LLAMA_API_KEY",
				"OLLAMA_ORIGINS",
				"OPENAI_API_KEY",
				"LD_PRELOAD",
			]) {
				expect(seen).not.toContain(leaked);
			}

			const proc = psWorks
				? undefined
				: (pid: number): ProcInfo | null =>
						pid === rec.pid ? { argv: ["/bin/sh", script], startMs: rec.startMs - 300 } : null;
			const lines = stopLocal({ env, proc });
			expect(lines).toEqual([`Stopped the llama-server 8gent started (pid ${rec.pid}).`]);
			expect(await until(() => !alive(rec.pid))).toBe(true);
			expect(alive(bystander)).toBe(true);
			expect(alive(namedBystander)).toBe(true);
			expect(existsSync(pidFile)).toBe(false);
			expect(existsSync(keyPath(env))).toBe(false);
		} finally {
			srv.stop(true);
		}
	});

	test("a symlinked log makes the start fail and the symlink target is not written", async () => {
		const dir = tmp();
		const script = fakeServer(dir, "llama-server");
		const env = { EIGHT_HOME: dir, HOME: dir, PATH: process.env.PATH };
		const victim = join(dir, "victim.txt");
		writeFileSync(victim, "keep");
		mkdirSync(join(dir, ".8gent", "logs"), { recursive: true });
		symlinkSync(victim, logPath("llama-server", env));
		const r = await startLlamaServer(script, "/m/j.gguf", JUDGE_MODEL, {
			env,
			platform: "darwin",
			waitMs: 200,
		});
		expect(r.ok).toBe(false);
		expect(readFileSync(victim, "utf-8")).toBe("keep");
		expect(existsSync(pidPath("llama-server", env))).toBe(false);
	});
});

test("LLAMA_URL is loopback on the fixed port", () => {
	expect(LLAMA_URL).toBe("http://127.0.0.1:8091");
});
