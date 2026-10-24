/**
 * Voice input on Android that stays on the phone (#4905).
 *
 * Record with `termux-microphone-record` (termux-api: it opens the mic, the file
 * stays in Termux's own storage), convert to 16 kHz mono WAV with ffmpeg (the
 * recorder has no WAV encoder: aac, amr_wb, amr_nb, opus only), transcribe with
 * whisper.cpp, then delete both audio files. Nothing is sent anywhere.
 *
 * Termux repo facts (checked 24 Oct 2026): termux-main and TUR ship no whisper
 * package, so whisper.cpp is built on the phone from a pinned release tarball
 * whose sha256 is checked. Models come from the whisper.cpp Hugging Face repo and
 * are sha256-checked too. Every side effect is injected; tests never touch a mic.
 */

import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	createReadStream,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHome } from "../core/home";
import { WHISPER_MODEL_RANK } from "./model-manager";
import { findOnPath } from "./termux";

type Env = Record<string, string | undefined>;

/** The two models offered on a phone. English-only builds: smaller and better at English. */
export const PHONE_MODELS = {
	tiny: {
		filename: "ggml-tiny.en.bin",
		sizeLabel: "78 MB",
		bytes: 77_704_715,
		url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin",
		sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f",
	},
	base: {
		filename: "ggml-base.en.bin",
		sizeLabel: "148 MB",
		bytes: 147_964_211,
		url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
		sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
	},
} as const;
export type PhoneModel = keyof typeof PHONE_MODELS;

/** whisper.cpp release built on the phone. Pinned so the bytes compiled are the bytes reviewed. */
export const WHISPER_SOURCE = {
	version: "v1.9.5",
	url: "https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.9.5.tar.gz",
	sha256: "ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720",
} as const;

/** Termux packages the local path needs, by the command that proves each is there. */
export const RECORD_TOOL = { bin: "termux-microphone-record", pkg: "termux-api" } as const;
export const CONVERT_TOOL = { bin: "ffmpeg", pkg: "ffmpeg" } as const;
/** What building whisper.cpp needs. curl and tar are in every Termux install. */
export const BUILD_PKGS = ["clang", "cmake", "make"] as const;

/** Longest single recording. The recorder gets the same limit, so the mic is never left on. */
export const RECORD_LIMIT_S = 60;
export const TRANSCRIBE_TIMEOUT_MS = 120_000;

export const recordFailedLine =
	"Could not start the microphone. Install the Termux:API app from F-Droid, open it once, and allow the microphone (Android Settings, Apps, Termux:API, Permissions).";
export const noAudioLine =
	"The recording came back empty. Check the Termux:API app has microphone permission.";
export const convertFailedLine = "ffmpeg could not read the recording. Try again.";
export const heardNothingLine = "Heard nothing. Press Ctrl+R, speak, then press Ctrl+R again.";

function eightDir(env: Env): string {
	return join(resolveHome(env), ".8gent");
}

export function phoneModelsDir(env: Env = process.env): string {
	return join(eightDir(env), "models", "whisper");
}

/** Where the on-phone build puts whisper-cli. */
export function managedWhisperBin(env: Env = process.env): string {
	return join(eightDir(env), "bin", "whisper-cli");
}

/** whisper.cpp's CLI: whisper-cli (current name), whisper-cpp (older packages), or the one this file built. */
export function findWhisperBin(
	env: Env = process.env,
	exists: (p: string) => boolean = existsSync,
): string | null {
	return (
		findOnPath("whisper-cli", env) ??
		findOnPath("whisper-cpp", env) ??
		(exists(managedWhisperBin(env)) ? managedWhisperBin(env) : null)
	);
}

/** The installed model, best first, using the same ranking as desktop dictation. Null when none. */
export function findPhoneModel(
	env: Env = process.env,
	exists: (p: string) => boolean = existsSync,
): string | null {
	const dir = phoneModelsDir(env);
	for (const m of WHISPER_MODEL_RANK) {
		const p = join(dir, m.filename);
		if (exists(p)) return p;
	}
	return null;
}

export interface LocalVoiceNeeds {
	/** Termux packages to pkg install. */
	pkgs: string[];
	/** whisper.cpp must be built. */
	whisper: boolean;
	/** No model is installed. */
	model: boolean;
}

/** What is missing for on-phone voice input. Build tools are only listed when whisper.cpp must be built. */
export function localVoiceNeeds(
	has: (bin: string) => boolean,
	whisperBin: string | null,
	modelPath: string | null,
): LocalVoiceNeeds {
	const pkgs: string[] = [];
	if (!has(RECORD_TOOL.bin)) pkgs.push(RECORD_TOOL.pkg);
	if (!has(CONVERT_TOOL.bin)) pkgs.push(CONVERT_TOOL.pkg);
	const whisper = !whisperBin;
	if (whisper) for (const p of BUILD_PKGS) if (!has(p)) pkgs.push(p);
	return { pkgs, whisper, model: !modelPath };
}

export function localVoiceReady(n: LocalVoiceNeeds): boolean {
	return n.pkgs.length === 0 && !n.whisper && !n.model;
}

// ── install ──────────────────────────────────────────────────────────────

export type Run = (
	cmd: string,
	args: string[],
	onLine: (l: string) => void,
	opts?: { cwd?: string },
) => Promise<number | null>;

export function sha256File(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const h = createHash("sha256");
		createReadStream(path)
			.on("data", (d) => h.update(d))
			.on("error", reject)
			.on("end", () => resolve(h.digest("hex")));
	});
}

export interface FetchDeps {
	/** Download url to path. Resolves false on any failure. */
	download?: (url: string, path: string, run: Run) => Promise<boolean>;
	hash?: (path: string) => Promise<string>;
}

/** curl is in every Termux install; -f fails on HTTP errors, -L follows the Hugging Face redirect. */
async function curlDownload(url: string, path: string, run: Run): Promise<boolean> {
	return (await run("curl", ["-fsSL", "--retry", "2", "-o", path, url], () => {})) === 0;
}

/**
 * Put an executable at `to` so it is either the old file or the whole new one,
 * never half a binary: copy to a temp name beside it, then rename into place.
 * An interrupted copy leaves `to` untouched and removes the temp file.
 */
export function installExecutable(
	from: string,
	to: string,
	io: { copy?: (a: string, b: string) => void; rename?: (a: string, b: string) => void } = {},
): void {
	const tmp = `${to}.${process.pid}.tmp`;
	try {
		(io.copy ?? copyFileSync)(from, tmp);
		chmodSync(tmp, 0o755);
		(io.rename ?? renameSync)(tmp, to);
	} catch (err) {
		rmQuiet(tmp);
		throw err;
	}
}

function rmQuiet(p: string): void {
	try {
		rmSync(p, { recursive: true, force: true });
	} catch {}
}

/**
 * Download a model into the models directory and keep it only if its sha256
 * matches. The file appears under its real name only after the check passes.
 */
export async function installPhoneModel(
	model: PhoneModel,
	run: Run,
	env: Env = process.env,
	deps: FetchDeps = {},
): Promise<{ path: string } | { error: string }> {
	const m = PHONE_MODELS[model];
	const dir = phoneModelsDir(env);
	const dest = join(dir, m.filename);
	const part = `${dest}.part`;
	const download = deps.download ?? curlDownload;
	const hash = deps.hash ?? sha256File;
	try {
		mkdirSync(dir, { recursive: true });
		if (!(await download(m.url, part, run))) {
			rmQuiet(part);
			return { error: `Could not download ${m.filename}. Check the connection and try again.` };
		}
		const got = await hash(part);
		if (got !== m.sha256) {
			rmQuiet(part);
			return { error: `${m.filename} failed its checksum, so it was deleted. Try again.` };
		}
		renameSync(part, dest);
		return { path: dest };
	} catch (err) {
		rmQuiet(part);
		return { error: `Could not save ${m.filename}: ${err instanceof Error ? err.message : err}` };
	}
}

export interface BuildDeps extends FetchDeps {
	/** Scratch directory for the source. Removed afterwards. */
	workDir?: string;
	jobs?: number;
	exists?: (p: string) => boolean;
	copy?: (from: string, to: string) => void;
}

/**
 * Build whisper-cli from the pinned whisper.cpp release, static, and copy it to
 * ~/.8gent/bin. Takes a few minutes on a phone. The source is deleted afterwards.
 */
export async function buildWhisper(
	run: Run,
	progress: (l: string) => void,
	env: Env = process.env,
	deps: BuildDeps = {},
): Promise<{ path: string } | { error: string }> {
	const download = deps.download ?? curlDownload;
	const hash = deps.hash ?? sha256File;
	const exists = deps.exists ?? existsSync;
	const copy = deps.copy ?? installExecutable;
	const work = deps.workDir ?? mkdtempSync(join(tmpdir(), "8gent-whisper-"));
	const jobs = String(deps.jobs ?? Math.max(1, Math.min(4, availableParallelism())));
	const tarball = join(work, "whisper.tar.gz");
	const src = join(work, "src");
	const fail = (why: string) => ({
		error: `Building whisper.cpp ${WHISPER_SOURCE.version} did not finish (${why}).`,
	});
	try {
		progress(`Downloading whisper.cpp ${WHISPER_SOURCE.version}...`);
		if (!(await download(WHISPER_SOURCE.url, tarball, run))) return fail("download failed");
		if ((await hash(tarball)) !== WHISPER_SOURCE.sha256) return fail("checksum did not match");
		mkdirSync(src, { recursive: true });
		if ((await run("tar", ["-xzf", tarball, "-C", src, "--strip-components=1"], () => {})) !== 0)
			return fail("could not unpack");
		const configure = await run(
			"cmake",
			[
				"-B",
				"build",
				"-DCMAKE_BUILD_TYPE=Release",
				"-DBUILD_SHARED_LIBS=OFF",
				"-DWHISPER_BUILD_TESTS=OFF",
				"-DWHISPER_BUILD_SERVER=OFF",
			],
			progress,
			{ cwd: src },
		);
		if (configure !== 0) return fail(`cmake exit ${configure ?? "not started"}`);
		const build = await run(
			"cmake",
			["--build", "build", "-j", jobs, "--config", "Release", "--target", "whisper-cli"],
			progress,
			{ cwd: src },
		);
		if (build !== 0) return fail(`build exit ${build ?? "not started"}`);
		const built = join(src, "build", "bin", "whisper-cli");
		if (!exists(built)) return fail("whisper-cli was not produced");
		const dest = managedWhisperBin(env);
		mkdirSync(join(eightDir(env), "bin"), { recursive: true });
		copy(built, dest);
		return { path: dest };
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	} finally {
		rmQuiet(work);
	}
}

// ── leftover recordings ──────────────────────────────────────────────────

const VOICE_DIR_PREFIX = "8gent-voice-";
/** A live recording is at most the limit plus the longest transcription; nothing newer is a leftover. */
export const VOICE_DIR_GRACE_MS = RECORD_LIMIT_S * 1000 + TRANSCRIBE_TIMEOUT_MS + 30_000;

export interface SweepDeps {
	tmp?: string;
	/** The owner a directory must have; null skips the owner check (no uid on this platform). */
	uid?: number | null;
	now?: number;
	/** Only directories last touched before now minus this are removed. */
	graceMs?: number;
	remove?: (p: string) => void;
}

/**
 * Remove `8gent-voice-*` directories an earlier run left behind (killed, crashed,
 * or exited mid-recording). Only real directories (never a symlink) owned by this
 * user, and only ones too old to be a recording still in progress in another
 * session. Returns the paths removed. Never throws.
 */
export function sweepVoiceDirs(deps: SweepDeps = {}): string[] {
	const tmp = deps.tmp ?? tmpdir();
	const uid = deps.uid === undefined ? (process.getuid?.() ?? null) : deps.uid;
	const cutoff = (deps.now ?? Date.now()) - (deps.graceMs ?? VOICE_DIR_GRACE_MS);
	const remove = deps.remove ?? rmQuiet;
	const removed: string[] = [];
	let names: string[] = [];
	try {
		names = readdirSync(tmp).filter((n) => n.startsWith(VOICE_DIR_PREFIX));
	} catch {
		return removed;
	}
	for (const n of names) {
		const p = join(tmp, n);
		try {
			const st = lstatSync(p);
			if (!st.isDirectory() || st.isSymbolicLink()) continue;
			if (uid !== null && st.uid !== uid) continue;
			if (st.mtimeMs >= cutoff) continue;
			remove(p);
			removed.push(p);
		} catch {}
	}
	return removed;
}

// ── record, convert, transcribe ──────────────────────────────────────────

export type ListenResult = { text: string } | { error: string };

export interface RecordDeps {
	run?: Run;
	/** Run a command and collect its stdout. Resolves null when it could not start. */
	capture?: (
		cmd: string,
		args: string[],
		timeoutMs: number,
	) => Promise<{ code: number | null; out: string }>;
	/** A fresh private directory for the two audio files. */
	makeDir?: () => string;
	removeDir?: (dir: string) => void;
	/** Byte size of a file, or -1 when it does not exist. */
	size?: (path: string) => number;
	sleep?: (ms: number) => Promise<void>;
	whisperBin: string;
	modelPath: string;
	limitS?: number;
	threads?: number;
	/** Sweep old 8gent-voice-* directories before recording. Tests pass a recorder or turn it off. */
	sweep?: () => void;
	/** Stop the recorder without waiting, for the exit path where nothing async can run. */
	quitSync?: () => void;
}

export interface Recording {
	/** Stop recording and transcribe. Safe to call more than once. */
	stop(): void;
	/** Throw the recording away: stop the mic, delete the audio, transcribe nothing. For unmount and exit. */
	abort(): void;
	/** Resolves once the recording is stopped (by stop() or the limit) and transcribed. */
	done: Promise<ListenResult>;
}

function defaultRun(
	cmd: string,
	args: string[],
	onLine: (l: string) => void,
	opts: { cwd?: string } = {},
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
			const child = nodeSpawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], cwd: opts.cwd });
			const onData = (d: unknown) => {
				const line = String(d)
					.split(/[\r\n]+/)
					.filter(Boolean)
					.pop()
					// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
					?.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
					.trim();
				if (line) onLine(line.slice(0, 100));
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

export { defaultRun as runCommand };

function defaultCapture(
	cmd: string,
	args: string[],
	timeoutMs: number,
): Promise<{ code: number | null; out: string }> {
	return new Promise((resolve) => {
		let out = "";
		let settled = false;
		const done = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code, out });
		};
		let child: ReturnType<typeof nodeSpawn> | undefined;
		const timer = setTimeout(() => {
			try {
				child?.kill("SIGKILL");
			} catch {}
			done(null);
		}, timeoutMs);
		try {
			child = nodeSpawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"] });
			child.stdout?.on("data", (d) => {
				out += String(d);
			});
			child.on("error", () => done(null));
			child.on("close", (c) => done(c));
		} catch {
			done(null);
		}
	});
}

/** whisper-cli prints the text on stdout; drop blank-audio markers and control characters. */
export function cleanWhisperText(out: string): string {
	return (
		out
			.replace(/\[BLANK_AUDIO\]|\(silence\)|\[inaudible\]/gi, " ")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
			.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
			.replace(/\p{Cf}/gu, "")
			.replace(/\s+/g, " ")
			.trim()
	);
}

/**
 * The whisper-cli argument list. Kept in one place so the e2e test runs the exact call shape.
 * -ng: CPU only. The phone build has no GPU backend, and a GPU backend that cannot get a
 * buffer aborts whisper-cli (seen with Metal inside a sandbox on 24 Oct 2026).
 */
export function whisperArgs(modelPath: string, wavPath: string, threads: number): string[] {
	return ["-m", modelPath, "-f", wavPath, "-l", "en", "-nt", "-np", "-ng", "-t", String(threads)];
}

/** The ffmpeg argument list: any recorder output to 16 kHz mono 16-bit WAV. */
export function ffmpegArgs(input: string, wavPath: string): string[] {
	return [
		"-nostdin",
		"-y",
		"-loglevel",
		"error",
		"-i",
		input,
		"-ar",
		"16000",
		"-ac",
		"1",
		"-c:a",
		"pcm_s16le",
		wavPath,
	];
}

/** Convert and transcribe one recorded file. Does not delete it; the caller owns cleanup. */
export async function transcribeFile(
	input: string,
	wavPath: string,
	deps: Pick<RecordDeps, "capture" | "whisperBin" | "modelPath" | "threads">,
): Promise<ListenResult> {
	const capture = deps.capture ?? defaultCapture;
	const threads = deps.threads ?? Math.max(1, Math.min(4, availableParallelism()));
	const conv = await capture("ffmpeg", ffmpegArgs(input, wavPath), 30_000);
	if (conv.code !== 0) return { error: convertFailedLine };
	const w = await capture(
		deps.whisperBin,
		whisperArgs(deps.modelPath, wavPath, threads),
		TRANSCRIBE_TIMEOUT_MS,
	);
	if (w.code !== 0)
		return {
			error:
				w.code === null
					? "Transcription took too long and was stopped."
					: `whisper.cpp failed (exit ${w.code}).`,
		};
	const text = cleanWhisperText(w.out);
	return text ? { text } : { error: heardNothingLine };
}

/**
 * Start recording. The returned handle stops on stop() or after the limit,
 * then converts, transcribes and deletes the audio, whatever the outcome.
 */
export async function startRecording(deps: RecordDeps): Promise<Recording | { error: string }> {
	const run = deps.run ?? defaultRun;
	const makeDir = deps.makeDir ?? (() => mkdtempSync(join(tmpdir(), "8gent-voice-")));
	const removeDir = deps.removeDir ?? rmQuiet;
	const size =
		deps.size ??
		((p: string) => {
			try {
				return statSync(p).size;
			} catch {
				return -1;
			}
		});
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const limitS = deps.limitS ?? RECORD_LIMIT_S;

	try {
		(deps.sweep ?? (() => void sweepVoiceDirs()))();
	} catch {}
	const dir = makeDir();
	const recorded = join(dir, "voice.m4a");
	const wav = join(dir, "voice.wav");
	const started = await run(
		RECORD_TOOL.bin,
		["-f", recorded, "-l", String(limitS), "-e", "aac", "-r", "16000", "-c", "1"],
		() => {},
	);
	if (started !== 0) {
		removeDir(dir);
		return { error: recordFailedLine };
	}

	let stopRequested: () => void = () => {};
	const stopped = new Promise<void>((r) => {
		stopRequested = r;
	});
	const timer = setTimeout(() => stopRequested(), limitS * 1000);

	// If 8gent ends mid-recording (Ctrl+C, /exit, a crash that still runs 'exit',
	// SIGTERM from Termux) nothing async runs, so stop the mic and delete the
	// audio synchronously. SIGKILL cannot be caught: the recorder's own limit ends
	// the mic and the next start's sweep removes the directory.
	const quitSync =
		deps.quitSync ??
		(() => {
			try {
				spawnSync(RECORD_TOOL.bin, ["-q"], { stdio: "ignore", timeout: 3000 });
			} catch {}
		});
	const exitCleanup = () => {
		try {
			quitSync();
		} catch {}
		try {
			removeDir(dir);
		} catch {}
	};
	const onSignal = (sig: NodeJS.Signals) => {
		exitCleanup();
		unregister();
		// Keep the signal's meaning: with no other handler, end the process as it would have ended.
		if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
	};
	const onInt = () => onSignal("SIGINT");
	const onTerm = () => onSignal("SIGTERM");
	function unregister(): void {
		process.off("exit", exitCleanup);
		process.off("SIGINT", onInt);
		process.off("SIGTERM", onTerm);
	}
	process.on("exit", exitCleanup);
	process.on("SIGINT", onInt);
	process.on("SIGTERM", onTerm);

	let aborted = false;
	const done = (async (): Promise<ListenResult> => {
		await stopped;
		clearTimeout(timer);
		try {
			if (aborted) return { error: "Recording cancelled." };
			// Harmless when the limit already ended it.
			await run(RECORD_TOOL.bin, ["-q"], () => {});
			// The Termux:API app finishes writing after -q returns: wait for the size to settle.
			let last = -2;
			for (let i = 0; i < 20; i++) {
				const s = size(recorded);
				if (s > 0 && s === last) break;
				last = s;
				await sleep(150);
			}
			if (size(recorded) <= 0) return { error: noAudioLine };
			return await transcribeFile(recorded, wav, deps);
		} catch (err) {
			return { error: `Voice error: ${err instanceof Error ? err.message : String(err)}` };
		} finally {
			removeDir(dir);
			unregister();
		}
	})();

	return {
		stop: () => stopRequested(),
		abort: () => {
			aborted = true;
			exitCleanup();
			stopRequested();
		},
		done,
	};
}
