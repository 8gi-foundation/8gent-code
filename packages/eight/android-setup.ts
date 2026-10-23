/**
 * One-yes setup for DJ and voice input on Android / Termux (#4833).
 *
 * Same shape as the safety-judge offer (judge-install.ts): asked once on first
 * launch and after `8gent update`, one line, one yes, no sudo, nothing runs
 * without the yes. The yes installs what is missing of mpv, python-yt-dlp,
 * ffmpeg (music) and termux-api (voice input) with `pkg install -y`, and turns
 * voice input on. mpv's Termux package already defaults to ao=opensles and
 * depends on pulseaudio, so no audio daemon is started.
 *
 * Voice input uses Android's speech recogniser, which can send audio to Google;
 * the question says so, and the yes is the only way it is enabled.
 * Every side effect is injected, so tests stub the installer.
 */

import { spawn } from "node:child_process";
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
import { dirname } from "node:path";
import { findOnPath, isAndroidHost } from "../voice/termux";
import { askYesNoLine, cleanText, configPath } from "./judge-install";

export { configPath };

/** Tool on PATH, and the Termux package that provides it, in install order. */
export const ANDROID_TOOLS = [
	{ bin: "mpv", pkg: "mpv" },
	{ bin: "yt-dlp", pkg: "python-yt-dlp" },
	{ bin: "ffmpeg", pkg: "ffmpeg" },
	{ bin: "termux-speech-to-text", pkg: "termux-api" },
] as const;

export type SetupChoice = "declined" | "failed";
export interface SetupState {
	choice: SetupChoice | null;
	/** The person said yes to Android's speech recogniser. */
	mic: boolean;
}
export type SetupPatch = { choice?: SetupChoice | null; mic?: boolean };

export type AndroidSetupOutcome =
	| "not-android"
	| "recorded"
	| "ready"
	| "no-person"
	| "declined"
	| "installed"
	| "failed";

type Env = Record<string, string | undefined>;

export interface AndroidSetupDeps {
	env?: Env;
	android?: boolean;
	/** Is this command on PATH? */
	has?: (bin: string) => boolean;
	ask?: (line: string, defaultYes: boolean) => Promise<boolean | null>;
	/** A bare Enter: true on first launch, false after an update. */
	defaultYes?: boolean;
	/** Run a command, resolve its exit code (null when it could not start). */
	run?: (cmd: string, args: string[], onLine: (l: string) => void) => Promise<number | null>;
	say?: (line: string) => void;
	progress?: (line: string) => void;
	readState?: () => SetupState;
	writeState?: (p: SetupPatch) => boolean;
}

export function missingPackages(has: (bin: string) => boolean): string[] {
	return ANDROID_TOOLS.filter((t) => !has(t.bin)).map((t) => t.pkg);
}

const GOOGLE_NOTE =
	"Voice input uses Android's speech recogniser, which may send your audio to Google.";

export function androidAskLine(pkgs: readonly string[], defaultYes = true): string {
	const yn = defaultYes ? "[Y/n]" : "[y/N]";
	return pkgs.length
		? `Set up this phone for music and voice input? Installs ${pkgs.join(", ")}. ${GOOGLE_NOTE} ${yn}`
		: `Turn on voice input? ${GOOGLE_NOTE} ${yn}`;
}

// ── config (~/.8gent/config.json, key androidSetup) ──────────────────────

export function readSetup(env: Env = process.env): SetupState {
	const none: SetupState = { choice: null, mic: false };
	try {
		const p = configPath(env);
		if (!existsSync(p)) return none;
		const v = JSON.parse(readFileSync(p, "utf-8"))?.androidSetup;
		return {
			choice: v?.choice === "declined" || v?.choice === "failed" ? v.choice : null,
			mic: v?.mic === true,
		};
	} catch {
		return none;
	}
}

/** Merge into config.json keeping every other key. Never overwrites a file it cannot parse. */
export function writeSetup(patch: SetupPatch, env: Env = process.env, now = new Date()): boolean {
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
	const cur = (cfg.androidSetup ?? {}) as Record<string, unknown>;
	const next: Record<string, unknown> = { ...cur, at: now.toISOString() };
	if ("choice" in patch) {
		if (patch.choice) next.choice = patch.choice;
		else next.choice = undefined;
	}
	if (patch.mic !== undefined) next.mic = patch.mic;
	cfg.androidSetup = next;
	let tmp = "";
	try {
		const target = existsSync(p) && lstatSync(p).isSymbolicLink() ? realpathSync(p) : p;
		mkdirSync(dirname(target), { recursive: true });
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

// ── real side effects ────────────────────────────────────────────────────

function defaultRun(
	cmd: string,
	args: string[],
	onLine: (l: string) => void,
): Promise<number | null> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (c: number | null) => {
			if (!settled) {
				settled = true;
				resolve(c);
			}
		};
		try {
			const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
			const onData = (d: unknown) => {
				const line = cleanText(
					String(d)
						.split(/[\r\n]+/)
						.filter(Boolean)
						.pop() ?? "",
					100,
				);
				if (line) onLine(line);
			};
			child.stdout?.on("data", onData);
			child.stderr?.on("data", onData);
			child.on("error", () => done(null));
			child.on("close", (c) => done(c));
		} catch {
			done(null);
		}
	});
}

const F_DROID_LINE =
	"Voice input also needs the Termux:API app: install it from F-Droid and open it once.";

/**
 * `auto`: first launch and after an update. Asks at most once ever; any
 * recorded choice ends the asking. `command`: the mic key or /dj path; pressing
 * it is intent, so it asks again when something is missing, and stays silent
 * when everything is ready.
 */
export async function offerAndroidSetup(
	mode: "auto" | "command",
	deps: AndroidSetupDeps = {},
): Promise<AndroidSetupOutcome> {
	const env = deps.env ?? process.env;
	if (!(deps.android ?? isAndroidHost(process.platform, env))) return "not-android";
	const say = deps.say ?? ((l: string) => console.log(l));
	const progress = deps.progress ?? (() => {});
	const state = (deps.readState ?? (() => readSetup(env)))();
	const write = deps.writeState ?? ((p: SetupPatch) => writeSetup(p, env));
	if (mode === "auto" && state.choice) return "recorded";

	const pkgs = missingPackages(deps.has ?? ((b) => findOnPath(b, env) !== null));
	if (pkgs.length === 0 && state.mic) return "ready";

	const defaultYes = deps.defaultYes ?? true;
	const yes = await (deps.ask ?? askYesNoLine)(androidAskLine(pkgs, defaultYes), defaultYes);
	if (yes === null) return "no-person";
	if (!yes) {
		if (mode === "auto") write({ choice: "declined" });
		say(
			pkgs.length
				? `OK. Nothing installed. Run it yourself: pkg install -y ${pkgs.join(" ")}`
				: "OK. Voice input stays off.",
		);
		return "declined";
	}

	write({ mic: true });
	if (pkgs.length === 0) return "ready";
	say(`Installing ${pkgs.join(", ")}...`);
	let last = 0;
	const code = await (deps.run ?? defaultRun)("pkg", ["install", "-y", ...pkgs], (l) => {
		// One status line, not a scroll.
		if (Date.now() - last < 4000) return;
		last = Date.now();
		progress(`Installing: ${l}`);
	});
	const still = missingPackages(deps.has ?? ((b) => findOnPath(b, env) !== null));
	if (code === 0 && still.length === 0) {
		say(`Ready. /dj plays music and Ctrl+R listens. ${F_DROID_LINE}`);
		return "installed";
	}
	if (mode === "auto") write({ choice: "failed" });
	say(
		`Install did not finish (${code === 0 ? `still missing: ${still.join(", ")}` : `exit ${code ?? "not started"}`}). Run it yourself: pkg install -y ${pkgs.join(" ")}`,
	);
	return "failed";
}
