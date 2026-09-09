/**
 * Tests for the local TTS engine: the Python worker protocol (driven by a fake
 * worker under ./test), the utterance queue and interrupt, and TTSEngine's
 * fallback to macOS say when the preferred engine is unavailable.
 */

import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	PythonWorkerTTSProvider,
	TTSEngine,
	type TTSProcess,
	type TTSProvider,
	type TTSSpeakOptions,
} from "./tts-engine.js";

const TEST_DIR = path.dirname(new URL(import.meta.url).pathname);
const FAKE_WORKER = path.join(TEST_DIR, "test", "fake-tts-worker.py");
const FAKE_PLAYER = ["sh", path.join(TEST_DIR, "test", "fake-player.sh")];

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "8gent-tts-test-"));
}

function makeProvider(dir: string, extra: Record<string, string> = {}) {
	return new PythonWorkerTTSProvider("kitten", {
		python: "python3",
		workerPath: FAKE_WORKER,
		player: FAKE_PLAYER,
		outDir: dir,
		readyTimeoutMs: 10_000,
		requestTimeoutMs: 5_000,
		env: {
			FAKE_PLAYER_LOG: path.join(dir, "player.log"),
			FAKE_TTS_LOG: path.join(dir, "worker.log"),
			...extra,
		},
	});
}

function readLines(file: string): string[] {
	try {
		return fs
			.readFileSync(file, "utf-8")
			.split("\n")
			.filter((l) => l.length > 0);
	} catch {
		return [];
	}
}

const providers: PythonWorkerTTSProvider[] = [];
const dirs: string[] = [];

afterEach(() => {
	for (const p of providers.splice(0)) p.dispose();
	for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("PythonWorkerTTSProvider worker protocol", () => {
	test("is available only when the module imports", async () => {
		const ok = new PythonWorkerTTSProvider("kitten", { python: "python3", workerPath: FAKE_WORKER });
		providers.push(ok);
		// "kittentts" may or may not be installed on the test machine; the probe
		// must answer without throwing and cache the answer.
		const first = await ok.isAvailable();
		const second = await ok.isAvailable();
		expect(second).toBe(first);

		const missing = new PythonWorkerTTSProvider("kitten", {
			python: "/definitely/not/a/python",
			workerPath: FAKE_WORKER,
		});
		providers.push(missing);
		expect(await missing.isAvailable()).toBe(false);
		expect(missing.unavailableReason()).toContain("kittentts");
	});

	test("speaks utterances in order through one worker and plays each wav", async () => {
		const dir = tmpDir();
		dirs.push(dir);
		const provider = makeProvider(dir);
		providers.push(provider);

		const a = await provider.speak("first line", { voice: "Alpha" });
		const b = await provider.speak("second line", { voice: "Beta" });
		const c = await provider.speak("third line", { voice: "NotAVoice" });
		expect(await a.exited).toBe(0);
		expect(await b.exited).toBe(0);
		expect(await c.exited).toBe(0);

		const worker = readLines(path.join(dir, "worker.log"));
		expect(worker.map((l) => l.split(" ")[1])).toEqual(["Alpha", "Beta", "Bruno"]);
		expect(worker.map((l) => l.split(" ").slice(2).join(" "))).toEqual([
			"first line",
			"second line",
			"third line",
		]);

		const played = readLines(path.join(dir, "player.log"));
		expect(played).toHaveLength(3);
		expect(played[0]).toContain("kitten-");
		// wavs are deleted after playback
		for (const p of played) expect(fs.existsSync(p)).toBe(false);
		// voices come from the worker's ready line
		expect(provider.voices()).toEqual(["Alpha", "Beta"]);
		expect(provider.lastLoadMs).toBe(1);
		expect(provider.lastSynthesisMs).toBe(1);
	});

	test("interrupt kills playback and drops the queue", async () => {
		const dir = tmpDir();
		dirs.push(dir);
		const provider = makeProvider(dir, { FAKE_PLAYER_SLEEP: "5" });
		providers.push(provider);

		const started = Date.now();
		const a = await provider.speak("long one", { voice: "Alpha" });
		const b = await provider.speak("queued", { voice: "Alpha" });
		const c = await provider.speak("also queued", { voice: "Alpha" });
		// Let the first utterance reach the player.
		await new Promise((r) => setTimeout(r, 400));
		await provider.interrupt();
		const codes = await Promise.all([a.exited, b.exited, c.exited]);
		expect(Date.now() - started).toBeLessThan(4000);
		expect(codes[1]).toBe(130);
		expect(codes[2]).toBe(130);
		expect(codes[0]).not.toBe(0);
		expect(readLines(path.join(dir, "player.log"))).toHaveLength(1);
	});

	test("kill on a single utterance cancels only that one", async () => {
		const dir = tmpDir();
		dirs.push(dir);
		const provider = makeProvider(dir);
		providers.push(provider);

		const a = await provider.speak("keep", { voice: "Alpha" });
		const b = await provider.speak("drop", { voice: "Alpha" });
		const c = await provider.speak("keep too", { voice: "Alpha" });
		b.kill();
		expect(await a.exited).toBe(0);
		expect(await b.exited).toBe(130);
		expect(await c.exited).toBe(0);
		expect(readLines(path.join(dir, "player.log"))).toHaveLength(2);
	});

	test("respawns the worker after it dies", async () => {
		const dir = tmpDir();
		dirs.push(dir);
		const provider = makeProvider(dir, { FAKE_TTS_DIE_AFTER: "1" });
		providers.push(provider);

		const a = await provider.speak("one", { voice: "Alpha" });
		expect(await a.exited).toBe(0);
		// Worker exited after the first answer; the next utterance boots a new one.
		await new Promise((r) => setTimeout(r, 200));
		const b = await provider.speak("two", { voice: "Alpha" });
		expect(await b.exited).toBe(0);
		expect(readLines(path.join(dir, "player.log"))).toHaveLength(2);
	});

	test("speak rejects when the worker cannot boot, and gives up after three tries", async () => {
		const dir = tmpDir();
		dirs.push(dir);
		const provider = makeProvider(dir, { FAKE_TTS_FAIL_BOOT: "1" });
		providers.push(provider);

		for (let i = 0; i < 3; i++) {
			await expect(provider.speak("hello", { voice: "Alpha" })).rejects.toThrow("fake boot failure");
		}
		expect(await provider.isAvailable()).toBe(false);
		expect(provider.unavailableReason()).toContain("failed to start 3 times");
	});
});

// ============================================
// TTSEngine fallback
// ============================================

class FakeProvider implements TTSProvider {
	spoken: Array<{ text: string; options?: TTSSpeakOptions }> = [];
	constructor(
		readonly name: string,
		private readonly available: boolean,
		private readonly voiceList: string[],
		private readonly speakError?: string,
	) {}
	async speak(text: string, options?: TTSSpeakOptions): Promise<TTSProcess> {
		if (this.speakError) throw new Error(this.speakError);
		this.spoken.push({ text, options });
		return { kill: () => {}, exited: Promise.resolve(0) };
	}
	async interrupt(): Promise<void> {}
	async isAvailable(): Promise<boolean> {
		return this.available;
	}
	voices(): string[] {
		return this.voiceList;
	}
	unavailableReason(): string | null {
		return this.available ? null : `${this.name} module missing`;
	}
}

const KITTEN_VOICES = ["Bella", "Jasper", "Luna", "Bruno"];
const MAC_VOICES = ["Ava", "Daniel", "Karen", "Moira"];

describe("TTSEngine fallback", () => {
	test("uses the preferred engine when available", async () => {
		const kitten = new FakeProvider("kitten", true, KITTEN_VOICES);
		const macos = new FakeProvider("macos", true, MAC_VOICES);
		const logs: string[] = [];
		const engine = new TTSEngine("kitten", {
			providers: { kitten: () => kitten, macos: () => macos },
			log: (l) => logs.push(l),
		});
		await engine.speak("hi", { voice: "Jasper", role: "orchestrator" });
		expect(kitten.spoken).toHaveLength(1);
		expect(kitten.spoken[0]?.options?.voice).toBe("Jasper");
		expect(macos.spoken).toHaveLength(0);
		expect(engine.getStatus()).toEqual({
			preferred: "kitten",
			active: "kitten",
			note: null,
			lastSynthesisMs: null,
		});
		expect(logs).toEqual([]);
	});

	test("falls back to macos with one log line when the preferred engine is unavailable", async () => {
		const kitten = new FakeProvider("kitten", false, KITTEN_VOICES);
		const macos = new FakeProvider("macos", true, MAC_VOICES);
		const logs: string[] = [];
		const engine = new TTSEngine("kitten", {
			providers: { kitten: () => kitten, macos: () => macos },
			log: (l) => logs.push(l),
		});
		await engine.speak("one", { voice: "Jasper", role: "orchestrator" });
		await engine.speak("two", { voice: "Bruno", role: "engineer" });
		expect(kitten.spoken).toHaveLength(0);
		expect(macos.spoken).toHaveLength(2);
		// Kitten voice names are not macOS voices: per-role macOS defaults apply.
		expect(macos.spoken[0]?.options?.voice).toBe("Daniel");
		expect(macos.spoken[1]?.options?.voice).toBe("Karen");
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain('"kitten" unavailable');
		expect(logs[0]).toContain("kitten module missing");
		expect(engine.getStatus().active).toBe("macos");
		expect(engine.getStatus().note).toBe(logs[0]);
	});

	test("falls back to macos when the preferred engine fails to speak", async () => {
		const supertonic = new FakeProvider("supertonic", true, ["M1", "F1"], "worker exploded");
		const macos = new FakeProvider("macos", true, MAC_VOICES);
		const logs: string[] = [];
		const engine = new TTSEngine("supertonic", {
			providers: { supertonic: () => supertonic, macos: () => macos },
			log: (l) => logs.push(l),
		});
		const proc = await engine.speak("hello", { voice: "M1", role: "qa" });
		expect(await proc.exited).toBe(0);
		expect(macos.spoken).toHaveLength(1);
		expect(macos.spoken[0]?.options?.voice).toBe("Moira");
		expect(logs).toHaveLength(1);
		expect(logs[0]).toContain("worker exploded");
		// Later utterances go straight to macos without another log line.
		await engine.speak("again", { voice: "M1", role: "qa" });
		expect(macos.spoken).toHaveLength(2);
		expect(logs).toHaveLength(1);
	});

	test("resolves an unknown voice to the provider's role default", async () => {
		const kitten = new FakeProvider("kitten", true, KITTEN_VOICES);
		const engine = new TTSEngine("kitten", { providers: { kitten: () => kitten }, log: () => {} });
		await engine.speak("a", { voice: "Daniel", role: "qa" });
		await engine.speak("b", { voice: "Daniel" });
		await engine.speak("c", { voice: "Luna", role: "qa" });
		expect(kitten.spoken.map((s) => s.options?.voice)).toEqual(["Hugo", "Bruno", "Luna"]);
	});

	test("setPreferred re-resolves the provider", async () => {
		const kitten = new FakeProvider("kitten", true, KITTEN_VOICES);
		const macos = new FakeProvider("macos", true, MAC_VOICES);
		const engine = new TTSEngine("macos", {
			providers: { kitten: () => kitten, macos: () => macos },
			log: () => {},
		});
		expect(await engine.getProviderName()).toBe("macos");
		engine.setPreferred("kitten");
		expect(await engine.getProviderName()).toBe("kitten");
	});
});
