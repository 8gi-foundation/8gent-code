/**
 * Tests for the one neural voice-casting table (#3346, PR 1).
 *
 * None of these need Supertonic, KittenTTS or Python installed. Every spawn and
 * every filesystem probe goes through injected deps, so the tests pin the
 * logic: casting, discovery order, fallback order, and that macOS say is
 * unreachable.
 */

import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	NARRATOR,
	NEURAL_VOICE,
	type NeuralDeps,
	NeuralTtsError,
	OFFICERS,
	STDERR_MAX,
	type SpawnResult,
	defaultDeps,
	findSupertonic,
	kittenPythonCandidates,
	resolveVoice,
	spawnAsync,
	supertonicCandidates,
	synthesize,
	synthesizeBatch,
	whichOnPath,
} from "./neural.ts";

const HOME = "/Users/test";

interface Call {
	cmd: string;
	args: string[];
	input?: string;
	cwd?: string;
}

const TMP = "/tmp/neural-fake";

/** A fake machine. `files` is what exists; `engines` says which engine works. */
function fakeDeps(opts: {
	files?: string[];
	env?: Record<string, string>;
	which?: Record<string, string>;
	pyenvVersions?: string[];
	links?: Record<string, string>;
	supertonicWorks?: boolean;
	kittenWorks?: boolean;
	/** Default true: the interpreter accepts -P (Python 3.11+). */
	pythonHasP?: boolean;
}): NeuralDeps & {
	calls: Call[];
	files: Set<string>;
	sizes: Map<string, number>;
	trees: string[];
} {
	const files = new Set(opts.files ?? []);
	const sizes = new Map<string, number>();
	const calls: Call[] = [];
	const trees: string[] = [];
	const deps = {
		calls,
		files,
		sizes,
		trees,
		env: opts.env ?? {},
		home: HOME,
		exists: (p: string) => files.has(p),
		fileSize: (p: string) => (files.has(p) ? (sizes.get(p) ?? 1) : 0),
		remove: (p: string) => {
			files.delete(p);
		},
		realpath: (p: string) => opts.links?.[p] ?? p,
		makeTempDir: () => TMP,
		removeTree: (d: string) => {
			trees.push(d);
		},
		which: (cmd: string) => opts.which?.[cmd] ?? null,
		listDir: (dir: string) =>
			dir === join(HOME, ".pyenv/versions") ? (opts.pyenvVersions ?? []) : [],
		spawn: async (
			cmd: string,
			args: string[],
			o: { input?: string; cwd?: string },
		): Promise<SpawnResult> => {
			calls.push({ cmd, args, input: o.input, cwd: o.cwd });
			if (basename(cmd) === "supertonic") {
				if (!opts.supertonicWorks) return { status: 1, stderr: "model load failed" };
				files.add(args[args.indexOf("-o") + 1]);
				return { status: 0, stderr: "" };
			}
			// The -P capability probe.
			if (args.at(-1) === "pass") return { status: opts.pythonHasP === false ? 2 : 0, stderr: "" };
			// Kitten: a python interpreter running the batch script.
			if (!opts.kittenWorks) return { status: 1, stderr: "No module named kittentts" };
			const job = JSON.parse(o.input ?? "{}") as { items: { out: string }[] };
			for (const it of job.items) files.add(it.out);
			return { status: 0, stderr: "" };
		},
	};
	return deps;
}

/** The calls that ran the Kitten batch script (not the -P probe). */
const kittenRuns = (calls: Call[]) =>
	calls.filter((c) => basename(c.cmd) !== "supertonic" && c.args.at(-1) !== "pass");

const ST = "/opt/homebrew/bin/supertonic";
const PY = "/opt/homebrew/bin/python3";
const both = () =>
	fakeDeps({
		files: [ST, PY],
		which: { supertonic: ST, python3: PY },
		supertonicWorks: true,
		kittenWorks: true,
	});

describe("casting table", () => {
	test("matches the DeckToVideo canon exactly", () => {
		expect(NEURAL_VOICE).toEqual({
			Daniel: { engine: "supertonic", style: "M2", fallback: "Jasper" },
			Moira: { engine: "supertonic", style: "F2", fallback: "Jasper" },
			Karen: { engine: "supertonic", style: "F3", fallback: "Jasper" },
			Samantha: { engine: "supertonic", style: "F1", fallback: "Jasper" },
			Tessa: { engine: "supertonic", style: "F4", fallback: "Jasper" },
			Reed: { engine: "supertonic", style: "M4", fallback: "Jasper" },
			Rishi: { engine: "supertonic", style: "M3", fallback: "Jasper" },
			Zara: { engine: "supertonic", style: "F5", fallback: "Jasper" },
			Fred: { engine: "kitten", style: "Bruno", fallback: "M5" },
			Ralph: { engine: "kitten", style: "Hugo", fallback: "M2" },
			Albert: { engine: "kitten", style: "Leo", fallback: "M2" },
			Alex: { engine: "kitten", style: "Jasper", fallback: "M2" },
			Victoria: { engine: "kitten", style: "Rosie", fallback: "F3" },
			Kathy: { engine: "kitten", style: "Kiki", fallback: "M2" },
			Allison: { engine: "kitten", style: "Luna", fallback: "M2" },
			Ava: { engine: "kitten", style: "Bella", fallback: "M2" },
		});
		expect(NARRATOR).toBe("Daniel");
	});

	test("no two table names share an (engine, style)", () => {
		const keys = Object.values(NEURAL_VOICE).map((v) => `${v.engine}:${v.style}`);
		expect(new Set(keys).size).toBe(keys.length);
	});

	test("every officer code resolves, and no two officers share a voice", () => {
		const codes = ["8EO", "8TO", "8PO", "8DO", "8SO", "8CO", "8MO", "8GO"];
		expect(Object.keys(OFFICERS).sort()).toEqual([...codes].sort());
		const seen = new Set<string>();
		for (const code of codes) {
			const r = resolveVoice(code);
			if (!r.ok) throw r.error;
			const key = `${r.voice.engine}:${r.voice.style}`;
			expect(seen.has(key)).toBe(false);
			seen.add(key);
		}
		expect(seen.size).toBe(8);
	});

	test("the huddle collisions are gone: 8EO/8SO and 8CO/8GO differ", () => {
		const style = (c: string) => {
			const r = resolveVoice(c);
			if (!r.ok) throw r.error;
			return `${r.voice.engine}:${r.voice.style}`;
		};
		expect(style("8EO")).not.toBe(style("8SO"));
		expect(style("8CO")).not.toBe(style("8GO"));
		expect(style("8MO")).toBe("supertonic:F5");
		expect(style("8TO")).toBe("supertonic:M3");
	});

	test("code, officer first name and table name resolve to the same voice", () => {
		for (const [code, o] of Object.entries(OFFICERS)) {
			const a = resolveVoice(code);
			const b = resolveVoice(o.name);
			const c = resolveVoice(o.voice);
			const d = resolveVoice(code.toLowerCase());
			if (!a.ok || !b.ok || !c.ok || !d.ok) throw new Error(`unresolved ${code}`);
			expect(b.voice).toEqual(a.voice);
			expect(c.voice).toEqual(a.voice);
			expect(d.voice).toEqual(a.voice);
		}
	});

	test("resolution is a pure lookup: same input, same answer, every time", () => {
		const first = JSON.stringify(resolveVoice("Solomon"));
		for (let i = 0; i < 50; i++) expect(JSON.stringify(resolveVoice("Solomon"))).toBe(first);
	});

	test("an unpinned name is a typed error by default, the narrator when lenient", () => {
		const strict = resolveVoice("Bob");
		expect(strict.ok).toBe(false);
		if (!strict.ok) {
			expect(strict.error).toBeInstanceOf(NeuralTtsError);
			expect(strict.error.code).toBe("unpinned_voice");
		}
		const lenient = resolveVoice("Bob", { strict: false });
		expect(lenient.ok).toBe(true);
		if (lenient.ok) {
			expect(lenient.voice.name).toBe("Daniel");
			expect(lenient.voice.pinned).toBe(false);
		}
	});
});

describe("engine discovery", () => {
	test("Supertonic order: env, PATH, pyenv shim, pyenv versions (newest first), Homebrew, /usr/local", () => {
		const deps = fakeDeps({
			env: { EIGHT_SUPERTONIC_BIN: "/custom/supertonic" },
			which: { supertonic: "/on/path/supertonic" },
			pyenvVersions: ["3.9.18", "3.11.4", "3.10.2"],
		});
		expect(supertonicCandidates(deps)).toEqual([
			"/custom/supertonic",
			"/on/path/supertonic",
			`${HOME}/.pyenv/shims/supertonic`,
			`${HOME}/.pyenv/versions/3.11.4/bin/supertonic`,
			`${HOME}/.pyenv/versions/3.10.2/bin/supertonic`,
			`${HOME}/.pyenv/versions/3.9.18/bin/supertonic`,
			"/opt/homebrew/bin/supertonic",
			"/usr/local/bin/supertonic",
		]);
	});

	test("finds Supertonic that lives only under ~/.pyenv/versions/*/bin (the huddle miss)", async () => {
		const bin = `${HOME}/.pyenv/versions/3.11.4/bin/supertonic`;
		const deps = fakeDeps({ files: [bin], pyenvVersions: ["3.11.4"], supertonicWorks: true });
		const r = await synthesize({ text: "hello", voice: "Rishi", outPath: "/out/a.wav" }, deps);
		expect(r.ok).toBe(true);
		expect(deps.calls[0].cmd).toBe(bin);
		expect(deps.calls[0].args).toEqual([
			"tts",
			"-o",
			"/out/a.wav",
			"--voice",
			"M3",
			"--steps",
			"8",
			"--",
			"hello",
		]);
	});

	test("Kitten python order: env, python beside Supertonic, pyenv versions, pyenv shim, PATH", () => {
		const stBin = `${HOME}/.pyenv/versions/3.11.4/bin/supertonic`;
		const deps = fakeDeps({
			files: [stBin],
			env: { EIGHT_TTS_PYTHON: "/custom/python" },
			which: { python3: "/usr/bin/python3" },
			pyenvVersions: ["3.11.4"],
		});
		expect(kittenPythonCandidates(deps)).toEqual([
			"/custom/python",
			`${HOME}/.pyenv/versions/3.11.4/bin/python3`,
			`${HOME}/.pyenv/versions/3.11.4/bin/python`,
			`${HOME}/.pyenv/shims/python3`,
			"/usr/bin/python3",
		]);
	});

	test("no engine on the box is a typed no_engine error, and nothing is spawned", async () => {
		const deps = fakeDeps({});
		const r = await synthesize({ text: "hello", voice: "Rishi", outPath: "/out/a.wav" }, deps);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe("no_engine");
		expect(deps.calls).toEqual([]);
	});
});

describe("fallback order", () => {
	test("a Supertonic voice uses Supertonic first and does not touch Kitten when it works", async () => {
		const deps = both();
		const r = await synthesize({ text: "hi", voice: "Moira", outPath: "/o/m.wav" }, deps);
		expect(r.ok && r.engine).toBe("supertonic");
		expect(r.ok && r.fellBack).toBe(false);
		expect(deps.calls.map((c) => basename(c.cmd))).toEqual(["supertonic"]);
	});

	test("a Kitten voice uses Kitten first with its pinned style", async () => {
		const deps = both();
		const r = await synthesize({ text: "hi", voice: "Ava", outPath: "/o/a.wav" }, deps);
		expect(r.ok && r.engine).toBe("kitten");
		const runs = kittenRuns(deps.calls);
		expect(runs).toHaveLength(1);
		const job = JSON.parse(runs[0].input ?? "{}");
		expect(job.model).toBe("KittenML/kitten-tts-nano-0.8");
		expect(job.items).toEqual([{ text: "hi", out: "/o/a.wav", voice: "Bella" }]);
	});

	test("opted in: Supertonic failing falls back to Kitten with the canon fallback style", async () => {
		const deps = fakeDeps({
			files: [ST, PY],
			which: { supertonic: ST, python3: PY },
			kittenWorks: true,
		});
		const r = await synthesize(
			{ text: "hi", voice: "Rishi", outPath: "/o/r.wav", allowFallback: true },
			deps,
		);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.engine).toBe("kitten");
			expect(r.style).toBe("Jasper");
			expect(r.fellBack).toBe(true);
			expect(r.attempts.map((a) => `${a.engine}:${a.ok}`)).toEqual([
				"supertonic:false",
				"kitten:true",
			]);
		}
	});

	test("opted in: Kitten failing falls back to Supertonic with the canon fallback style", async () => {
		const deps = fakeDeps({
			files: [ST, PY],
			which: { supertonic: ST, python3: PY },
			supertonicWorks: true,
		});
		const r = await synthesize(
			{ text: "hi", voice: "Fred", outPath: "/o/f.wav", allowFallback: true },
			deps,
		);
		expect(r.ok && r.engine).toBe("supertonic");
		expect(r.ok && r.style).toBe("M5");
	});

	test("opted in: both engines failing is a typed all_engines_failed error naming every attempt", async () => {
		const deps = fakeDeps({ files: [ST, PY], which: { supertonic: ST, python3: PY } });
		const r = await synthesize(
			{ text: "hi", voice: "Karen", outPath: "/o/k.wav", allowFallback: true },
			deps,
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toBeInstanceOf(NeuralTtsError);
			expect(r.error.code).toBe("all_engines_failed");
			expect(r.error.attempts.map((a) => `${a.engine}:${a.style}`)).toEqual([
				"supertonic:F3",
				"kitten:Jasper",
			]);
		}
	});

	test("exit 0 without a written file is a failure, and a stale file does not count", async () => {
		const deps = fakeDeps({ files: [ST, "/o/stale.wav"], which: { supertonic: ST } });
		deps.spawn = async (cmd, args, o) => {
			deps.calls.push({ cmd, args, input: o.input });
			return { status: 0, stderr: "" }; // claims success, writes nothing
		};
		const r = await synthesize({ text: "hi", voice: "Daniel", outPath: "/o/stale.wav" }, deps);
		expect(r.ok).toBe(false);
	});

	test("a batch loads Kitten once for all its Kitten lines", async () => {
		const deps = both();
		const rs = await synthesizeBatch(
			[
				{ text: "one", voice: "Ava", outPath: "/o/1.wav" },
				{ text: "two", voice: "Daniel", outPath: "/o/2.wav" },
				{ text: "three", voice: "Kathy", outPath: "/o/3.wav" },
			],
			deps,
		);
		expect(rs.every((r) => r.ok)).toBe(true);
		const kittenCalls = kittenRuns(deps.calls);
		expect(kittenCalls).toHaveLength(1);
		expect(JSON.parse(kittenCalls[0].input ?? "{}").items).toHaveLength(2);
	});

	test("by default a failed pinned engine is engine_failed: no other officer's voice stands in", async () => {
		const deps = fakeDeps({
			files: [ST, PY],
			which: { supertonic: ST, python3: PY },
			kittenWorks: true,
		});
		const r = await synthesize({ text: "hi", voice: "Rishi", outPath: "/o/r.wav" }, deps);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error).toBeInstanceOf(NeuralTtsError);
			expect(r.error.code).toBe("engine_failed");
			expect(r.error.attempts.map((a) => `${a.engine}:${a.style}`)).toEqual(["supertonic:M3"]);
		}
		// Kitten worked, but it was never asked: Jasper is Alex's pinned voice.
		expect(kittenRuns(deps.calls)).toEqual([]);
		expect(deps.files.has("/o/r.wav")).toBe(false);
	});

	test("by default a failed Kitten voice does not borrow a Supertonic style", async () => {
		const deps = fakeDeps({
			files: [ST, PY],
			which: { supertonic: ST, python3: PY },
			supertonicWorks: true,
		});
		const r = await synthesize({ text: "hi", voice: "Victoria", outPath: "/o/v.wav" }, deps);
		expect(!r.ok && r.error.code).toBe("engine_failed");
		// F3 is Karen's pinned style; a degraded Victoria must not sound like 8SO.
		expect(deps.calls.filter((c) => basename(c.cmd) === "supertonic")).toEqual([]);
	});

	test("a missing pinned engine is engine_failed by default even when the other is installed", async () => {
		const deps = fakeDeps({ files: [PY], which: { python3: PY }, kittenWorks: true });
		const r = await synthesize({ text: "hi", voice: "Karen", outPath: "/o/k.wav" }, deps);
		expect(!r.ok && r.error.code).toBe("engine_failed");
		expect(!r.ok && r.error.attempts[0]?.reason).toBe("Supertonic not found");
	});

	test("a Kitten batch killed at the timeout fails every line and removes the partial WAVs", async () => {
		const deps = both();
		deps.spawn = async (cmd, args, o) => {
			deps.calls.push({ cmd, args, input: o.input, cwd: o.cwd });
			if (args.at(-1) === "pass") return { status: 0, stderr: "" };
			const job = JSON.parse(o.input ?? "{}") as { items: { out: string }[] };
			for (const it of job.items) deps.files.add(it.out); // half-written, then SIGKILL
			return { status: null, stderr: "timed out after 90000 ms" };
		};
		const rs = await synthesizeBatch(
			[
				{ text: "one", voice: "Ava", outPath: "/o/1.wav" },
				{ text: "two", voice: "Kathy", outPath: "/o/2.wav" },
			],
			deps,
		);
		expect(rs.map((r) => r.ok)).toEqual([false, false]);
		expect(deps.files.has("/o/1.wav")).toBe(false);
		expect(deps.files.has("/o/2.wav")).toBe(false);
	});

	test("Kitten exiting non-zero is a failure even if the file is on disk", async () => {
		const deps = both();
		deps.spawn = async (cmd, args, o) => {
			deps.calls.push({ cmd, args, input: o.input, cwd: o.cwd });
			if (args.at(-1) === "pass") return { status: 0, stderr: "" };
			deps.files.add("/o/a.wav");
			return { status: 1, stderr: "Traceback" };
		};
		const r = await synthesize({ text: "hi", voice: "Ava", outPath: "/o/a.wav" }, deps);
		expect(r.ok).toBe(false);
		expect(deps.files.has("/o/a.wav")).toBe(false);
	});

	test("an empty output file is a failure for either engine, and it is removed", async () => {
		for (const voice of ["Daniel", "Ava"]) {
			const deps = both();
			const real = deps.spawn;
			deps.spawn = async (cmd, args, o) => {
				const r = await real(cmd, args, o);
				for (const f of deps.files) if (f.startsWith("/o/")) deps.sizes.set(f, 0);
				return r;
			};
			const r = await synthesize({ text: "hi", voice, outPath: "/o/z.wav" }, deps);
			expect(r.ok).toBe(false);
			expect(deps.files.has("/o/z.wav")).toBe(false);
		}
	});

	test("a failed Supertonic line leaves no partial output behind", async () => {
		const deps = fakeDeps({ files: [ST], which: { supertonic: ST } });
		deps.spawn = async (cmd, args, o) => {
			deps.calls.push({ cmd, args, input: o.input });
			deps.files.add(args[args.indexOf("-o") + 1]);
			return { status: 1, stderr: "boom" };
		};
		const r = await synthesize({ text: "hi", voice: "Daniel", outPath: "/o/d.wav" }, deps);
		expect(r.ok).toBe(false);
		expect(deps.files.has("/o/d.wav")).toBe(false);
	});

	test("hostile lines go to Supertonic as text after --, never as options", async () => {
		const hostile = ["--help", "-o/x", "--custom-style-path=/tmp/x.json", "--voice=M1 hi", "-"];
		for (const text of hostile) {
			const deps = both();
			const r = await synthesize({ text, voice: "Rishi", outPath: "/o/h.wav" }, deps);
			expect(r.ok).toBe(true);
			const args = deps.calls[0].args;
			expect(args.at(-1)).toBe(text);
			expect(args.at(-2)).toBe("--");
			expect(args.indexOf("--")).toBe(args.length - 2);
			expect(args.slice(0, 7)).toEqual(["tts", "-o", "/o/h.wav", "--voice", "M3", "--steps", "8"]);
		}
	});

	test("empty text is a typed error, not a silent clip", async () => {
		const r = await synthesize({ text: "   ", voice: "Daniel", outPath: "/o/e.wav" }, both());
		expect(!r.ok && r.error.code).toBe("empty_text");
	});
});

describe("macOS say is unreachable", () => {
	test("no scenario ever spawns say", async () => {
		const scenarios = [
			both(),
			fakeDeps({ files: [ST, PY], which: { supertonic: ST, python3: PY } }),
			fakeDeps({ files: ["/usr/bin/say"], which: { say: "/usr/bin/say" } }),
		];
		for (const deps of scenarios) {
			for (const voice of [...Object.keys(NEURAL_VOICE), ...Object.keys(OFFICERS)]) {
				await synthesize({ text: "hi", voice, outPath: `/o/${voice}.wav` }, deps);
			}
			for (const c of deps.calls) expect(basename(c.cmd)).not.toBe("say");
		}
	});

	test("an env override pointing at say is refused, not spawned", async () => {
		const deps = fakeDeps({
			files: ["/usr/bin/say"],
			env: { EIGHT_SUPERTONIC_BIN: "/usr/bin/say", EIGHT_TTS_PYTHON: "/usr/bin/say" },
		});
		const r = await synthesize({ text: "hi", voice: "Rishi", outPath: "/o/r.wav" }, deps);
		expect(r.ok).toBe(false);
		expect(deps.calls).toEqual([]);
	});

	test("a binary that resolves to say through a symlink is refused by realpath", async () => {
		const deps = fakeDeps({
			files: ["/opt/x/supertonic", "/opt/x/python3", "/usr/bin/say"],
			env: { EIGHT_SUPERTONIC_BIN: "/opt/x/supertonic", EIGHT_TTS_PYTHON: "/opt/x/python3" },
			links: { "/opt/x/supertonic": "/usr/bin/say", "/opt/x/python3": "/usr/bin/say" },
			supertonicWorks: true,
			kittenWorks: true,
		});
		expect(findSupertonic(deps)).toBeNull();
		const r = await synthesize({ text: "hi", voice: "Rishi", outPath: "/o/r.wav" }, deps);
		expect(r.ok).toBe(false);
		expect(deps.calls).toEqual([]);
	});

	test.skipIf(!existsSync("/usr/bin/say"))(
		"on the real filesystem a symlink named supertonic pointing at say is refused",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "neural-saylink-"));
			try {
				const link = join(dir, "supertonic");
				symlinkSync("/usr/bin/say", link);
				const deps = { ...defaultDeps(), env: { EIGHT_SUPERTONIC_BIN: link } };
				expect(deps.realpath(link)).toBe(realpathSync("/usr/bin/say"));
				expect(findSupertonic(deps)).not.toBe(link);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);

	test("the module source has no say code path", () => {
		const src = readFileSync(join(import.meta.dir, "neural.ts"), "utf8");
		// The one allowed mention is the guard constant that refuses it.
		const lines = src.split("\n").filter((l) => !l.includes("MAC_SAY_BASENAME ="));
		const body = lines.join("\n");
		expect(body).not.toMatch(/["'`]say["'`]/);
		expect(body).not.toMatch(/\/usr\/bin\/say/);
		expect(body).not.toMatch(/afplay|AVSpeech|NSSpeech/);
		expect(src.match(/MAC_SAY_BASENAME =/g)?.length ?? 0).toBe(1);
	});
});

describe("synthesis does not block the event loop", () => {
	/** Counts timer ticks until stopped, so a test can see the loop was live. */
	const ticker = (ms: number) => {
		let ticks = 0;
		const h = setInterval(() => ticks++, ms);
		return () => {
			clearInterval(h);
			return ticks;
		};
	};

	test("timers fire while a slow fake engine runs inside synthesizeBatch", async () => {
		const deps = both();
		const fast = deps.spawn;
		deps.spawn = async (cmd, args, o) => {
			await new Promise((r) => setTimeout(r, 250));
			return fast(cmd, args, o);
		};
		let timerFiredBeforeDone = false;
		let done = false;
		setTimeout(() => {
			timerFiredBeforeDone = !done;
		}, 20);
		const stop = ticker(10);
		const rs = await synthesizeBatch(
			[
				{ text: "one", voice: "Daniel", outPath: "/o/1.wav" },
				{ text: "two", voice: "Ava", outPath: "/o/2.wav" },
			],
			deps,
		);
		done = true;
		const ticks = stop();
		expect(rs.every((r) => r.ok)).toBe(true);
		expect(timerFiredBeforeDone).toBe(true);
		expect(ticks).toBeGreaterThanOrEqual(10);
	});

	test("the shipped spawn keeps the loop live while a real child process runs", async () => {
		const stop = ticker(10);
		const t0 = Date.now();
		const r = await spawnAsync(process.execPath, ["-e", "setTimeout(() => {}, 400)"], {
			timeoutMs: 10_000,
		});
		const elapsed = Date.now() - t0;
		const ticks = stop();
		expect(r.status).toBe(0);
		expect(elapsed).toBeGreaterThanOrEqual(350);
		// A blocking spawn would let at most one tick through after it returned.
		expect(ticks).toBeGreaterThanOrEqual(15);
	});

	test("defaultDeps().spawn is the async spawn, and synthesize returns a promise", () => {
		expect(defaultDeps().spawn).toBe(spawnAsync);
		const p = synthesize({ text: "hi", voice: "Bob", outPath: "/o/b.wav" }, both());
		expect(p).toBeInstanceOf(Promise);
	});

	test("the shipped spawn passes stdin through and reports the exit status and stderr", async () => {
		const r = await spawnAsync(
			process.execPath,
			[
				"-e",
				"let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{process.stderr.write(s);process.exit(3)})",
			],
			{ input: '{"items":[]}', timeoutMs: 10_000 },
		);
		expect(r.status).toBe(3);
		expect(r.stderr).toBe('{"items":[]}');
	});

	test("the shipped spawn kills a hung engine at the timeout and resolves, never rejects", async () => {
		const t0 = Date.now();
		const r = await spawnAsync(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
			timeoutMs: 150,
		});
		expect(r.status).toBeNull();
		expect(r.stderr).toContain("timed out");
		expect(Date.now() - t0).toBeLessThan(5_000);
	});

	test("a missing binary resolves to status null instead of throwing", async () => {
		const r = await spawnAsync("/nonexistent/supertonic", ["tts"], { timeoutMs: 5_000 });
		expect(r.status).toBeNull();
		expect(r.stderr).toMatch(/ENOENT/);
	});

	test("the module source has no synchronous process call", () => {
		const src = readFileSync(join(import.meta.dir, "neural.ts"), "utf8");
		expect(src).not.toMatch(/spawnSync|execSync|execFileSync|Bun\.spawnSync/);
	});
});

describe("the Kitten interpreter cannot import from the caller's cwd (F1)", () => {
	test("the batch runs in a fresh temp dir with -P, and the temp dir is removed", async () => {
		const deps = both();
		const r = await synthesize({ text: "hi", voice: "Ava", outPath: "/o/a.wav" }, deps);
		expect(r.ok).toBe(true);
		const pyCalls = deps.calls.filter((c) => basename(c.cmd) !== "supertonic");
		expect(pyCalls.length).toBe(2); // the -P probe, then the batch
		for (const c of pyCalls) expect(c.cwd).toBe(TMP);
		const [run] = kittenRuns(deps.calls);
		expect(run.args[0]).toBe("-P");
		expect(run.args.slice(1, 2)).toEqual(["-c"]);
		expect(deps.trees).toEqual([TMP]);
	});

	test("an interpreter without -P still runs in the temp dir, and the script strips the cwd first", async () => {
		const deps = fakeDeps({
			files: [PY],
			which: { python3: PY },
			kittenWorks: true,
			pythonHasP: false,
		});
		const r = await synthesize({ text: "hi", voice: "Ava", outPath: "/o/a.wav" }, deps);
		expect(r.ok).toBe(true);
		const [run] = kittenRuns(deps.calls);
		expect(run.args[0]).toBe("-c");
		expect(run.cwd).toBe(TMP);
		const script = run.args[1].split("\n");
		expect(script[0]).toBe("import sys");
		expect(script[1]).toBe('sys.path[:] = [p for p in sys.path if p not in ("", ".")]');
	});

	const realPythons = [
		...new Set(
			[
				"/usr/local/bin/python3",
				"/opt/homebrew/bin/python3",
				"/usr/bin/python3",
				whichOnPath("python3"),
			]
				.filter((p): p is string => !!p && existsSync(p))
				.map((p) => realpathSync(p)),
		),
	];

	const plant = () => {
		const dir = mkdtempSync(join(tmpdir(), "neural-planted-"));
		const marker = join(dir, "HIJACKED");
		for (const mod of ["json", "kittentts"]) {
			writeFileSync(
				join(dir, `${mod}.py`),
				`open(${JSON.stringify(marker)}, "a").write("${mod}\\n")\n`,
			);
		}
		return { dir, marker };
	};

	for (const py of realPythons) {
		test(`control: the planted json.py does run under a naive spawn (${py})`, () => {
			const { dir, marker } = plant();
			try {
				Bun.spawnSync([py, "-c", "import json"], { cwd: dir });
				expect(existsSync(marker)).toBe(true);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		test(`a planted json.py or kittentts.py in the caller's cwd never runs (${py})`, async () => {
			const { dir, marker } = plant();
			const prev = process.cwd();
			process.chdir(dir);
			try {
				const deps = { ...defaultDeps(), env: { EIGHT_TTS_PYTHON: py } };
				await synthesize({ text: "hi", voice: "Ava", outPath: join(dir, "out.wav") }, deps);
			} finally {
				process.chdir(prev);
			}
			try {
				expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe("");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}, 30_000);
	}
});

describe("Supertonic argv takes hostile text as text (F2)", () => {
	const py = ["/usr/local/bin/python3", "/opt/homebrew/bin/python3", "/usr/bin/python3"].find((p) =>
		existsSync(p),
	);
	/** argparse with Supertonic 1.2.3's tts shape: one positional, then options. */
	const PARSER = [
		"import argparse, json, sys",
		"p = argparse.ArgumentParser()",
		"s = p.add_subparsers(dest='cmd').add_parser('tts')",
		"s.add_argument('text')",
		"s.add_argument('-o', '--output')",
		"s.add_argument('--voice')",
		"s.add_argument('--steps', type=int)",
		"s.add_argument('--custom-style-path')",
		"a = p.parse_args(sys.argv[1:])",
		"print(json.dumps([a.text, a.output, a.voice]))",
	].join("\n");

	test.skipIf(!py)(
		"an argparse parser of the same shape reads every hostile line as the text",
		async () => {
			for (const text of ["--help", "-o/x", "--custom-style-path=/tmp/x.json", "--voice=M1 hi"]) {
				const deps = both();
				await synthesize({ text, voice: "Rishi", outPath: "/o/h.wav" }, deps);
				const r = Bun.spawnSync([py as string, "-c", PARSER, ...deps.calls[0].args]);
				expect(r.exitCode).toBe(0);
				expect(JSON.parse(r.stdout.toString())).toEqual([text, "/o/h.wav", "M3"]);
			}
		},
	);
});

describe("PATH lookup (L1)", () => {
	const setup = () => {
		const dir = mkdtempSync(join(tmpdir(), "neural-path-"));
		const exe = join(dir, "bin");
		mkdirSync(exe);
		writeFileSync(join(exe, "supertonic"), "#!/bin/sh\nexit 0\n");
		chmodSync(join(exe, "supertonic"), 0o755);
		return { dir, exe };
	};

	test("a relative or '.' PATH entry is skipped, even when it holds a supertonic", () => {
		const { dir, exe } = setup();
		const prev = process.cwd();
		process.chdir(dir);
		try {
			expect(whichOnPath("supertonic", ["", ".", "bin", "./bin"].join(":"))).toBeNull();
			process.chdir(exe);
			expect(whichOnPath("supertonic", ".")).toBeNull();
		} finally {
			process.chdir(prev);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("only a regular executable file counts", () => {
		const { dir, exe } = setup();
		try {
			const notExec = join(dir, "noexec");
			mkdirSync(notExec);
			writeFileSync(join(notExec, "supertonic"), "x");
			chmodSync(join(notExec, "supertonic"), 0o644);
			const isDir = join(dir, "isdir");
			mkdirSync(join(isDir, "supertonic"), { recursive: true });
			expect(whichOnPath("supertonic", `${notExec}:${isDir}`)).toBeNull();
			expect(whichOnPath("supertonic", `${notExec}:${isDir}:${exe}`)).toBe(join(exe, "supertonic"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("spawn stderr is bounded (L2)", () => {
	test("a child flooding stderr is capped to the last STDERR_MAX characters", async () => {
		const r = await spawnAsync(
			process.execPath,
			["-e", "process.stderr.write('x'.repeat(2_000_000) + 'END')"],
			{ timeoutMs: 20_000 },
		);
		expect(r.status).toBe(0);
		expect(r.stderr.length).toBeLessThanOrEqual(STDERR_MAX + 200);
		expect(r.stderr.endsWith("END")).toBe(true);
	});

	test("spawnAsync honours cwd", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "neural-cwd-")));
		try {
			const r = await spawnAsync(process.execPath, ["-e", "process.stderr.write(process.cwd())"], {
				timeoutMs: 10_000,
				cwd: dir,
			});
			expect(r.stderr).toBe(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
