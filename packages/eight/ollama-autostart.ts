/**
 * Start Ollama in the background, and stop only what we started (#4906).
 *
 * On a phone there is one terminal. "Start it (ollama serve)" hands that
 * terminal to the server and 8gent cannot be launched. So when Ollama is
 * installed but nothing answers on loopback, the judge offer (judge-install.ts)
 * asks once and this starts `ollama serve` detached: loopback only, cloud off,
 * log under ~/.8gent/logs, pid under ~/.8gent/state.
 *
 * Termux with termux-services and an `ollama` service: `sv up ollama` instead,
 * and a marker file so /ollama stop can `sv down ollama`.
 *
 * Every side effect is injected so tests never start a real server. /ollama
 * stop signals the one recorded pid after checking it still looks like ollama.
 * Never pkill, never a name match.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveHome } from "../core/home";
import { findOnPath, isAndroidHost } from "../voice/termux";

type Env = Record<string, string | undefined>;

/** What the server binds to: loopback only, whatever the caller's OLLAMA_HOST says. */
export const OLLAMA_BIND = "127.0.0.1:11434";
export const OLLAMA_PROBE_URL = `http://${OLLAMA_BIND}`;
export const OLLAMA_WAIT_MS = 10_000;
export const OLLAMA_START_ASK = "Start Ollama in the background now? [Y/n]";

export const logPath = (env: Env = process.env) =>
	join(resolveHome(env), ".8gent", "logs", "ollama.log");
export const pidPath = (env: Env = process.env) =>
	join(resolveHome(env), ".8gent", "state", "ollama.pid");
export const servicePath = (env: Env = process.env) =>
	join(resolveHome(env), ".8gent", "state", "ollama.service");

export type StartResult = { ok: true; how: "spawn" | "service" } | { ok: false; line: string };

export interface StartDeps {
	env?: Env;
	platform?: string;
	/** Where Ollama listens for the up check. Tests point this at a fake server. */
	baseUrl?: string;
	waitMs?: number;
	find?: (name: string) => string | null;
	exists?: (path: string) => boolean;
	/** Detached spawn. Returns the child's pid, or undefined when it did not start. */
	spawnServer?: (bin: string, env: Env, logFile: string) => number | undefined;
	/** `sv up|down ollama`. Returns true on exit code 0. */
	sv?: (action: "up" | "down") => boolean;
	fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	write?: (path: string, text: string) => void;
}

function defaultSpawn(bin: string, env: Env, logFile: string): number | undefined {
	mkdirSync(dirname(logFile), { recursive: true });
	const fd = openSync(logFile, "a", 0o600);
	try {
		const child: ChildProcess = spawn(bin, ["serve"], {
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

const defaultSv = (action: "up" | "down") =>
	spawnSync("sv", [action, "ollama"], { stdio: "ignore" }).status === 0;

function defaultWrite(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text, { mode: 0o600 });
}

async function answers(f: NonNullable<StartDeps["fetchImpl"]>, base: string): Promise<boolean> {
	try {
		return (await f(`${base}/api/tags`, { signal: AbortSignal.timeout(1000) })).ok;
	} catch {
		return false;
	}
}

/** Only a server on this machine's default port can be started by us. */
export function isLocalDefaultHost(url: string): boolean {
	try {
		const u = new URL(url);
		return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) && (u.port || "80") === "11434";
	} catch {
		return false;
	}
}

export async function startOllama(deps: StartDeps = {}): Promise<StartResult> {
	const env = deps.env ?? process.env;
	const base = deps.baseUrl ?? OLLAMA_PROBE_URL;
	const find = deps.find ?? ((n: string) => findOnPath(n, env));
	const exists = deps.exists ?? existsSync;
	const f = deps.fetchImpl ?? ((u, i) => fetch(u, i));
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const now = deps.now ?? Date.now;
	const write = deps.write ?? defaultWrite;
	const waitMs = deps.waitMs ?? OLLAMA_WAIT_MS;
	const failed = (why: string): StartResult => ({
		ok: false,
		line: `${why} Start it yourself with: ollama serve`,
	});

	const bin = find("ollama");
	if (!bin) return failed("Ollama was not found on PATH.");

	let how: "spawn" | "service" = "spawn";
	const svDir = join(env.PREFIX ?? "", "var", "service", "ollama");
	if (isAndroidHost(deps.platform ?? process.platform, env) && find("sv") && exists(svDir)) {
		if ((deps.sv ?? defaultSv)("up")) {
			how = "service";
			write(servicePath(env), "ollama\n");
		}
	}
	if (how === "spawn") {
		let pid: number | undefined;
		try {
			pid = (deps.spawnServer ?? defaultSpawn)(
				bin,
				{ ...env, OLLAMA_HOST: OLLAMA_BIND, OLLAMA_NO_CLOUD: "1" },
				logPath(env),
			);
		} catch {}
		if (!pid) return failed("Ollama would not start.");
		write(pidPath(env), `${pid}\n`);
	}

	const deadline = now() + waitMs;
	for (;;) {
		if (await answers(f, base)) return { ok: true, how };
		if (now() >= deadline) break;
		await sleep(250);
	}
	return {
		ok: false,
		line: `Ollama did not answer within ${Math.round(waitMs / 1000)} s. Its log is ${logPath(env)}.`,
	};
}

// ── /ollama stop ─────────────────────────────────────────────────────────

export interface StopDeps {
	env?: Env;
	read?: (path: string) => string | null;
	remove?: (path: string) => void;
	/** Does this pid still look like ollama? null when it cannot be checked. A reused pid is never signalled. */
	isOllama?: (pid: number) => boolean | null;
	alive?: (pid: number) => boolean;
	kill?: (pid: number) => void;
	sv?: (action: "up" | "down") => boolean;
}

const readOrNull = (p: string): string | null => {
	try {
		return readFileSync(p, "utf-8");
	} catch {
		return null;
	}
};
const removeQuiet = (p: string) => {
	try {
		unlinkSync(p);
	} catch {}
};
const defaultAlive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
function defaultIsOllama(pid: number): boolean | null {
	const proc = readOrNull(`/proc/${pid}/cmdline`);
	if (proc !== null) return proc.toLowerCase().includes("ollama");
	const ps = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf-8" });
	if (ps.error) return null;
	return ps.status === 0 && ps.stdout.toLowerCase().includes("ollama");
}

/** Stops only the Ollama 8gent started. Returns the line to show. */
export function stopOllama(deps: StopDeps = {}): string {
	const env = deps.env ?? process.env;
	const read = deps.read ?? readOrNull;
	const remove = deps.remove ?? removeQuiet;

	if (read(servicePath(env)) !== null) {
		const ok = (deps.sv ?? defaultSv)("down");
		if (ok) remove(servicePath(env));
		return ok
			? "Stopped the Ollama service 8gent started."
			: "Could not stop the Ollama service. Run: sv down ollama";
	}

	const raw = read(pidPath(env));
	if (raw === null) return "8gent did not start Ollama, so there is nothing to stop.";
	const pid = Number(raw.trim());
	if (!Number.isInteger(pid) || pid <= 1) {
		remove(pidPath(env));
		return "The recorded Ollama pid was not valid and has been cleared. Nothing was stopped.";
	}
	if (!(deps.alive ?? defaultAlive)(pid)) {
		remove(pidPath(env));
		return "The Ollama 8gent started has already stopped.";
	}
	const ours = (deps.isOllama ?? defaultIsOllama)(pid);
	if (ours === null)
		return `Could not check that pid ${pid} is Ollama, so it was left alone. To stop it: kill ${pid}`;
	if (!ours) {
		remove(pidPath(env));
		return `Pid ${pid} is no longer Ollama, so it was left alone.`;
	}
	(deps.kill ?? ((p: number) => process.kill(p, "SIGTERM")))(pid);
	remove(pidPath(env));
	return `Stopped the Ollama 8gent started (pid ${pid}).`;
}
