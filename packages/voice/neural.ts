/**
 * Neural voice casting and synthesis - the one table (#3346).
 *
 * Every spoken deliverable (deck videos, huddles, officer updates) casts its
 * speakers from NEURAL_VOICE below and synthesises through Supertonic or
 * KittenTTS. There is deliberately no macOS say code path in this module: if
 * the pinned engine fails, the caller gets a typed NeuralTtsError and decides
 * what to do. A deliverable never silently degrades to a system voice.
 *
 * Fallback to the other neural engine is opt-in (SynthRequest.allowFallback,
 * default false). The fallback styles collide with other officers' pinned
 * voices (every Supertonic voice falls back to Kitten Jasper, which is Alex;
 * Victoria falls back to Supertonic F3, which is Karen), so a silent fallback
 * would misattribute who said what. A caller that opts in must label the output
 * from SynthResult.fellBack.
 *
 * Canon: NEURAL_VOICE in 8gent-glasses mac/scripts/deck2video.py and the
 * DeckToVideo skill table, ruled canonical by James on 2026-10-02.
 *
 * Officer codes map onto table names (OFFICERS). The mapping is fixed so no
 * two officers share an (engine, style). This replaces the huddle table in
 * packages/table/huddle-voice.ts, where 8EO/8SO were both F3 and 8CO/8GO were
 * both M2:
 *
 *   8EO AIJames  -> Daniel   Supertonic M2  (AI James is the default narrator)
 *   8TO Rishi    -> Rishi    Supertonic M3
 *   8PO Samantha -> Samantha Supertonic F1
 *   8DO Moira    -> Moira    Supertonic F2
 *   8SO Karen    -> Karen    Supertonic F3
 *   8MO Zara     -> Zara     Supertonic F5
 *   8GO Solomon  -> Reed     Supertonic M4
 *   8CO Luis     -> Fred     KittenTTS Bruno  (Luis was already Bruno in deck2video-lite)
 *
 * Voice Experience Contract point 2: casting is a pure lookup. No randomness,
 * no keyword routing, no inference from content.
 *
 * Synthesis is async. Engines run as child processes awaited through
 * node:child_process spawn, never a synchronous spawn, so a deck render inside
 * the Ink TUI keeps the event loop (and the screen) live while an engine works.
 */

import { spawn as spawnChild } from "node:child_process";
import {
	constants,
	accessSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";

export type NeuralEngine = "supertonic" | "kitten";

export interface NeuralVoice {
	engine: NeuralEngine;
	/** Supertonic style (F1-F5, M1-M5) or KittenTTS voice name. */
	style: string;
	/**
	 * Style on the OTHER engine, used only when the pinned engine fails AND the
	 * caller set allowFallback. These collide with other officers' voices.
	 */
	fallback: string;
}

const st = (style: string): NeuralVoice => ({ engine: "supertonic", style, fallback: "Jasper" });
const kt = (style: string, fallback = "M2"): NeuralVoice => ({ engine: "kitten", style, fallback });

/** The casting table. Fallback styles mirror deck2video.py's narrate(). */
export const NEURAL_VOICE: Readonly<Record<string, NeuralVoice>> = {
	Daniel: st("M2"),
	Moira: st("F2"),
	Karen: st("F3"),
	Samantha: st("F1"),
	Tessa: st("F4"),
	Reed: st("M4"),
	Rishi: st("M3"),
	Zara: st("F5"),
	Fred: kt("Bruno", "M5"),
	Ralph: kt("Hugo"),
	Albert: kt("Leo"),
	Alex: kt("Jasper"),
	Victoria: kt("Rosie", "F3"),
	Kathy: kt("Kiki"),
	Allison: kt("Luna"),
	Ava: kt("Bella"),
};

export const NARRATOR = "Daniel";

/** Officer code -> first name and table voice. See the header for the rationale. */
export const OFFICERS: Readonly<Record<string, { name: string; voice: string }>> = {
	"8EO": { name: "AIJames", voice: "Daniel" },
	"8TO": { name: "Rishi", voice: "Rishi" },
	"8PO": { name: "Samantha", voice: "Samantha" },
	"8DO": { name: "Moira", voice: "Moira" },
	"8SO": { name: "Karen", voice: "Karen" },
	"8MO": { name: "Zara", voice: "Zara" },
	"8GO": { name: "Solomon", voice: "Reed" },
	"8CO": { name: "Luis", voice: "Fred" },
};

export const KITTEN_MODEL = "KittenML/kitten-tts-nano-0.8";
/** The guard: a binary with this basename, or resolving to it, is refused before it can run. */
const MAC_SAY_BASENAME = "say";

export type NeuralErrorCode =
	| "unpinned_voice"
	| "empty_text"
	| "no_engine"
	/** The pinned engine failed and the caller did not allow fallback. */
	| "engine_failed"
	/** The pinned engine and the opted-in fallback both failed. */
	| "all_engines_failed"
	/** outPath is a directory, or a file there cannot be replaced. */
	| "bad_out_path";

export interface Attempt {
	engine: NeuralEngine;
	style: string;
	ok: boolean;
	reason?: string;
}

export class NeuralTtsError extends Error {
	constructor(
		readonly code: NeuralErrorCode,
		message: string,
		readonly attempts: Attempt[] = [],
	) {
		super(message);
		this.name = "NeuralTtsError";
	}
}

export interface ResolvedVoice extends NeuralVoice {
	/** The table name the input resolved to. */
	name: string;
	/** False only for a lenient lookup that fell back to the narrator. */
	pinned: boolean;
}

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const LOOKUP: ReadonlyMap<string, string> = new Map([
	...Object.keys(NEURAL_VOICE).map((n) => [key(n), n] as const),
	...Object.entries(OFFICERS).flatMap(([code, o]) => [
		[key(code), o.voice] as const,
		[key(o.name), o.voice] as const,
	]),
]);

/** Resolve a table name, officer code or officer first name. Pure. */
export function resolveVoice(
	nameOrCode: string,
	opts: { strict?: boolean } = {},
): { ok: true; voice: ResolvedVoice } | { ok: false; error: NeuralTtsError } {
	const name = LOOKUP.get(key(nameOrCode));
	if (name) return { ok: true, voice: { name, ...NEURAL_VOICE[name], pinned: true } };
	if (opts.strict === false)
		return { ok: true, voice: { name: NARRATOR, ...NEURAL_VOICE[NARRATOR], pinned: false } };
	return {
		ok: false,
		error: new NeuralTtsError(
			"unpinned_voice",
			`voice "${nameOrCode}" is not in NEURAL_VOICE; pin it there`,
		),
	};
}

// ── Engine discovery ──────────────────────────────────────────────────────

export interface SpawnResult {
	status: number | null;
	stderr: string;
}

/** Everything that touches the machine, injectable so tests need no engines. */
export interface NeuralDeps {
	env: Record<string, string | undefined>;
	home: string;
	exists(path: string): boolean;
	/** Bytes in a regular file; 0 when it is missing, empty or not a file. */
	fileSize(path: string): number;
	remove(path: string): void;
	/** The path with symlinks resolved; the input when it cannot be resolved. */
	realpath(path: string): string;
	/** A fresh private directory, used as the engines' cwd. */
	makeTempDir(): string;
	removeTree(dir: string): void;
	which(cmd: string): string | null;
	listDir(dir: string): string[];
	spawn(
		cmd: string,
		args: string[],
		opts: { input?: string; timeoutMs: number; cwd?: string },
	): Promise<SpawnResult>;
}

/**
 * PATH lookup without a subprocess: the first ABSOLUTE PATH entry holding a
 * regular executable file named cmd. Empty, "." and relative entries are
 * skipped, so a supertonic in whatever directory 8gent was started from (an
 * untrusted clone, say) is never picked up.
 */
export function whichOnPath(cmd: string, path = process.env.PATH ?? ""): string | null {
	for (const dir of path.split(delimiter)) {
		if (!dir || !isAbsolute(dir)) continue;
		const p = join(dir, cmd);
		try {
			if (!statSync(p).isFile()) continue;
			accessSync(p, constants.X_OK);
			return p;
		} catch {}
	}
	return null;
}

/** Most stderr kept from one child; the tail, where tracebacks end. */
export const STDERR_MAX = 16_384;

/**
 * Run argv without a shell and without blocking. Resolves (never rejects) with
 * the exit status, or null when the process could not start or hit the timeout.
 */
export function spawnAsync(
	cmd: string,
	args: string[],
	opts: { input?: string; timeoutMs: number; cwd?: string },
): Promise<SpawnResult> {
	return new Promise((resolve) => {
		let stderr = "";
		let settled = false;
		const child = spawnChild(cmd, args, { stdio: ["pipe", "ignore", "pipe"], cwd: opts.cwd });
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			done(null, `timed out after ${opts.timeoutMs} ms`);
		}, opts.timeoutMs);
		const done = (status: number | null, extra = "") => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ status, stderr: stderr + extra });
		};
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (d: string) => {
			stderr += d;
			if (stderr.length > STDERR_MAX) stderr = stderr.slice(-STDERR_MAX);
		});
		child.on("error", (e) => done(null, String(e)));
		child.on("close", (code) => done(code));
		child.stdin?.on("error", () => {});
		child.stdin?.end(opts.input ?? "");
	});
}

export function defaultDeps(): NeuralDeps {
	return {
		env: process.env,
		home: homedir(),
		exists: existsSync,
		fileSize: (p) => {
			try {
				const s = statSync(p);
				return s.isFile() ? s.size : 0;
			} catch {
				return 0;
			}
		},
		remove: (p) => rmSync(p, { force: true }),
		realpath: (p) => {
			try {
				return realpathSync(p);
			} catch {
				return p;
			}
		},
		makeTempDir: () => mkdtempSync(join(tmpdir(), "8gent-neural-")),
		removeTree: (d) => rmSync(d, { recursive: true, force: true }),
		which: (cmd) => whichOnPath(cmd),
		listDir: (dir) => {
			try {
				return readdirSync(dir);
			} catch {
				return [];
			}
		},
		spawn: spawnAsync,
	};
}

/** Newest pyenv version first, so the choice is stable across machines. */
function pyenvBins(deps: NeuralDeps, exe: string): string[] {
	const root = join(deps.home, ".pyenv/versions");
	return deps
		.listDir(root)
		.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
		.map((v) => join(root, v, "bin", exe));
}

/** Refuses say by name and by what the path really is (a renamed symlink to say). */
const usable = (deps: NeuralDeps, p: string) =>
	basename(p) !== MAC_SAY_BASENAME &&
	deps.exists(p) &&
	basename(deps.realpath(p)) !== MAC_SAY_BASENAME;
const dedupe = (xs: (string | null | undefined)[]) => [
	...new Set(xs.filter((x): x is string => !!x)),
];

export function supertonicCandidates(deps: NeuralDeps): string[] {
	return dedupe([
		deps.env.EIGHT_SUPERTONIC_BIN,
		deps.which("supertonic"),
		join(deps.home, ".pyenv/shims/supertonic"),
		...pyenvBins(deps, "supertonic"),
		"/opt/homebrew/bin/supertonic",
		"/usr/local/bin/supertonic",
	]);
}

export function kittenPythonCandidates(deps: NeuralDeps): string[] {
	const stBin = findSupertonic(deps);
	return dedupe([
		deps.env.EIGHT_TTS_PYTHON,
		stBin && join(dirname(stBin), "python3"),
		stBin && join(dirname(stBin), "python"),
		...pyenvBins(deps, "python3"),
		join(deps.home, ".pyenv/shims/python3"),
		deps.which("python3"),
	]);
}

export const findSupertonic = (deps: NeuralDeps) =>
	supertonicCandidates(deps).find((p) => usable(deps, p)) ?? null;
export const findKittenPython = (deps: NeuralDeps) =>
	kittenPythonCandidates(deps).find((p) => usable(deps, p)) ?? null;

// ── Synthesis ─────────────────────────────────────────────────────────────

/**
 * Loads the model once and writes every item. A failed item reports to stderr
 * and deletes its partial file, so on exit 0 a non-empty file means done.
 *
 * Under -c, Python puts the cwd first on sys.path, so a json.py or
 * kittentts.py in the caller's directory would run as code. Three guards:
 * the interpreter runs in a fresh temp dir, gets -P when it supports it
 * (3.11+), and this script drops "" and "." from sys.path before any other
 * import (sys is built in, so it cannot itself be shadowed).
 */
export const KITTEN_SCRIPT = [
	"import sys",
	'sys.path[:] = [p for p in sys.path if p not in ("", ".")]',
	"import json, os",
	"from kittentts import KittenTTS",
	"job = json.load(sys.stdin)",
	"m = KittenTTS(job['model'])",
	"for it in job['items']:",
	"    try: m.generate_to_file(it['text'], it['out'], voice=it['voice'])",
	"    except Exception as e:",
	"        print(it['out'], e, file=sys.stderr)",
	"        try: os.remove(it['out'])",
	"        except OSError: pass",
].join("\n");

export interface SynthRequest {
	text: string;
	/** Table name, officer code or officer first name. */
	voice: string;
	/**
	 * Where the WAV goes. A relative path is resolved against the caller's cwd
	 * (process.cwd()) before any engine runs, so both engines write to the same
	 * place; the result's path is always that absolute path.
	 */
	outPath: string;
	/** Default true: an unpinned voice is an error rather than the narrator. */
	strict?: boolean;
	/** Supertonic diffusion steps. Default 8, as deck2video. */
	steps?: number;
	/**
	 * Default false: a failed pinned engine is NeuralTtsError("engine_failed").
	 * True retries on the other engine with the table's fallback style, which
	 * may be another officer's pinned voice; label such output from fellBack.
	 */
	allowFallback?: boolean;
}

export type SynthResult =
	| {
			ok: true;
			path: string;
			voice: string;
			engine: NeuralEngine;
			style: string;
			fellBack: boolean;
			attempts: Attempt[];
	  }
	| { ok: false; error: NeuralTtsError };

/**
 * Synthesise many lines. Each line tries its pinned engine, then, only with
 * allowFallback, the other neural engine with its fallback style. Kitten lines
 * in a pass share one interpreter, so the model loads once per pass rather
 * than once per line. A line succeeds only on exit 0 AND a non-empty output
 * file; a failed attempt leaves no output file behind.
 */
export async function synthesizeBatch(
	input: SynthRequest[],
	deps: NeuralDeps = defaultDeps(),
): Promise<SynthResult[]> {
	// Kitten runs with its cwd set to a temp dir that is then deleted, so a
	// relative outPath must be pinned to the caller's cwd first, or Kitten
	// would write inside the temp dir and the line would silently fail.
	const reqs = input.map((r) => ({ ...r, outPath: resolve(r.outPath) }));
	const stBin = findSupertonic(deps);
	const py = findKittenPython(deps);
	const results: (SynthResult | undefined)[] = [];
	const plans: { name: string; steps: number; order: { engine: NeuralEngine; style: string }[] }[] =
		[];
	const attempts: Attempt[][] = reqs.map(() => []);

	reqs.forEach((req, i) => {
		const r = resolveVoice(req.voice, { strict: req.strict ?? true });
		const badOut = r.ok ? clearOutPath(deps, req.outPath) : null;
		if (!r.ok) results[i] = r;
		else if (badOut) results[i] = { ok: false, error: badOut };
		else if (!req.text.trim())
			results[i] = { ok: false, error: new NeuralTtsError("empty_text", "text is empty") };
		else if (!stBin && !py)
			results[i] = {
				ok: false,
				error: new NeuralTtsError("no_engine", "neither Supertonic nor KittenTTS found"),
			};
		const v = r.ok ? r.voice : { name: NARRATOR, ...NEURAL_VOICE[NARRATOR] };
		const other: NeuralEngine = v.engine === "supertonic" ? "kitten" : "supertonic";
		plans[i] = {
			name: v.name,
			steps: req.steps ?? 8,
			order: [
				{ engine: v.engine, style: v.style },
				...(req.allowFallback ? [{ engine: other, style: v.fallback }] : []),
			],
		};
	});

	for (const pass of [0, 1]) {
		const pending = reqs.map((_, i) => i).filter((i) => !results[i] && plans[i].order[pass]);
		for (const i of pending) deps.remove(reqs[i].outPath);
		const kittenIdx: number[] = [];
		for (const i of pending) {
			const { engine, style } = plans[i].order[pass];
			if (engine === "kitten") {
				kittenIdx.push(i);
				continue;
			}
			if (!stBin) {
				attempts[i].push({ engine, style, ok: false, reason: "Supertonic not found" });
				continue;
			}
			// Options first, then "--", then the text: a line such as "--help" or
			// "-o/x" is spoken, never parsed as an option.
			const args = [
				"tts",
				"-o",
				reqs[i].outPath,
				"--voice",
				style,
				"--steps",
				String(plans[i].steps),
				"--",
				reqs[i].text,
			];
			const r = await deps.spawn(stBin, args, { timeoutMs: 120_000 });
			const ok = r.status === 0 && deps.fileSize(reqs[i].outPath) > 0;
			if (!ok) deps.remove(reqs[i].outPath);
			attempts[i].push({
				engine,
				style,
				ok,
				reason: ok ? undefined : r.stderr.trim() || `exit ${r.status}`,
			});
		}
		if (kittenIdx.length > 0) {
			const items = kittenIdx.map((i) => ({
				text: reqs[i].text,
				out: reqs[i].outPath,
				voice: plans[i].order[pass].style,
			}));
			const r = py
				? await runKitten(deps, py, items)
				: { status: null, stderr: "KittenTTS python not found" };
			kittenIdx.forEach((i, j) => {
				// Exit 0 means the batch finished; a SIGKILL at the timeout is
				// status null, so a half-written WAV never counts.
				const ok = !!py && r.status === 0 && deps.fileSize(items[j].out) > 0;
				if (!ok) deps.remove(items[j].out);
				attempts[i].push({
					engine: "kitten",
					style: items[j].voice,
					ok,
					reason: ok ? undefined : r.stderr.trim(),
				});
			});
		}
		for (const i of pending) {
			const last = attempts[i][attempts[i].length - 1];
			if (last?.ok) {
				results[i] = {
					ok: true,
					path: reqs[i].outPath,
					voice: plans[i].name,
					engine: last.engine,
					style: last.style,
					fellBack: pass === 1,
					attempts: attempts[i],
				};
			}
		}
	}

	return reqs.map(
		(req, i) =>
			results[i] ??
			(plans[i].order.length > 1
				? {
						ok: false,
						error: new NeuralTtsError(
							"all_engines_failed",
							`both neural engines failed for "${req.voice}" (${req.outPath})`,
							attempts[i],
						),
					}
				: {
						ok: false,
						error: new NeuralTtsError(
							"engine_failed",
							`pinned engine ${plans[i].order[0].engine} failed for "${req.voice}" (${req.outPath}); fallback is off (allowFallback)`,
							attempts[i],
						),
					}),
	);
}

/**
 * Clear any stale file at outPath, so only this run's output can count. A
 * directory (or anything else that cannot be removed) is a typed bad_out_path
 * error rather than a thrown EISDIR. Null when the path is usable.
 */
function clearOutPath(deps: NeuralDeps, outPath: string): NeuralTtsError | null {
	try {
		deps.remove(outPath);
		return null;
	} catch (e) {
		const code = (e as { code?: string }).code ?? "";
		const why = /EISDIR/.test(code)
			? "is a directory"
			: `cannot be replaced (${code || String(e)})`;
		return new NeuralTtsError("bad_out_path", `outPath ${outPath} ${why}`);
	}
}

/**
 * Run the Kitten batch in a fresh temp dir, with -P when the interpreter
 * takes it. The probe is `python -P -c pass`: exit 0 on 3.11+, exit 2
 * ("Unknown option") before. Both spawns use the temp dir as cwd.
 */
async function runKitten(
	deps: NeuralDeps,
	py: string,
	items: { text: string; out: string; voice: string }[],
): Promise<SpawnResult> {
	const cwd = deps.makeTempDir();
	try {
		const probe = await deps.spawn(py, ["-P", "-c", "pass"], { timeoutMs: 15_000, cwd });
		const flags = probe.status === 0 ? ["-P"] : [];
		return await deps.spawn(py, [...flags, "-c", KITTEN_SCRIPT], {
			input: JSON.stringify({ model: KITTEN_MODEL, items }),
			timeoutMs: 60_000 + 30_000 * items.length,
			cwd,
		});
	} finally {
		deps.removeTree(cwd);
	}
}

export async function synthesize(
	req: SynthRequest,
	deps: NeuralDeps = defaultDeps(),
): Promise<SynthResult> {
	return (await synthesizeBatch([req], deps))[0];
}
