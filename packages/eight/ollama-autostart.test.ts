import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { offerJudge } from "./judge-install";
import {
	OLLAMA_BIND,
	type StartDeps,
	isLocalDefaultHost,
	logPath,
	pidPath,
	servicePath,
	startOllama,
	stopOllama,
} from "./ollama-autostart";

const roots: string[] = [];
const kids: number[] = [];
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), "ollama-autostart-"));
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

// Some sandboxes forbid ps. There the identity check is injected; everywhere else the real one runs.
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

/** Fake deps: nothing real starts. */
function fakes(over: Partial<StartDeps> = {}) {
	const home = tmp();
	const log = {
		spawned: [] as { bin: string; env: Record<string, string | undefined>; logFile: string }[],
		writes: {} as Record<string, string>,
		sv: [] as string[],
		sleeps: 0,
	};
	let t = 0;
	const deps: StartDeps = {
		env: { EIGHT_HOME: home, PATH: "/x", OLLAMA_HOST: "0.0.0.0:11434", HOME: home },
		find: (n) => (n === "ollama" ? "/x/ollama" : null),
		exists: () => false,
		spawnServer: (bin, env, logFile) => {
			log.spawned.push({ bin, env, logFile });
			return 4242;
		},
		sv: (a) => {
			log.sv.push(a);
			return true;
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

describe("startOllama spawn args", () => {
	test("detached serve: loopback only, cloud off, log and pid recorded", async () => {
		const { deps, log, home } = fakes();
		const r = await startOllama(deps);
		expect(r).toEqual({ ok: true, how: "spawn" });
		expect(log.spawned.length).toBe(1);
		const s = log.spawned[0];
		expect(s.bin).toBe("/x/ollama");
		// A caller's OLLAMA_HOST=0.0.0.0 must not make the server public.
		expect(s.env.OLLAMA_HOST).toBe("127.0.0.1:11434");
		expect(OLLAMA_BIND).toBe("127.0.0.1:11434");
		expect(s.env.OLLAMA_NO_CLOUD).toBe("1");
		expect(s.logFile).toBe(join(home, ".8gent", "logs", "ollama.log"));
		expect(log.writes[join(home, ".8gent", "state", "ollama.pid")]).toBe("4242\n");
	});

	test("no ollama on PATH: one plain line, nothing spawned", async () => {
		const { deps, log } = fakes({ find: () => null });
		const r = await startOllama(deps);
		expect(r.ok).toBe(false);
		expect(log.spawned).toEqual([]);
	});

	test("a spawn that throws or has no pid is a failure, no pid file", async () => {
		for (const spawnServer of [
			() => {
				throw new Error("EACCES");
			},
			() => undefined,
		]) {
			const { deps, log } = fakes({ spawnServer });
			const r = await startOllama(deps);
			expect(r.ok).toBe(false);
			expect(log.writes).toEqual({});
		}
	});
});

describe("the 10 s wait", () => {
	test("times out after 10 s on a server that never answers, with one line naming the log", async () => {
		const { deps, log, home } = fakes({
			fetchImpl: async () => new Response("no", { status: 503 }),
		});
		const r = await startOllama(deps);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.line).toBe(
				`Ollama did not answer within 10 s. Its log is ${join(home, ".8gent", "logs", "ollama.log")}.`,
			);
		}
		expect(log.sleeps).toBe(40);
	});

	test("a real fake server that comes up late is found inside the window", async () => {
		let ready = false;
		const srv = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (req) =>
				new URL(req.url).pathname === "/api/tags" && ready
					? Response.json({ models: [] })
					: new Response("starting", { status: 503 }),
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
			const r = await startOllama(deps);
			expect(r.ok).toBe(true);
			expect(Date.now() - t0).toBeLessThan(5000);
		} finally {
			srv.stop(true);
		}
	});
});

describe("termux-services", () => {
	const termux = (over: Partial<StartDeps> = {}) =>
		fakes({
			platform: "android",
			env: { EIGHT_HOME: "", PATH: "/x", PREFIX: "/data/data/com.termux/files/usr" },
			find: (n) => (n === "ollama" ? "/x/ollama" : n === "sv" ? "/x/sv" : null),
			exists: (p) => p === "/data/data/com.termux/files/usr/var/service/ollama",
			...over,
		});

	test("service present: sv up ollama, no spawn, marker written", async () => {
		const t = termux();
		t.deps.env = { ...t.deps.env, EIGHT_HOME: t.home };
		const r = await startOllama(t.deps);
		expect(r).toEqual({ ok: true, how: "service" });
		expect(t.log.sv).toEqual(["up"]);
		expect(t.log.spawned).toEqual([]);
		expect(Object.keys(t.log.writes)).toEqual([servicePath(t.deps.env)]);
	});

	test("sv up fails: falls back to the detached spawn", async () => {
		const t = termux({ sv: () => false });
		t.deps.env = { ...t.deps.env, EIGHT_HOME: t.home };
		const r = await startOllama(t.deps);
		expect(r).toEqual({ ok: true, how: "spawn" });
		expect(t.log.spawned.length).toBe(1);
	});

	test("termux but no ollama service, or no sv: plain spawn", async () => {
		for (const over of [
			{ exists: () => false },
			{ find: (n: string) => (n === "ollama" ? "/x/ollama" : null) },
		]) {
			const t = termux(over);
			t.deps.env = { ...t.deps.env, EIGHT_HOME: t.home };
			expect((await startOllama(t.deps)).ok).toBe(true);
			expect(t.log.sv).toEqual([]);
			expect(t.log.spawned.length).toBe(1);
		}
	});

	test("desktop never touches sv even if a service dir exists", async () => {
		const { deps, log } = fakes({
			platform: "darwin",
			exists: () => true,
			find: () => "/x/ollama",
		});
		await startOllama(deps);
		expect(log.sv).toEqual([]);
		expect(log.spawned.length).toBe(1);
	});

	test("/ollama stop on a service we started is sv down and clears the marker", () => {
		const removed: string[] = [];
		const sv: string[] = [];
		const line = stopOllama({
			env: { EIGHT_HOME: "/h" },
			read: (p) => (p === servicePath({ EIGHT_HOME: "/h" }) ? "ollama\n" : null),
			remove: (p) => removed.push(p),
			sv: (a) => {
				sv.push(a);
				return true;
			},
		});
		expect(sv).toEqual(["down"]);
		expect(removed).toEqual([servicePath({ EIGHT_HOME: "/h" })]);
		expect(line).toContain("Stopped the Ollama service");
	});
});

test("a pid that cannot be checked is not signalled", () => {
	const kills: number[] = [];
	const line = stopOllama({
		env: { EIGHT_HOME: "/h" },
		read: (p) => (p === pidPath({ EIGHT_HOME: "/h" }) ? "4242\n" : null),
		alive: () => true,
		isOllama: () => null,
		kill: (p) => kills.push(p),
	});
	expect(kills).toEqual([]);
	expect(line).toContain("kill 4242");
});

describe("isLocalDefaultHost", () => {
	test("only this machine's default port", () => {
		expect(isLocalDefaultHost("http://localhost:11434")).toBe(true);
		expect(isLocalDefaultHost("http://127.0.0.1:11434")).toBe(true);
		expect(isLocalDefaultHost("http://gpu-box:11434")).toBe(false);
		expect(isLocalDefaultHost("http://127.0.0.1:21434")).toBe(false);
		expect(isLocalDefaultHost("nonsense")).toBe(false);
	});
});

describe("real spawn, real pid file, /ollama stop kills only our pid", () => {
	function fakeOllama(dir: string) {
		const bin = join(dir, "bin");
		mkdirSync(bin, { recursive: true });
		const script = join(bin, "ollama");
		// Records how it was started, then idles until TERM. Not an exec: its command line stays "ollama serve".
		writeFileSync(
			script,
			`#!/bin/sh\n{ echo "ARGS=$*"; echo "OLLAMA_HOST=$OLLAMA_HOST"; echo "OLLAMA_NO_CLOUD=$OLLAMA_NO_CLOUD"; } > "${dir}/seen"\ntrap 'kill $!; exit 0' TERM\nsleep 300 &\nwait\n`,
		);
		chmodSync(script, 0o755);
		return bin;
	}
	const decoy = (cmd: string[]) => {
		const c = spawn(cmd[0], cmd.slice(1), { stdio: "ignore", detached: true });
		c.unref();
		kids.push(c.pid as number);
		return c.pid as number;
	};

	test("production call shape: offerJudge(auto) asks, starts the detached server, stop ends only that pid", async () => {
		const dir = tmp();
		const bin = fakeOllama(dir);
		const env = {
			EIGHT_HOME: dir,
			HOME: dir,
			PATH: `${bin}:${process.env.PATH}`,
			OLLAMA_HOST: "0.0.0.0:9",
		};
		// Bystanders that must survive: an unrelated process and an ollama-named one we did not start.
		const bystander = decoy(["sleep", "300"]);
		const namedBystander = decoy([join(bin, "ollama")]);

		let ready = false;
		const srv = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => (ready ? Response.json({ models: [] }) : new Response("x", { status: 503 })),
		});
		try {
			const said: string[] = [];
			const asked: string[] = [];
			let probes = 0;
			const out = await offerJudge("auto", {
				env,
				probe: async () =>
					++probes > 1 ? { backend: "ollama", model: "m" } : { backend: "none", model: null },
				ollama: async () => "installed",
				ask: async (l) => {
					asked.push(l);
					return l.startsWith("Start Ollama");
				},
				pull: async () => {},
				say: (l) => said.push(l),
				readChoice: () => null,
				writeChoice: () => true,
				// Same call the default makes, with only the probe address pointed at the fake server.
				startOllama: async () => {
					setTimeout(() => {
						ready = true;
					}, 400);
					return startOllama({ env, baseUrl: `http://127.0.0.1:${srv.port}` });
				},
			});
			expect(asked[0]).toBe("Start Ollama in the background now? [Y/n]");
			expect(out).toBe("declined"); // reached the judge question, which the stub declined
			expect(said[0]).toBe("Starting Ollama in the background.");

			const pidFile = pidPath(env);
			expect(existsSync(pidFile)).toBe(true);
			expect(statSync(pidFile).mode & 0o777).toBe(0o600);
			const ours = Number(readFileSync(pidFile, "utf-8").trim());
			kids.push(ours);
			expect(ours).toBeGreaterThan(1);
			expect(alive(ours)).toBe(true);

			expect(await until(() => existsSync(join(dir, "seen")))).toBe(true);
			const seen = readFileSync(join(dir, "seen"), "utf-8");
			expect(seen).toContain("ARGS=serve");
			expect(seen).toContain("OLLAMA_HOST=127.0.0.1:11434");
			expect(seen).toContain("OLLAMA_NO_CLOUD=1");
			expect(existsSync(logPath(env))).toBe(true);

			const line = stopOllama({ env, isOllama: psWorks ? undefined : (p) => p === ours });
			expect(line).toBe(`Stopped the Ollama 8gent started (pid ${ours}).`);
			expect(await until(() => !alive(ours))).toBe(true);
			expect(alive(bystander)).toBe(true);
			expect(alive(namedBystander)).toBe(true);
			expect(existsSync(pidFile)).toBe(false);
			expect(stopOllama({ env })).toBe("8gent did not start Ollama, so there is nothing to stop.");
		} finally {
			srv.stop(true);
		}
	});

	test("a recorded pid that is no longer ollama is left alone", () => {
		const dir = tmp();
		const env = { EIGHT_HOME: dir };
		const other = decoy(["sleep", "300"]);
		mkdirSync(join(dir, ".8gent", "state"), { recursive: true });
		writeFileSync(pidPath(env), `${other}\n`);
		const line = stopOllama({ env, isOllama: psWorks ? undefined : () => false });
		expect(line).toContain("no longer Ollama");
		expect(alive(other)).toBe(true);
		expect(existsSync(pidPath(env))).toBe(false);
	});

	test("garbage, pid 1 and a dead pid never reach kill", () => {
		for (const raw of ["abc\n", "1\n", "0\n", "-5\n", "99999999\n"]) {
			const kills: number[] = [];
			const removed: string[] = [];
			const line = stopOllama({
				env: { EIGHT_HOME: "/h" },
				read: (p) => (p === pidPath({ EIGHT_HOME: "/h" }) ? raw : null),
				remove: (p) => removed.push(p),
				alive: () => false,
				kill: (p) => kills.push(p),
			});
			expect(kills).toEqual([]);
			expect(removed).toEqual([pidPath({ EIGHT_HOME: "/h" })]);
			expect(line.length).toBeGreaterThan(0);
		}
	});
});
