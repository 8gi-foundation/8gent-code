/**
 * 8gent Code - speak tool helper
 *
 * Local neural text-to-speech for narrated media. Supertonic first, KittenTTS
 * second, mirroring ~/.8gent/bin/say-telegram. It NEVER falls back to macOS
 * `say` or espeak: if neither neural engine is installed the call fails with a
 * clear error and writes nothing, so existing media paths are untouched.
 *
 * Returns the wav path and its duration, read from the RIFF header (no ffprobe
 * dependency).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveHome } from "../core/home";

type Engine = "supertonic" | "kitten";

/** Fixed voice list. Same names and pins as say-telegram / deck2video. */
export const SPEAK_VOICES: Readonly<Record<string, { engine: Engine; id: string }>> = {
	Daniel: { engine: "supertonic", id: "M2" },
	Rishi: { engine: "supertonic", id: "M3" },
	Samantha: { engine: "supertonic", id: "F1" },
	Moira: { engine: "supertonic", id: "F2" },
	Karen: { engine: "supertonic", id: "F3" },
	Tessa: { engine: "supertonic", id: "F4" },
	Zara: { engine: "supertonic", id: "F5" },
	Reed: { engine: "supertonic", id: "M4" },
	Solomon: { engine: "supertonic", id: "M5" },
	AIJames: { engine: "supertonic", id: "M1" },
	Luis: { engine: "kitten", id: "Bruno" },
	Ralph: { engine: "kitten", id: "Hugo" },
	Albert: { engine: "kitten", id: "Leo" },
	Alex: { engine: "kitten", id: "Jasper" },
	Victoria: { engine: "kitten", id: "Rosie" },
	Kathy: { engine: "kitten", id: "Kiki" },
	Allison: { engine: "kitten", id: "Luna" },
	Ava: { engine: "kitten", id: "Bella" },
};

export const DEFAULT_VOICE = "Daniel";
export const MAX_SPEAK_CHARS = 2000;

export interface SpeakInput {
	text: string;
	voice?: string;
	/** Absolute .wav path, already checked by the caller; omitted: the creative folder. */
	out?: string;
	/** Abort kills the engine: SIGTERM to its process group, SIGKILL after KILL_GRACE_MS. */
	signal?: AbortSignal;
}

export interface SpeakResult {
	path: string;
	durationSec: number;
	voice: string;
	engine: Engine;
	kind: "audio";
}

/**
 * Where the engines and their model caches live. A sandboxed session (pilot,
 * per-run HOME) points $HOME at an empty dir, so engines resolved against it are
 * "not installed". Binaries and model caches are read from the account home;
 * the engine child never gets that home as its own HOME (see engineEnv).
 */
export function engineHome(): string {
	try {
		return os.userInfo().homedir || resolveHome();
	} catch {
		return resolveHome();
	}
}

/**
 * Allowlisted env for an engine child. HOME is a private throwaway dir, never the
 * account home. Supertonic's render path resolves its model through Path.home()
 * (config.py get_model_cache_dir ignores SUPERTONIC_CACHE_DIR), so that dir holds
 * one symlink to the supertonic3 cache and nothing else. HF_HUB_OFFLINE=1 keeps
 * a model fetch from writing anywhere.
 */
export function engineEnv(
	privateHome: string,
	realHome: string,
	src: Record<string, string | undefined> = process.env,
): Record<string, string> {
	const env: Record<string, string> = {
		HOME: privateHome,
		HF_HOME: path.join(realHome, ".cache", "huggingface"),
		SUPERTONIC_CACHE_DIR: path.join(realHome, ".cache", "supertonic3"),
		HF_HUB_OFFLINE: "1",
	};
	for (const k of ["PATH", "LANG", "LC_ALL", "TMPDIR"]) {
		const v = src[k];
		if (v) env[k] = v;
	}
	return env;
}

function makePrivateHome(realHome: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "speak-home-"));
	const cache = path.join(realHome, ".cache", "supertonic3");
	if (fs.existsSync(cache)) {
		fs.mkdirSync(path.join(dir, ".cache"), { recursive: true });
		fs.symlinkSync(cache, path.join(dir, ".cache", "supertonic3"));
	}
	return dir;
}

const pyenvBin = (name: string) =>
	path.join(engineHome(), ".pyenv", "versions", "3.11.4", "bin", name);
const supertonicBin = () => process.env.EIGHT_SUPERTONIC_BIN?.trim() || pyenvBin("supertonic");
const kittenPy = () => process.env.EIGHT_KITTEN_PY?.trim() || pyenvBin("python");
const creativeDir = () => path.join(resolveHome(), ".8gent", "creative");

/** Grace between SIGTERM and SIGKILL when a caller aborts the engine. */
export const KILL_GRACE_MS = 1000;

function run(
	cmd: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	signal?: AbortSignal,
): Promise<boolean> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve(false);
		// Own process group (POSIX) so the engine and anything it forked can be signalled together.
		const detached = process.platform !== "win32";
		const child = spawn(cmd, args, { stdio: "ignore", detached, env });
		const send = (sig: NodeJS.Signals) => {
			try {
				if (detached && child.pid) process.kill(-child.pid, sig);
				else child.kill(sig);
			} catch {
				/* already gone */
			}
		};
		let hard: ReturnType<typeof setTimeout> | undefined;
		const onAbort = () => {
			send("SIGTERM");
			hard = setTimeout(() => send("SIGKILL"), KILL_GRACE_MS);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		const done = (ok: boolean) => {
			clearTimeout(hard);
			signal?.removeEventListener("abort", onAbort);
			resolve(ok);
		};
		child.on("error", () => done(false));
		child.on("close", (code) => done(code === 0));
	});
}

const KITTEN_SCRIPT =
	"import sys\nfrom kittentts import KittenTTS\n" +
	'KittenTTS("KittenML/kitten-tts-nano-0.8").generate_to_file(sys.argv[1], sys.argv[2], voice=sys.argv[3])\n';

const nonEmpty = (p: string) => fs.existsSync(p) && fs.statSync(p).size > 44;

async function synth(
	engine: Engine,
	id: string,
	text: string,
	out: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const bin = engine === "supertonic" ? supertonicBin() : kittenPy();
	if (!fs.existsSync(bin)) return false;
	const args =
		engine === "supertonic"
			? ["tts", "-o", out, "--voice", id, "--steps", "8", "--", text]
			: ["-c", KITTEN_SCRIPT, text, out, id];
	const real = engineHome();
	const home = makePrivateHome(real);
	try {
		return (
			(await run(bin, args, engineEnv(home, real) as NodeJS.ProcessEnv, signal)) && nonEmpty(out)
		);
	} finally {
		fs.rmSync(home, { recursive: true, force: true });
	}
}

/** Duration in seconds from a PCM wav header; throws if it is not a wav. */
export function wavDurationSec(file: string): number {
	const b = fs.readFileSync(file);
	if (
		b.length < 44 ||
		b.toString("ascii", 0, 4) !== "RIFF" ||
		b.toString("ascii", 8, 12) !== "WAVE"
	) {
		throw new Error("not a RIFF/WAVE file");
	}
	let byteRate = 0;
	let off = 12;
	while (off + 8 <= b.length) {
		const id = b.toString("ascii", off, off + 4);
		let size = b.readUInt32LE(off + 4);
		if (id === "fmt ") byteRate = b.readUInt32LE(off + 16);
		if (id === "data") {
			if (!byteRate) throw new Error("wav has no fmt chunk");
			if (size === 0xffffffff || off + 8 + size > b.length) size = b.length - off - 8;
			return Math.round((size / byteRate) * 100) / 100;
		}
		off += 8 + size + (size % 2);
	}
	throw new Error("wav has no data chunk");
}

/** `out` is an absolute path the caller already vetted (safePath); default is the creative folder. */
function resolveOut(out?: string): string {
	if (!out) return path.join(creativeDir(), `speak-${Date.now()}.wav`);
	if (!out.toLowerCase().endsWith(".wav")) throw new Error(`out must end in .wav ("${out}")`);
	return path.resolve(out);
}

export async function speak(input: SpeakInput): Promise<SpeakResult> {
	const text = (input.text ?? "").trim();
	if (!text) throw new Error("text is required");
	if (text.length > MAX_SPEAK_CHARS) {
		throw new Error(`text is ${text.length} chars; the cap is ${MAX_SPEAK_CHARS}`);
	}
	const voice = input.voice ?? DEFAULT_VOICE;
	const pin = SPEAK_VOICES[voice];
	if (!pin)
		throw new Error(
			`unknown voice "${voice}"; choose one of: ${Object.keys(SPEAK_VOICES).join(", ")}`,
		);

	const signal = input.signal;
	const out = resolveOut(input.out);
	fs.mkdirSync(path.dirname(out), { recursive: true });
	fs.rmSync(out, { force: true });

	// Preferred engine, then the other engine's default voice (as say-telegram does).
	const ladder: Array<[Engine, string]> =
		pin.engine === "supertonic"
			? [
					["supertonic", pin.id],
					["kitten", "Jasper"],
				]
			: [
					["kitten", pin.id],
					["supertonic", "M2"],
				];
	for (const [engine, id] of ladder) {
		if (signal?.aborted) throw new Error("speak aborted");
		if (await synth(engine, id, text, out, signal)) {
			return { path: out, durationSec: wavDurationSec(out), voice, engine, kind: "audio" };
		}
		fs.rmSync(out, { force: true });
	}
	throw new Error(
		"no local neural TTS engine is installed or working (Supertonic, KittenTTS); not falling back to say or espeak",
	);
}
