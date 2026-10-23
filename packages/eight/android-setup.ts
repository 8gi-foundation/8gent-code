/**
 * One-yes setup for DJ and voice input on Android / Termux (#4833).
 *
 * Same shape as the safety-judge offer (judge-install.ts): asked once on first
 * launch and after `8gent update`, one line per question, no sudo, nothing runs
 * without a yes. Music (mpv, python-yt-dlp, ffmpeg) is one question with the
 * judge's default; voice input (termux-api) is a separate [y/N] question.
 * mpv's Termux package already defaults to ao=opensles and depends on
 * pulseaudio, so no audio daemon is started.
 *
 * Voice input uses the phone's speech service, which can send audio to Google;
 * the question says so, only a typed yes enables it, and /voice mic off revokes it.
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
export const MUSIC_TOOLS = [
	{ bin: "mpv", pkg: "mpv" },
	{ bin: "yt-dlp", pkg: "python-yt-dlp" },
	{ bin: "ffmpeg", pkg: "ffmpeg" },
] as const;
export const MIC_TOOL = { bin: "termux-speech-to-text", pkg: "termux-api" } as const;

export type SetupChoice = "declined" | "failed";
export interface SetupState {
	/** The music question: declined or failed ends the launch-time asking. */
	choice: SetupChoice | null;
	/** The person typed yes to the phone's speech service. Revocable: /voice mic off. */
	mic: boolean;
	/** The mic question was asked at launch and answered no. */
	micDeclined: boolean;
}
export type SetupPatch = { choice?: SetupChoice | null; mic?: boolean; micDeclined?: boolean };

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

export function missingMusic(has: (bin: string) => boolean): string[] {
	return MUSIC_TOOLS.filter((t) => !has(t.bin)).map((t) => t.pkg);
}

/** Said in the mic question, so the yes is informed. */
export const MIC_DISCLOSURE =
	"Voice input uses your phone's speech service (often Google), which may send your audio off the phone. /voice mic off turns it off.";

export function musicAskLine(pkgs: readonly string[], defaultYes = true): string {
	return `Set up this phone for music? Installs ${pkgs.join(", ")}. ${defaultYes ? "[Y/n]" : "[y/N]"}`;
}

/** Always [y/N]: only a typed y or yes turns the mic on. */
export function micAskLine(needsPkg: boolean): string {
	return `Turn on voice input${needsPkg ? " (installs termux-api)" : ""}? ${MIC_DISCLOSURE} [y/N]`;
}

export const MIC_READY_LINE =
	"Voice input is on: Ctrl+R listens. /voice mic off turns it off. It also needs the Termux:API app: install it from F-Droid and open it once.";

/** A typed answer to a yes/no question: an empty line takes the question's default, anything else needs y or yes. */
export function answerFromLine(input: string, bareIsYes: boolean): boolean {
	const t = input.trim();
	return t === "" ? bareIsYes : /^(y|yes)$/i.test(t);
}

// ── config (~/.8gent/config.json, key androidSetup) ──────────────────────

export function readSetup(env: Env = process.env): SetupState {
	const none: SetupState = { choice: null, mic: false, micDeclined: false };
	try {
		const p = configPath(env);
		if (!existsSync(p)) return none;
		const v = JSON.parse(readFileSync(p, "utf-8"))?.androidSetup;
		return {
			choice: v?.choice === "declined" || v?.choice === "failed" ? v.choice : null,
			mic: v?.mic === true,
			micDeclined: v?.micDeclined === true,
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
	if (patch.micDeclined !== undefined) next.micDeclined = patch.micDeclined;
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

type Run = NonNullable<AndroidSetupDeps["run"]>;

async function installPkgs(
	pkgs: string[],
	run: Run,
	say: (l: string) => void,
	progress: (l: string) => void,
	check: () => string[],
): Promise<boolean> {
	say(`Installing ${pkgs.join(", ")}...`);
	let last = 0;
	const code = await run("pkg", ["install", "-y", ...pkgs], (l) => {
		// One status line, not a scroll.
		if (Date.now() - last < 4000) return;
		last = Date.now();
		progress(`Installing: ${l}`);
	});
	const still = check();
	if (code === 0 && still.length === 0) return true;
	say(
		`Install did not finish (${code === 0 ? `still missing: ${still.join(", ")}` : `exit ${code ?? "not started"}`}). Run it yourself: pkg install -y ${pkgs.join(" ")}`,
	);
	return false;
}

/**
 * Two separate questions. Music (mpv, yt-dlp, ffmpeg) keeps the judge's
 * default. Voice input is its own question, always [y/N], and only a typed y or
 * yes records mic consent; someone who only wants /dj never has to accept it.
 *
 * `auto`: first launch and after an update; each question is asked at most once
 * ever. `command`: the mic key or /voice record; pressing it is intent, so it
 * asks the mic question again while consent is off, and is silent when on.
 * Consent is revocable: /voice mic off writes mic:false.
 */
export async function offerAndroidSetup(
	mode: "auto" | "command",
	deps: AndroidSetupDeps = {},
): Promise<AndroidSetupOutcome> {
	const env = deps.env ?? process.env;
	if (!(deps.android ?? isAndroidHost(process.platform, env))) return "not-android";
	const say = deps.say ?? ((l: string) => console.log(l));
	const progress = deps.progress ?? (() => {});
	const ask = deps.ask ?? askYesNoLine;
	const run = deps.run ?? defaultRun;
	const has = deps.has ?? ((b: string) => findOnPath(b, env) !== null);
	const state = (deps.readState ?? (() => readSetup(env)))();
	const write = deps.writeState ?? ((p: SetupPatch) => writeSetup(p, env));
	let music: AndroidSetupOutcome | null = null;

	if (mode === "auto") {
		const missing = missingMusic(has);
		if (missing.length && !state.choice) {
			const defaultYes = deps.defaultYes ?? true;
			const yes = await ask(musicAskLine(missing, defaultYes), defaultYes);
			if (yes === null) return "no-person";
			if (!yes) {
				write({ choice: "declined" });
				say(`OK. Nothing installed. Run it yourself: pkg install -y ${missing.join(" ")}`);
				music = "declined";
			} else if (await installPkgs(missing, run, say, progress, () => missingMusic(has))) {
				say("Music is ready: /dj plays.");
				music = "installed";
			} else {
				write({ choice: "failed" });
				music = "failed";
			}
		}
	}
	const finish = (mic: AndroidSetupOutcome): AndroidSetupOutcome =>
		music === "failed" ? "failed" : mic === "ready" && music ? music : mic;

	if (state.mic && has(MIC_TOOL.bin)) return finish("ready");
	if (mode === "auto" && state.micDeclined && !state.mic) return music ?? "recorded";

	// The mic question: [y/N], a bare Enter is No.
	const needsPkg = !has(MIC_TOOL.bin);
	const yes = await ask(micAskLine(needsPkg), false);
	if (yes === null) return music ?? "no-person";
	if (!yes) {
		if (mode === "auto") write({ micDeclined: true });
		say("OK. Voice input stays off.");
		return music ?? "declined";
	}
	write({ mic: true });
	if (
		needsPkg &&
		!(await installPkgs([MIC_TOOL.pkg], run, say, progress, () =>
			has(MIC_TOOL.bin) ? [] : [MIC_TOOL.pkg],
		))
	)
		return "failed";
	say(MIC_READY_LINE);
	return finish(needsPkg ? "installed" : "ready");
}
