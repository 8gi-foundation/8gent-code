/**
 * Tests for the one neural voice-casting table (#3346, PR 1).
 *
 * None of these need Supertonic, KittenTTS or Python installed. Every spawn and
 * every filesystem probe goes through injected deps, so the tests pin the
 * logic: casting, discovery order, fallback order, and that macOS say is
 * unreachable.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
	NARRATOR,
	NEURAL_VOICE,
	type NeuralDeps,
	NeuralTtsError,
	OFFICERS,
	type SpawnResult,
	defaultDeps,
	kittenPythonCandidates,
	resolveVoice,
	spawnAsync,
	supertonicCandidates,
	synthesize,
	synthesizeBatch,
} from "./neural.ts";

const HOME = "/Users/test";

interface Call {
	cmd: string;
	args: string[];
	input?: string;
}

/** A fake machine. `files` is what exists; `engines` says which engine works. */
function fakeDeps(opts: {
	files?: string[];
	env?: Record<string, string>;
	which?: Record<string, string>;
	pyenvVersions?: string[];
	supertonicWorks?: boolean;
	kittenWorks?: boolean;
}): NeuralDeps & { calls: Call[]; files: Set<string> } {
	const files = new Set(opts.files ?? []);
	const calls: Call[] = [];
	const deps = {
		calls,
		files,
		env: opts.env ?? {},
		home: HOME,
		exists: (p: string) => files.has(p),
		remove: (p: string) => {
			files.delete(p);
		},
		which: (cmd: string) => opts.which?.[cmd] ?? null,
		listDir: (dir: string) =>
			dir === join(HOME, ".pyenv/versions") ? (opts.pyenvVersions ?? []) : [],
		spawn: async (cmd: string, args: string[], o: { input?: string }): Promise<SpawnResult> => {
			calls.push({ cmd, args, input: o.input });
			if (basename(cmd) === "supertonic") {
				if (!opts.supertonicWorks) return { status: 1, stderr: "model load failed" };
				files.add(args[args.indexOf("-o") + 1]);
				return { status: 0, stderr: "" };
			}
			// Kitten: a python interpreter running the batch script.
			if (!opts.kittenWorks) return { status: 1, stderr: "No module named kittentts" };
			const job = JSON.parse(o.input ?? "{}") as { items: { out: string }[] };
			for (const it of job.items) files.add(it.out);
			return { status: 0, stderr: "" };
		},
	};
	return deps;
}

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
			"hello",
			"-o",
			"/out/a.wav",
			"--voice",
			"M3",
			"--steps",
			"8",
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
		expect(deps.calls).toHaveLength(1);
		const job = JSON.parse(deps.calls[0].input ?? "{}");
		expect(job.model).toBe("KittenML/kitten-tts-nano-0.8");
		expect(job.items).toEqual([{ text: "hi", out: "/o/a.wav", voice: "Bella" }]);
	});

	test("Supertonic failing falls back to Kitten with the canon fallback style", async () => {
		const deps = fakeDeps({
			files: [ST, PY],
			which: { supertonic: ST, python3: PY },
			kittenWorks: true,
		});
		const r = await synthesize({ text: "hi", voice: "Rishi", outPath: "/o/r.wav" }, deps);
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

	test("Kitten failing falls back to Supertonic with the canon fallback style", async () => {
		const deps = fakeDeps({
			files: [ST, PY],
			which: { supertonic: ST, python3: PY },
			supertonicWorks: true,
		});
		const r = await synthesize({ text: "hi", voice: "Fred", outPath: "/o/f.wav" }, deps);
		expect(r.ok && r.engine).toBe("supertonic");
		expect(r.ok && r.style).toBe("M5");
	});

	test("both engines failing is a typed all_engines_failed error naming every attempt", async () => {
		const deps = fakeDeps({ files: [ST, PY], which: { supertonic: ST, python3: PY } });
		const r = await synthesize({ text: "hi", voice: "Karen", outPath: "/o/k.wav" }, deps);
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
		const kittenCalls = deps.calls.filter((c) => basename(c.cmd) !== "supertonic");
		expect(kittenCalls).toHaveLength(1);
		expect(JSON.parse(kittenCalls[0].input ?? "{}").items).toHaveLength(2);
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
