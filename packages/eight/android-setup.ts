/**
 * One-yes setup for DJ and voice input on Android / Termux (#4833).
 *
 * Same shape as the safety-judge offer (judge-install.ts): asked once on first
 * launch and after `8gent update`, one line per question, no sudo, nothing runs
 * without a yes. Music (mpv, python-yt-dlp, ffmpeg) is one question with the
 * judge's default; voice input is a separate [y/N] question.
 * mpv's Termux package already defaults to ao=opensles and depends on
 * pulseaudio, so no audio daemon is started.
 *
 * Voice input stays on the phone by default (#4905): termux-microphone-record,
 * ffmpeg and whisper.cpp (termux-local-stt.ts). Android's speech service, which
 * can send audio to Google, is only used after /voice mic cloud and its own
 * [y/N] question that says so. /voice mic off revokes both.
 * Every side effect is injected, so tests stub the installer.
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
import { dirname } from "node:path";
import { findOnPath, isAndroidHost } from "../voice/termux";
import {
	BUILD_PKGS,
	type Run as LocalRun,
	type LocalVoiceNeeds,
	PHONE_MODELS,
	type PhoneModel,
	buildWhisper as defaultBuildWhisper,
	installPhoneModel as defaultInstallModel,
	findPhoneModel,
	findWhisperBin,
	localVoiceNeeds,
	localVoiceReady,
	runCommand,
} from "../voice/termux-local-stt";
import { askYesNoLine, configPath } from "./judge-install";

export { configPath };

/** Tool on PATH, and the Termux package that provides it, in install order. */
export const MUSIC_TOOLS = [
	{ bin: "mpv", pkg: "mpv" },
	{ bin: "yt-dlp", pkg: "python-yt-dlp" },
	{ bin: "ffmpeg", pkg: "ffmpeg" },
] as const;
/** Android's speech service: only after /voice mic cloud and its own yes. */
export const CLOUD_TOOL = { bin: "termux-speech-to-text", pkg: "termux-api" } as const;

export type SetupChoice = "declined" | "failed";
export interface SetupState {
	/** The music question: declined or failed ends the launch-time asking. */
	choice: SetupChoice | null;
	/** The person typed yes to voice input. Revocable: /voice mic off. */
	mic: boolean;
	/** The mic question was asked at launch and answered no. */
	micDeclined: boolean;
	/** The person typed yes to Android's speech service (audio leaves the phone). Off unless chosen. */
	cloud: boolean;
}
export type SetupPatch = {
	choice?: SetupChoice | null;
	mic?: boolean;
	micDeclined?: boolean;
	cloud?: boolean;
};

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
	run?: LocalRun;
	/** whisper.cpp's CLI, or null. */
	findWhisper?: () => string | null;
	/** An installed whisper model, or null. */
	findModel?: () => string | null;
	buildWhisper?: (
		run: LocalRun,
		progress: (l: string) => void,
	) => Promise<{ path: string } | { error: string }>;
	installModel?: (
		model: PhoneModel,
		run: LocalRun,
	) => Promise<{ path: string } | { error: string }>;
	say?: (line: string) => void;
	progress?: (line: string) => void;
	readState?: () => SetupState;
	writeState?: (p: SetupPatch) => boolean;
}

export function missingMusic(has: (bin: string) => boolean): string[] {
	return MUSIC_TOOLS.filter((t) => !has(t.bin)).map((t) => t.pkg);
}

/** Said in the mic question, so the yes is informed. */
export const LOCAL_DISCLOSURE =
	"It records with your phone's microphone and turns speech into text on this phone with whisper.cpp. Your audio never leaves the phone.";

/** Said in the cloud question. Plain: the audio leaves. */
export const CLOUD_DISCLOSURE =
	"Your audio leaves this phone: Android sends it to its speech service, often Google.";

export function musicAskLine(pkgs: readonly string[], defaultYes = false): string {
	return `Set up this phone for music? Installs ${pkgs.join(", ")}. ${defaultYes ? "[Y/n]" : "[y/N]"}`;
}

/** What the yes sets up, in plain words. Empty when nothing is missing. */
export function localInstallText(n: LocalVoiceNeeds): string {
	const parts: string[] = [];
	if (n.pkgs.includes("termux-api"))
		parts.push("termux-api (it only opens the microphone; the audio stays here)");
	if (n.pkgs.includes("ffmpeg")) parts.push("ffmpeg");
	// The build is the biggest thing the yes starts, so the yes names its tools.
	if (n.whisper)
		parts.push(`the build tools ${BUILD_PKGS.slice(0, -1).join(", ")} and ${BUILD_PKGS.at(-1)}`);
	if (n.whisper) parts.push("the whisper.cpp build (on the phone, a few minutes)");
	if (n.model) parts.push("a speech model");
	if (!parts.length) return "";
	const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
	return `Sets up ${list}. `;
}

/** Always [y/N]: only a typed y or yes turns the mic on. Names the local default and the cloud option. */
export function micAskLine(n: LocalVoiceNeeds): string {
	return `Turn on voice input? ${LOCAL_DISCLOSURE} ${localInstallText(n)}Android's speech service is an option later (/voice mic cloud), but it sends audio off the phone. [y/N]`;
}

/** Asked only when no model is installed. A bare Enter keeps tiny, the phone default. */
export function modelAskLine(): string {
	const { tiny, base } = PHONE_MODELS;
	return `Speech model: tiny (${tiny.sizeLabel}, faster) suits most phones. Use base (${base.sizeLabel}, more accurate) instead? [y/N]`;
}

/** Asked only after /voice mic cloud. Always [y/N]. */
export function cloudAskLine(needsPkg: boolean): string {
	return `Use Android's speech service for voice input instead? ${CLOUD_DISCLOSURE} ${needsPkg ? "Installs termux-api. " : ""}/voice mic local switches back. [y/N]`;
}

export const MIC_READY_LINE =
	"Voice input is on and stays on this phone: Ctrl+R starts recording, Ctrl+R again stops it. It also needs the Termux:API app for the microphone: install it from F-Droid and open it once. /voice mic off turns it off.";

export const CLOUD_READY_LINE =
	"Voice input now uses Android's speech service, so your audio leaves the phone. /voice mic local switches back to this phone.";

/** A typed answer to a yes/no question: an empty line takes the question's default, anything else needs y or yes. */
export function answerFromLine(input: string, bareIsYes: boolean): boolean {
	const t = input.trim();
	return t === "" ? bareIsYes : /^(y|yes)$/i.test(t);
}

// ── config (~/.8gent/config.json, key androidSetup) ──────────────────────

export function readSetup(env: Env = process.env): SetupState {
	const none: SetupState = { choice: null, mic: false, micDeclined: false, cloud: false };
	try {
		const p = configPath(env);
		if (!existsSync(p)) return none;
		const v = JSON.parse(readFileSync(p, "utf-8"))?.androidSetup;
		return {
			choice: v?.choice === "declined" || v?.choice === "failed" ? v.choice : null,
			mic: v?.mic === true,
			micDeclined: v?.micDeclined === true,
			cloud: v?.cloud === true,
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
	if (patch.cloud !== undefined) next.cloud = patch.cloud;
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

const defaultRun: LocalRun = runCommand;

type Run = NonNullable<AndroidSetupDeps["run"]>;

// local-first-gate: optin runs only after a typed y (the music or mic question; a bare Enter is No)
async function installPkgs(
	pkgs: string[],
	run: Run,
	say: (l: string) => void,
	progress: (l: string) => void,
	check: () => string[],
): Promise<boolean> {
	say(`Installing ${pkgs.join(", ")}...`);
	let last = 0;
	// local-first-gate: optin the one pkg install, reached only through installPkgs after a typed y
	const code = await run("pkg", ["install", "-y", ...pkgs], (l) => {
		// One status line, not a scroll.
		if (Date.now() - last < 4000) return;
		last = Date.now();
		progress(`Installing: ${l}`);
	});
	const still = check();
	if (code === 0 && still.length === 0) return true;
	say(
		// local-first-gate: optin names the command for the person to run themselves after a failed install they said yes to
		`Install did not finish (${code === 0 ? `still missing: ${still.join(", ")}` : `exit ${code ?? "not started"}`}). Run it yourself: pkg install -y ${pkgs.join(" ")}`,
	);
	return false;
}

interface Resolved {
	env: Env;
	say: (l: string) => void;
	progress: (l: string) => void;
	ask: NonNullable<AndroidSetupDeps["ask"]>;
	run: LocalRun;
	has: (bin: string) => boolean;
	state: SetupState;
	write: (p: SetupPatch) => boolean;
	needs: () => LocalVoiceNeeds;
	build: NonNullable<AndroidSetupDeps["buildWhisper"]>;
	installModel: NonNullable<AndroidSetupDeps["installModel"]>;
}

/**
 * True when nobody can answer: CI, EIGHT_UNATTENDED, or no terminal on stdin or
 * stdout (a pipe, a test harness feeding keys). Install questions then resolve at
 * once to "no person": nothing installs, nothing is recorded as declined, and the
 * person is asked next time they are there.
 */
export function unattended(env: Env = process.env): boolean {
	const set = (v: string | undefined) => !!v && v !== "0" && v.toLowerCase() !== "false";
	return set(env.CI) || set(env.EIGHT_UNATTENDED) || !process.stdin.isTTY || !process.stdout.isTTY;
}

function askPerson(line: string, defaultYes: boolean, env: Env): Promise<boolean | null> {
	if (unattended(env)) return Promise.resolve(null);
	return askYesNoLine(line, defaultYes);
}

function resolveDeps(deps: AndroidSetupDeps): Resolved {
	const env = deps.env ?? process.env;
	const has = deps.has ?? ((b: string) => findOnPath(b, env) !== null);
	const findWhisper = deps.findWhisper ?? (() => findWhisperBin(env));
	const findModel = deps.findModel ?? (() => findPhoneModel(env));
	return {
		env,
		say: deps.say ?? ((l: string) => console.log(l)),
		progress: deps.progress ?? (() => {}),
		ask: deps.ask ?? ((line, defaultYes) => askPerson(line, defaultYes, env)),
		run: deps.run ?? defaultRun,
		has,
		state: (deps.readState ?? (() => readSetup(env)))(),
		write: deps.writeState ?? ((p: SetupPatch) => writeSetup(p, env)),
		needs: () => localVoiceNeeds(has, findWhisper(), findModel()),
		build: deps.buildWhisper ?? ((run, progress) => defaultBuildWhisper(run, progress, env)),
		installModel: deps.installModel ?? ((model, run) => defaultInstallModel(model, run, env)),
	};
}

/** After the yes: pick the model (if none), then install packages, build whisper.cpp, fetch the model. */
async function installLocalVoice(r: Resolved): Promise<boolean> {
	const first = r.needs();
	let model: PhoneModel = "tiny";
	if (first.model) model = (await r.ask(modelAskLine(), false)) === true ? "base" : "tiny";
	if (
		first.pkgs.length &&
		// local-first-gate: optin the mic question, [y/N], named termux-api and ffmpeg and the build tools before this runs
		!(await installPkgs(first.pkgs, r.run, r.say, r.progress, () => r.needs().pkgs))
	)
		return false;
	if (first.whisper) {
		r.say("Building whisper.cpp on this phone. This takes a few minutes.");
		const built = await r.build(r.run, r.progress);
		if ("error" in built) {
			r.say(built.error);
			return false;
		}
	}
	if (first.model) {
		r.say(`Downloading the ${model} speech model (${PHONE_MODELS[model].sizeLabel})...`);
		const got = await r.installModel(model, r.run);
		if ("error" in got) {
			r.say(got.error);
			return false;
		}
	}
	return localVoiceReady(r.needs());
}

/**
 * Two separate questions, both [y/N]: nothing installs on a bare Enter. Music
 * (mpv, yt-dlp, ffmpeg) is the first. Voice input is its own question, always [y/N], and only a typed y or
 * yes records mic consent; someone who only wants /dj never has to accept it.
 * Voice input is on-phone unless the person chose /voice mic cloud.
 *
 * `auto`: first launch and after an update; each question is asked at most once
 * ever. `command`: the mic key or /voice record; pressing it is intent, so it
 * asks the mic question again while consent is off or a piece is missing, and is
 * silent when ready. Consent is revocable: /voice mic off writes mic:false.
 */
export async function offerAndroidSetup(
	mode: "auto" | "command",
	deps: AndroidSetupDeps = {},
): Promise<AndroidSetupOutcome> {
	const env = deps.env ?? process.env;
	if (!(deps.android ?? isAndroidHost(process.platform, env))) return "not-android";
	const r = resolveDeps(deps);
	const { say, ask, run, has, state, write, progress } = r;
	let music: AndroidSetupOutcome | null = null;

	if (mode === "auto") {
		const missing = missingMusic(has);
		if (missing.length && !state.choice) {
			// Nothing installs unless the person types y: a bare Enter is No (principle 2).
			const defaultYes = deps.defaultYes ?? false;
			const yes = await ask(musicAskLine(missing, defaultYes), defaultYes);
			if (yes === null) return "no-person";
			if (!yes) {
				write({ choice: "declined" });
				// local-first-gate: optin the person answered No to the music question; this is the command they can run themselves
				say(`OK. Nothing installed. Run it yourself: pkg install -y ${missing.join(" ")}`);
				music = "declined";
				// local-first-gate: optin the music question is [y/N]; only a typed y gets here
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

	if (state.mic && state.cloud) {
		if (has(CLOUD_TOOL.bin)) return finish("ready");
		if (mode === "auto") return music ?? "recorded";
		return finish(await askCloud(r));
	}
	if (state.mic && localVoiceReady(r.needs())) return finish("ready");
	if (mode === "auto" && state.micDeclined && !state.mic) return music ?? "recorded";

	// The mic question: [y/N], a bare Enter is No.
	const yes = await ask(micAskLine(r.needs()), false);
	if (yes === null) return music ?? "no-person";
	if (!yes) {
		if (mode === "auto") write({ micDeclined: true });
		say("OK. Voice input stays off.");
		return music ?? "declined";
	}
	write({ mic: true });
	const wasReady = localVoiceReady(r.needs());
	if (!wasReady && !(await installLocalVoice(r))) return "failed";
	say(MIC_READY_LINE);
	return finish(wasReady ? "ready" : "installed");
}

async function askCloud(r: Resolved): Promise<AndroidSetupOutcome> {
	const needsPkg = !r.has(CLOUD_TOOL.bin);
	const yes = await r.ask(cloudAskLine(needsPkg), false);
	if (yes === null) return "no-person";
	if (!yes) {
		r.write({ cloud: false });
		r.say("OK. Voice input stays on this phone.");
		return "declined";
	}
	r.write({ mic: true, cloud: true });
	if (
		needsPkg &&
		// local-first-gate: optin termux-api for Android's speech service, asked only after /voice mic cloud and a typed y
		!(await installPkgs([CLOUD_TOOL.pkg], r.run, r.say, r.progress, () =>
			r.has(CLOUD_TOOL.bin) ? [] : [CLOUD_TOOL.pkg],
		))
	)
		return "failed";
	r.say(CLOUD_READY_LINE);
	return needsPkg ? "installed" : "ready";
}

/** /voice mic cloud: the only way to Android's speech service. Its own [y/N]; a no leaves cloud off. */
export async function offerCloudVoice(deps: AndroidSetupDeps = {}): Promise<AndroidSetupOutcome> {
	const env = deps.env ?? process.env;
	if (!(deps.android ?? isAndroidHost(process.platform, env))) return "not-android";
	return askCloud(resolveDeps(deps));
}

/** Which engine Ctrl+R uses. Local unless the person said yes to the cloud question. */
export function voiceEngine(state: SetupState): "local" | "cloud" {
	return state.cloud ? "cloud" : "local";
}
