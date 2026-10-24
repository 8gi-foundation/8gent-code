/**
 * Start a local model server in the background, and stop only what we started (#4906).
 *
 * On a phone there is one terminal. A server that takes it over means 8gent cannot be
 * launched. So the server is started detached: loopback only, an allowlisted
 * environment, log under ~/.8gent/logs, a record under ~/.8gent/state.
 *
 * llama-server (llama.cpp) is the default runtime. Ollama stays as a fallback for a
 * person who already has it. We do not start a person's own service (`sv up`): its bind
 * address and settings are not ours to check, so we start the server ourselves.
 *
 * Every side effect is injected so tests never start a real server. Stop signals only the
 * recorded pid, after the process's command line and start time match what we launched.
 * Never pkill, never a name match.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	closeSync,
	fchmodSync,
	constants as fsc,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveHome } from "../core/home";
import { LLAMA_HOST, LLAMA_PORT, LLAMA_URL } from "../decide/backends/llamaserver";
import { findOnPath, isAndroidHost } from "../voice/termux";

type Env = Record<string, string | undefined>;
export type RuntimeKind = "llama-server" | "ollama";

/** What Ollama binds to: loopback only, whatever the caller's OLLAMA_HOST says. */
export const OLLAMA_BIND = "127.0.0.1:11434";
export const OLLAMA_PROBE_URL = `http://${OLLAMA_BIND}`;
export const OLLAMA_WAIT_MS = 10_000;
/** A 4.9 GB model loading from phone storage takes a while; /health answers 503 until it is in. */
export const LLAMA_WAIT_MS = 120_000;
export const ollamaStartAsk = (defaultYes = true): string =>
	`Start Ollama in the background now? ${defaultYes ? "[Y/n]" : "[y/N]"}`;

export { LLAMA_HOST, LLAMA_PORT, LLAMA_URL };

const eightDir = (env: Env) => join(resolveHome(env), ".8gent");
export const logPath = (kind: RuntimeKind, env: Env = process.env) =>
	join(eightDir(env), "logs", `${kind}.log`);
export const pidPath = (kind: RuntimeKind, env: Env = process.env) =>
	join(eightDir(env), "state", `${kind}.pid`);
/** The per-start API key llama-server is launched with; mode 0600, removed with the pid file. */
export const keyPath = (env: Env = process.env) => join(eightDir(env), "state", "llama-server.key");
/** Where 8gent keeps the llama-server it downloaded. */
export const managedLlamaServer = (env: Env = process.env) =>
	join(eightDir(env), "bin", "llama-server");

// ── environment ──────────────────────────────────────────────────────────

/**
 * The only variables a started server inherits. Everything else is dropped on purpose:
 * OLLAMA_ORIGINS=* would let any web page call the server, OLLAMA_DEBUG=1 writes prompts
 * to the log, and llama-server reads LLAMA_ARG_* and LLAMA_API_KEY (host, port, key,
 * metrics, slots) from the environment. Nothing from the person's env may change what we
 * listen on or log. LD_PRELOAD is kept on Android only, where Termux needs it to exec.
 */
const ENV_ALLOW = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "TZ"] as const;
const ENV_ALLOW_ANDROID = [
	"PREFIX",
	"TERMUX_VERSION",
	"LD_LIBRARY_PATH",
	"LD_PRELOAD",
	"ANDROID_ROOT",
	"ANDROID_DATA",
] as const;
/** Ollama also needs to find the person's models. */
const ENV_ALLOW_OLLAMA = ["OLLAMA_MODELS"] as const;

export function runtimeEnv(
	env: Env,
	kind: RuntimeKind,
	platform: string = process.platform,
): Record<string, string> {
	const keys: string[] = [...ENV_ALLOW];
	if (isAndroidHost(platform, env)) keys.push(...ENV_ALLOW_ANDROID);
	if (kind === "ollama") keys.push(...ENV_ALLOW_OLLAMA);
	const out: Record<string, string> = {};
	for (const k of keys) if (env[k] !== undefined) out[k] = env[k] as string;
	if (kind === "ollama") {
		out.OLLAMA_HOST = OLLAMA_BIND;
		out.OLLAMA_NO_CLOUD = "1";
	}
	return out;
}

/**
 * Arguments are ours alone: loopback, a fixed port, one slot, no slots endpoint, no metrics,
 * and a key we generate for this start (llama-server otherwise answers any web page: its
 * CORS allows every origin). /health is public by design, everything else needs the key.
 */
export function llamaServerArgs(gguf: string, keyFile: string): string[] {
	return [
		"-m",
		gguf,
		"--host",
		LLAMA_HOST,
		"--port",
		String(LLAMA_PORT),
		"-c",
		"4096",
		"-np",
		"1",
		"--no-slots",
		"--api-key-file",
		keyFile,
	];
}

// ── files ────────────────────────────────────────────────────────────────

const NOFOLLOW = fsc.O_NOFOLLOW ?? 0;

/**
 * Open a file we own: never through a symlink (O_NOFOLLOW), a regular file only, and mode
 * 0600 set on the descriptor so a file that already existed with wider rights is tightened
 * too, not only a new one.
 */
export function openPrivate(path: string, flags: number): number {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const fd = openSync(path, flags | fsc.O_CREAT | NOFOLLOW, 0o600);
	try {
		if (!fstatSync(fd).isFile()) throw new Error(`${path} is not a regular file`);
		fchmodSync(fd, 0o600);
		return fd;
	} catch (err) {
		closeSync(fd);
		throw err;
	}
}

function writePrivate(path: string, text: string): void {
	const fd = openPrivate(path, fsc.O_WRONLY | fsc.O_TRUNC);
	try {
		writeSync(fd, text);
	} finally {
		closeSync(fd);
	}
}

function readNoFollow(path: string): string | null {
	try {
		const fd = openSync(path, fsc.O_RDONLY | NOFOLLOW);
		try {
			return readFileSync(fd, "utf-8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return null;
	}
}

const removeQuiet = (p: string) => {
	try {
		unlinkSync(p);
	} catch {}
};

// ── record ───────────────────────────────────────────────────────────────

/** What we launched. `bin` and `startMs` are how a later stop knows the pid is still ours. */
export interface RunRecord {
	pid: number;
	bin: string;
	startMs: number;
	port?: number;
	model?: string;
	gguf?: string;
	keyFile?: string;
}

export function parseRecord(raw: string | null): RunRecord | null {
	if (raw === null) return null;
	try {
		const r = JSON.parse(raw) as Partial<RunRecord>;
		if (
			Number.isInteger(r.pid) &&
			(r.pid as number) > 1 &&
			typeof r.bin === "string" &&
			r.bin &&
			Number.isFinite(r.startMs)
		)
			return r as RunRecord;
	} catch {}
	return null;
}

// ── start ────────────────────────────────────────────────────────────────

export type StartResult = { ok: true } | { ok: false; line: string };

export interface StartDeps {
	env?: Env;
	platform?: string;
	/** Where the server answers, for the up check. Tests point this at a fake server. */
	baseUrl?: string;
	waitMs?: number;
	find?: (name: string) => string | null;
	/** Detached spawn. Returns the child's pid, or undefined when it did not start. */
	spawnServer?: (
		bin: string,
		args: string[],
		env: Record<string, string>,
		logFile: string,
	) => number | undefined;
	fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	write?: (path: string, text: string) => void;
	/** Is the started pid still running? A server that exited is reported at once, not after the wait. */
	alive?: (pid: number) => boolean;
	makeKey?: () => string;
}

const defaultAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

function defaultSpawn(
	bin: string,
	args: string[],
	env: Record<string, string>,
	logFile: string,
): number | undefined {
	const fd = openPrivate(logFile, fsc.O_WRONLY | fsc.O_APPEND);
	try {
		// local-first-gate: default 8gent's own llama-server, fallback an already-installed ollama serve
		const child: ChildProcess = spawn(bin, args, {
			detached: true,
			stdio: ["ignore", fd, fd],
			env: env as NodeJS.ProcessEnv,
		});
		// A missing or non-executable binary reports here; without a listener it would crash 8gent.
		child.on("error", () => {});
		child.unref();
		return child.pid;
	} finally {
		closeSync(fd);
	}
}

async function answers(f: NonNullable<StartDeps["fetchImpl"]>, url: string): Promise<boolean> {
	try {
		return (await f(url, { signal: AbortSignal.timeout(1000), redirect: "error" })).ok;
	} catch {
		return false;
	}
}

interface LaunchOpts {
	kind: RuntimeKind;
	bin: string;
	args: string[];
	probeUrl: string;
	waitMs: number;
	extra?: Partial<RunRecord>;
	failed: (why: string) => StartResult;
}

async function launch(deps: StartDeps, o: LaunchOpts): Promise<StartResult> {
	const env = deps.env ?? process.env;
	const f = deps.fetchImpl ?? ((u, i) => fetch(u, i));
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const now = deps.now ?? Date.now;
	const write = deps.write ?? writePrivate;

	let pid: number | undefined;
	try {
		pid = (deps.spawnServer ?? defaultSpawn)(
			o.bin,
			o.args,
			runtimeEnv(env, o.kind, deps.platform),
			logPath(o.kind, env),
		);
	} catch {}
	if (!pid) return o.failed(`${o.kind} would not start.`);
	const rec: RunRecord = { pid, bin: o.bin, startMs: now(), ...o.extra };
	try {
		write(pidPath(o.kind, env), `${JSON.stringify(rec)}\n`);
	} catch {
		// A server we cannot record is a server we could never stop: do not leave it running.
		try {
			process.kill(pid, "SIGTERM");
		} catch {}
		return o.failed(`${o.kind} was stopped again because its pid could not be recorded.`);
	}

	const alive = deps.alive ?? defaultAlive;
	const deadline = now() + o.waitMs;
	for (;;) {
		if (await answers(f, o.probeUrl)) return { ok: true };
		if (!alive(pid)) {
			removeQuiet(pidPath(o.kind, env));
			return {
				ok: false,
				line: `${o.kind} exited right after starting. Its log is ${logPath(o.kind, env)}.`,
			};
		}
		if (now() >= deadline) break;
		await sleep(250);
	}
	return {
		ok: false,
		line: `${o.kind} did not answer within ${Math.round(o.waitMs / 1000)} s. Its log is ${logPath(o.kind, env)}.`,
	};
}

/** Start llama-server on `gguf`, loopback only, behind a fresh API key. Waits for /health. */
export async function startLlamaServer(
	bin: string,
	gguf: string,
	model: string,
	deps: StartDeps = {},
): Promise<StartResult> {
	const env = deps.env ?? process.env;
	const keyFile = keyPath(env);
	const failed = (why: string): StartResult => ({
		ok: false,
		line: `${why} Its log is ${logPath("llama-server", env)}.`,
	});
	try {
		(deps.write ?? writePrivate)(
			keyFile,
			`${(deps.makeKey ?? (() => randomBytes(24).toString("hex")))()}\n`,
		);
	} catch {
		return failed("llama-server was not started because its key file could not be written.");
	}
	const r = await launch(deps, {
		kind: "llama-server",
		bin,
		args: llamaServerArgs(gguf, keyFile),
		probeUrl: `${deps.baseUrl ?? LLAMA_URL}/health`,
		waitMs: deps.waitMs ?? LLAMA_WAIT_MS,
		extra: { port: LLAMA_PORT, model, gguf, keyFile },
		failed,
	});
	if (!r.ok) removeQuiet(keyFile);
	return r;
}

/** The Ollama fallback: `ollama serve`, loopback, cloud off. */
export async function startOllama(deps: StartDeps = {}): Promise<StartResult> {
	const env = deps.env ?? process.env;
	const bin = (deps.find ?? ((n: string) => findOnPath(n, env)))("ollama");
	const failed = (why: string): StartResult => ({
		ok: false,
		line: `${why} Start it yourself with: ollama serve`,
	});
	if (!bin) return failed("Ollama was not found on PATH.");
	// local-first-gate: fallback Ollama autostart, only for a person who already has Ollama installed
	return launch(deps, {
		kind: "ollama",
		bin,
		args: ["serve"],
		probeUrl: `${deps.baseUrl ?? OLLAMA_PROBE_URL}/api/tags`,
		waitMs: deps.waitMs ?? OLLAMA_WAIT_MS,
		failed,
	});
}

/** True only for this machine's default Ollama port: the only server we can start for it. */
export function isLocalDefaultHost(url: string): boolean {
	try {
		const u = new URL(url);
		return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) && (u.port || "80") === "11434";
	} catch {
		return false;
	}
}

// ── stop ─────────────────────────────────────────────────────────────────

export interface ProcInfo {
	/** argv as the kernel reports it; null when it cannot be split reliably. */
	argv: string[] | null;
	/** Process start time in epoch ms; null when unknown. */
	startMs: number | null;
}

export interface StopDeps {
	env?: Env;
	read?: (path: string) => string | null;
	remove?: (path: string) => void;
	/** null = no such process, "unknown" = could not tell. */
	proc?: (pid: number) => ProcInfo | null | "unknown";
	kill?: (pid: number) => void;
}

const CLK_TCK = 100;

function procFromLinux(pid: number): ProcInfo | null {
	const cmd = readNoFollow(`/proc/${pid}/cmdline`);
	if (cmd === null) return null;
	const argv = cmd.split("\0").filter((x) => x.length > 0);
	let startMs: number | null = null;
	const stat = readNoFollow(`/proc/${pid}/stat`);
	const sys = readNoFollow("/proc/stat");
	const btime = /^btime (\d+)/m.exec(sys ?? "")?.[1];
	if (stat && btime) {
		// Field 22, counted after the "(comm)" which may itself hold spaces.
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const ticks = Number(fields[19]);
		if (Number.isFinite(ticks)) startMs = (Number(btime) + ticks / CLK_TCK) * 1000;
	}
	return { argv, startMs };
}

function procFromPs(pid: number): ProcInfo | null | "unknown" {
	const run = (field: string) =>
		spawnSync("ps", ["-p", String(pid), "-o", `${field}=`], { encoding: "utf-8" });
	const cmd = run("command");
	if (cmd.error) return "unknown";
	if (cmd.status !== 0 || !cmd.stdout.trim()) return null;
	const start = run("lstart");
	const ms = start.error || start.status !== 0 ? Number.NaN : Date.parse(start.stdout.trim());
	// A path with a space cannot be told from two words in ps output, so it fails closed in isOurs.
	return { argv: cmd.stdout.trim().split(/\s+/), startMs: Number.isNaN(ms) ? null : ms };
}

function defaultProc(pid: number): ProcInfo | null | "unknown" {
	return procFromLinux(pid) ?? procFromPs(pid);
}

/**
 * Is `info` the process we launched? The binary path we ran must be exactly argv[0], or
 * argv[1] for a script run through its interpreter (a whole-token match, never a substring).
 * When the start time is known the process must have started within seconds before we
 * recorded it, so a pid reused later by anything else never matches.
 */
export function isOurs(rec: RunRecord, info: ProcInfo): boolean {
	if (!info.argv || !info.argv.slice(0, 2).includes(rec.bin)) return false;
	if (info.startMs !== null) {
		const d = rec.startMs - info.startMs;
		if (d < -2_000 || d > 15_000) return false;
	}
	return true;
}

const KINDS: RuntimeKind[] = ["llama-server", "ollama"];
export const NOTHING_TO_STOP =
	"8gent did not start a local model server, so there is nothing to stop.";

/** `/local stop`: stop each server 8gent started. One line per server. */
export function stopLocal(deps: StopDeps = {}): string[] {
	const env = deps.env ?? process.env;
	const read = deps.read ?? readNoFollow;
	const remove = deps.remove ?? removeQuiet;
	const kill = deps.kill ?? ((p: number) => process.kill(p, "SIGTERM"));
	const proc = deps.proc ?? defaultProc;
	const lines: string[] = [];
	for (const kind of KINDS) {
		const p = pidPath(kind, env);
		const raw = read(p);
		if (raw === null) continue;
		const rec = parseRecord(raw);
		const dropKey = () => {
			if (kind === "llama-server") remove(keyPath(env));
		};
		if (!rec) {
			remove(p);
			dropKey();
			lines.push(
				`The recorded ${kind} pid was not valid and has been cleared. Nothing was stopped.`,
			);
			continue;
		}
		const info = proc(rec.pid);
		if (info === null) {
			remove(p);
			dropKey();
			lines.push(`The ${kind} 8gent started has already stopped.`);
		} else if (info === "unknown") {
			lines.push(
				`Could not check that pid ${rec.pid} is the ${kind} 8gent started, so it was left alone. To stop it: kill ${rec.pid}`,
			);
		} else if (!isOurs(rec, info)) {
			remove(p);
			dropKey();
			lines.push(`Pid ${rec.pid} is no longer the ${kind} 8gent started, so it was left alone.`);
		} else {
			kill(rec.pid);
			remove(p);
			dropKey();
			lines.push(`Stopped the ${kind} 8gent started (pid ${rec.pid}).`);
		}
	}
	return lines.length ? lines : [NOTHING_TO_STOP];
}
