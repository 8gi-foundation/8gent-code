/**
 * One-yes install of the System One safety judge (#4811).
 *
 * When no judge backend is reachable the gate runs on rules only
 * (packages/permissions/system-one-gate.ts, NO_BACKEND). This asks once, on one
 * line, whether to install the judge, installs it through the machine's local
 * Ollama (`/api/pull`), and confirms it is reachable. No yes, no install. No
 * sudo, ever: the only thing run is an HTTP pull against the local server.
 *
 * Self-contained on purpose: every side effect (probe, pull, prompt, state,
 * output) is injected, so tests stub the installer and never download.
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveHome } from "../core/home";
import { JUDGE_MODEL } from "../decide/judge-model";
import { detectBackend, resolveSharedJudgeHost } from "../decide/probe";
import { findOnPath } from "../voice/termux";
import {
	OLLAMA_START_ASK,
	type StartResult,
	isLocalDefaultHost,
	startOllama,
} from "./ollama-autostart";

/** The calibrated judge, fixed at build time (packages/decide/judge-model.ts), never from user config. */
export { JUDGE_MODEL };
/** `ollama list` reports 4.9 GB for this model. */
export const JUDGE_SIZE = "4.9 GB";

export type JudgeChoice = "declined" | "unsupported" | "failed";

export type JudgeOutcome =
	| "present" //      a judge is already reachable
	| "off" //          System One is switched off
	| "recorded" //     an earlier choice is on file, nothing asked
	| "no-person" //    nobody to ask; nothing recorded
	| "declined"
	| "unsupported"
	| "installed"
	| "failed";

type Env = Record<string, string | undefined>;

export interface JudgeDeps {
	env?: Env;
	/** Is a judge backend reachable right now? Default: decide's detectBackend. */
	probe?: () => Promise<{ backend: string; model: string | null }>;
	/** Can this machine run Ollama? "up" = server answering, "installed" = binary only, "none". */
	ollama?: () => Promise<"up" | "installed" | "none">;
	/** Pull the model, reporting percent (0-100) as it goes. Throws on failure. */
	pull?: (model: string, onPercent: (pct: number) => void) => Promise<void>;
	/** Ask one yes/no line; resolves null when nobody can answer. */
	ask?: (line: string, defaultYes: boolean) => Promise<boolean | null>;
	/** Start Ollama in the background (#4906). Default: ollama-autostart's startOllama. */
	startOllama?: () => Promise<StartResult>;
	/** What a bare Enter answers. True on first launch, false after `8gent update` (a stray Enter must not start a download). */
	defaultYes?: boolean;
	/** A finished line. */
	say?: (line: string) => void;
	/** The single progress status line (rewritten in place on a terminal). */
	progress?: (line: string) => void;
	readChoice?: () => JudgeChoice | null | undefined;
	/** Pass null to clear. Returns false when the config could not be written. */
	writeChoice?: (c: JudgeChoice | null) => boolean;
}

export const judgeAskLine = (defaultYes = true): string =>
	`Install the safety judge (${JUDGE_MODEL}, ~${JUDGE_SIZE})? It checks risky commands before they run. ${defaultYes ? "[Y/n]" : "[y/N]"}`;
export const JUDGE_ASK_LINE = judgeAskLine(true);

export const JUDGE_UNSUPPORTED_LINE =
	"The safety judge needs Ollama, which is not available here, so risky commands are checked by the built-in safety rules only. " +
	"To enable the judge, install Ollama, start it, then run /judge install.";

export const JUDGE_OLLAMA_DOWN_LINE =
	"Ollama is installed but not running, so the safety judge cannot be installed yet. Start it (ollama serve), then run /judge install. " +
	"Until then risky commands are checked by the built-in safety rules only.";

// ── config (~/.8gent/config.json, key judgeInstall) ──────────────────────

export function configPath(env: Env = process.env): string {
	return join(resolveHome(env), ".8gent", "config.json");
}

/** The recorded choice, "corrupt" when the file cannot be parsed (never overwritten, never asked), else null. */
export function readChoice(env: Env = process.env): JudgeChoice | "corrupt" | null {
	const p = configPath(env);
	if (!existsSync(p)) return null;
	try {
		const v = JSON.parse(readFileSync(p, "utf-8"))?.judgeInstall?.choice;
		return v === "declined" || v === "unsupported" || v === "failed" ? v : null;
	} catch {
		return "corrupt";
	}
}

/** Merge the choice into config.json, keeping every other key. Never overwrites a file it cannot parse. */
export function writeChoice(
	c: JudgeChoice | null,
	env: Env = process.env,
	now = new Date(),
): boolean {
	const p = configPath(env);
	let cfg: Record<string, unknown> = {};
	if (existsSync(p)) {
		try {
			const parsed = JSON.parse(readFileSync(p, "utf-8"));
			if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
			cfg = parsed;
		} catch {
			return false;
		}
	}
	if (c === null) delete cfg.judgeInstall;
	else cfg.judgeInstall = { choice: c, at: now.toISOString() };
	let tmp = "";
	try {
		// A symlinked config stays a symlink: write next to the real target and rename over that.
		const target = existsSync(p) && lstatSync(p).isSymbolicLink() ? realpathSync(p) : p;
		mkdirSync(dirname(target), { recursive: true });
		// Keep the existing mode; a new file is private (it can hold keys).
		const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
		tmp = `${target}.tmp-${process.pid}`;
		writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode });
		renameSync(tmp, target);
		return true;
	} catch {
		if (tmp) {
			try {
				unlinkSync(tmp);
			} catch {}
		}
		return false;
	}
}

/** Text from another process, safe to print: control characters (escape codes included) removed, capped. */
export function cleanText(s: string, max = 200): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
	const t = s
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

// ── real side effects (defaults) ─────────────────────────────────────────

async function defaultOllama(env: Env): Promise<"up" | "installed" | "none"> {
	const host = resolveSharedJudgeHost(env);
	try {
		const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(1000) });
		if (res.ok) return "up";
	} catch {}
	return findOnPath("ollama", env) ? "installed" : "none";
}

export const PULL_IDLE_MS = 60_000;

/** Ollama `/api/pull`, streamed NDJSON: {status, total, completed} lines, or {error}. Fails cleanly after `idleMs` with no bytes. */
export async function pullModel(
	fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
	host: string,
	model: string,
	onPercent: (pct: number) => void,
	idleMs = PULL_IDLE_MS,
): Promise<void> {
	const ctl = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let idled = false;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	const arm = () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			idled = true;
			ctl.abort();
			// A stalled body does not always react to the abort: end the read ourselves.
			reader?.cancel().catch(() => {});
		}, idleMs);
	};
	const idleError = () => new Error(`Ollama sent nothing for ${Math.round(idleMs / 1000)} s`);
	arm();
	try {
		const res = await fetchImpl(`${host}/api/pull`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model, stream: true }),
			signal: ctl.signal,
		});
		if (!res.ok || !res.body) throw new Error(`Ollama answered ${res.status} to the pull`);
		reader = res.body.getReader();
		const dec = new TextDecoder();
		let buf = "";
		let done = false;
		const handle = (line: string) => {
			if (!line.trim()) return;
			const j = JSON.parse(line) as {
				error?: string;
				status?: string;
				total?: number;
				completed?: number;
			};
			if (j.error) throw new Error(cleanText(String(j.error)));
			if (j.status === "success") done = true;
			if (j.total && j.completed !== undefined)
				onPercent(Math.min(100, Math.floor((j.completed / j.total) * 100)));
		};
		for (;;) {
			const { value, done: end } = await reader.read();
			if (end) break;
			arm();
			buf += dec.decode(value, { stream: true });
			const lines = buf.split("\n");
			buf = lines.pop() ?? "";
			for (const l of lines) handle(l);
		}
		handle(buf);
		if (!done) throw new Error("the download ended before Ollama reported success");
	} catch (err) {
		if (idled) throw idleError();
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

/** One-line y/n on stdin. An empty answer is `defaultYes`. Null when stdin is not a terminal. */
export async function askYesNoLine(line: string, defaultYes = true): Promise<boolean | null> {
	if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
	const { createInterface } = await import("node:readline/promises");
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const a = (await rl.question(`${line} `)).trim().toLowerCase();
		if (a === "") return defaultYes;
		return a === "y" || a === "yes";
	} finally {
		rl.close();
	}
}

function terminalProgress(line: string): void {
	if (process.stdout.isTTY) process.stdout.write(`\r\x1b[2K${line}`);
}

// ── the flow ─────────────────────────────────────────────────────────────

type InstallDeps = Required<Pick<JudgeDeps, "probe" | "pull" | "say" | "progress" | "writeChoice">>;

async function install(d: InstallDeps, from: "auto" | "command"): Promise<JudgeOutcome> {
	let last = -1;
	const status = (pct: number) => {
		if (pct === last) return;
		last = pct;
		d.progress(`Installing the safety judge (${JUDGE_MODEL}, ~${JUDGE_SIZE}): ${pct}%`);
	};
	d.progress(`Installing the safety judge (${JUDGE_MODEL}, ~${JUDGE_SIZE}): 0%`);
	try {
		await d.pull(JUDGE_MODEL, status);
		const after = await d.probe();
		if (after.backend === "none") throw new Error("it downloaded, but no judge answers yet");
		d.say(`Safety judge ready: ${after.model ?? after.backend} via ${after.backend}.`);
		d.writeChoice(null);
		return "installed";
	} catch (err) {
		const why = cleanText(err instanceof Error ? err.message : String(err));
		d.say(
			`Could not install the safety judge: ${why}. Risky commands are checked by the built-in safety rules only. Run /judge install to try again.`,
		);
		if (from === "auto") d.writeChoice("failed");
		return "failed";
	}
}

/**
 * `auto`: after an update and on first launch. Asks at most once ever: any
 * recorded choice (declined, unsupported, failed) ends the asking.
 * `command`: /judge install. Typing it is the yes; it ignores recorded choices.
 */
export async function offerJudge(
	mode: "auto" | "command",
	deps: JudgeDeps = {},
): Promise<JudgeOutcome> {
	const env = deps.env ?? process.env;
	const say = deps.say ?? ((l: string) => console.log(l));
	const d = {
		probe: deps.probe ?? (() => detectBackend({ env })),
		ollama: deps.ollama ?? (() => defaultOllama(env)),
		pull:
			deps.pull ??
			((m: string, p: (n: number) => void) =>
				pullModel((u, i) => fetch(u, i), resolveSharedJudgeHost(env), m, p)),
		say,
		progress: deps.progress ?? terminalProgress,
		readChoice: deps.readChoice ?? (() => readChoice(env)),
		writeChoice: deps.writeChoice ?? ((c: JudgeChoice | null) => writeChoice(c, env)),
	};

	if (env.EIGHT_SYSTEM_ONE?.trim() === "0") return "off";

	if (mode === "auto") {
		if (d.readChoice()) return "recorded";
	}
	const now = await d.probe();
	if (now.backend !== "none") {
		if (mode === "command")
			say(`The safety judge is already installed: ${now.model ?? now.backend} via ${now.backend}.`);
		return "present";
	}

	let o = await d.ollama();
	let downLine = o === "none" ? JUDGE_UNSUPPORTED_LINE : JUDGE_OLLAMA_DOWN_LINE;
	// Installed but stopped: start it in the background instead of handing the person a blocking
	// `ollama serve` (#4906). Auto asks once (a no falls through to the recorded choice below, so it is
	// never asked again); /judge install is itself the yes.
	if (o === "installed" && isLocalDefaultHost(resolveSharedJudgeHost(env))) {
		let go = mode === "command";
		if (!go) go = (await (deps.ask ?? askYesNoLine)(OLLAMA_START_ASK, true)) === true;
		if (go) {
			say("Starting Ollama in the background.");
			const r = await (deps.startOllama ?? (() => startOllama({ env })))();
			if (r.ok) o = "up";
			else downLine = r.line;
		}
	}
	if (o !== "up") {
		const line = downLine;
		if (mode === "auto") {
			// Say it once, then never again; /judge install says it on request.
			if (!d.writeChoice("unsupported")) return "no-person";
			say(line);
		} else say(line);
		return "unsupported";
	}

	if (mode === "auto") {
		const defaultYes = deps.defaultYes ?? true;
		const yes = await (deps.ask ?? askYesNoLine)(judgeAskLine(defaultYes), defaultYes);
		if (yes === null) return "no-person";
		if (!yes) {
			d.writeChoice("declined");
			say(
				"OK. Risky commands are checked by the built-in safety rules only. Run /judge install if you change your mind.",
			);
			return "declined";
		}
	}
	const out = await install(d, mode);
	if (process.stdout.isTTY && !deps.progress) process.stdout.write("\n");
	return out;
}
