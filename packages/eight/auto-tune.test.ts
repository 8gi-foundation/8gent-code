/**
 * Tests for auto-tune detection logic and voice silence learner.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { type Settings, computeAutoTune } from "./auto-tune";
import { VoiceSilenceLearner } from "./voice-silence-learner";

// ─── Test helpers ───────────────────────────────────────────────────────────
function baseSettings(overrides?: Partial<Settings["performance"]>): Settings {
	return {
		version: 1,
		voice: { silenceThresholdMs: 2000, bargeIn: false, ttsVoice: "Ava" },
		performance: {
			mode: "auto",
			introBanner: "auto",
			...overrides,
		},
		models: {
			tabs: {
				orchestrator: { provider: "8gent", model: "eight-1.0-q3:14b" },
				engineer: { provider: "8gent", model: "eight-1.0-q3:14b" },
				qa: { provider: "8gent", model: "eight-1.0-q3:14b" },
			},
		},
		providers: {
			apfel: { baseURL: "http://localhost:9090" },
			ollama: { baseURL: "http://localhost:11434" },
			lmstudio: { baseURL: "http://localhost:1234" },
			openrouter: { baseURL: "https://openrouter.ai/api/v1" },
		},
		ui: { theme: "default" },
	};
}

// Snapshot env vars + isTTY to restore between tests.
type EnvSnapshot = {
	CI: string | undefined;
	LITE: string | undefined;
	FULL: string | undefined;
	NO_INTRO: string | undefined;
	isTTY: boolean | undefined;
};

function snapshotEnv(): EnvSnapshot {
	return {
		CI: process.env.CI,
		LITE: process.env["8GENT_LITE"],
		FULL: process.env["8GENT_FULL"],
		NO_INTRO: process.env["8GENT_NO_INTRO"],
		isTTY: process.stdout.isTTY,
	};
}

function restoreEnv(snap: EnvSnapshot): void {
	if (snap.CI === undefined) delete process.env.CI;
	else process.env.CI = snap.CI;
	if (snap.LITE === undefined) delete process.env["8GENT_LITE"];
	else process.env["8GENT_LITE"] = snap.LITE;
	if (snap.FULL === undefined) delete process.env["8GENT_FULL"];
	else process.env["8GENT_FULL"] = snap.FULL;
	if (snap.NO_INTRO === undefined) delete process.env["8GENT_NO_INTRO"];
	else process.env["8GENT_NO_INTRO"] = snap.NO_INTRO;
	(process.stdout as unknown as { isTTY: boolean | undefined }).isTTY = snap.isTTY;
}

function clearEnv(): void {
	delete process.env.CI;
	delete process.env["8GENT_LITE"];
	delete process.env["8GENT_FULL"];
	delete process.env["8GENT_NO_INTRO"];
}

function setIsTTY(value: boolean): void {
	(process.stdout as unknown as { isTTY: boolean }).isTTY = value;
}

// ─── computeAutoTune: explicit values ───────────────────────────────────────
describe("computeAutoTune - explicit values win", () => {
	let snap: EnvSnapshot;
	beforeEach(() => {
		snap = snapshotEnv();
		clearEnv();
	});
	afterEach(() => restoreEnv(snap));

	it("explicit 'lite' wins even when env says full", () => {
		process.env["8GENT_FULL"] = "1";
		setIsTTY(true);
		const result = computeAutoTune(baseSettings({ mode: "lite" }));
		expect(result.liteMode).toBe(true);
	});

	it("explicit 'full' wins even when CI=true", () => {
		process.env.CI = "true";
		setIsTTY(false);
		const result = computeAutoTune(baseSettings({ mode: "full" }));
		expect(result.liteMode).toBe(false);
	});

	it("explicit introBanner='on' wins even when non-TTY", () => {
		setIsTTY(false);
		const result = computeAutoTune(baseSettings({ introBanner: "on" }));
		expect(result.showIntro).toBe(true);
	});

	it("explicit introBanner='off' wins even when interactive", () => {
		setIsTTY(true);
		const result = computeAutoTune(baseSettings({ introBanner: "off" }));
		expect(result.showIntro).toBe(false);
	});
});

// ─── computeAutoTune: lite mode auto rules ──────────────────────────────────
describe("computeAutoTune - lite mode auto detection", () => {
	let snap: EnvSnapshot;
	beforeEach(() => {
		snap = snapshotEnv();
		clearEnv();
	});
	afterEach(() => restoreEnv(snap));

	it("CI=true -> lite", () => {
		process.env.CI = "true";
		setIsTTY(true);
		expect(computeAutoTune(baseSettings()).liteMode).toBe(true);
	});

	it("non-TTY -> lite", () => {
		setIsTTY(false);
		expect(computeAutoTune(baseSettings()).liteMode).toBe(true);
	});

	it("interactive (TTY, no env) -> full", () => {
		setIsTTY(true);
		expect(computeAutoTune(baseSettings()).liteMode).toBe(false);
	});

	it("8GENT_LITE=1 -> lite", () => {
		setIsTTY(true);
		process.env["8GENT_LITE"] = "1";
		expect(computeAutoTune(baseSettings()).liteMode).toBe(true);
	});

	it("8GENT_FULL=1 -> full", () => {
		setIsTTY(true);
		process.env["8GENT_FULL"] = "1";
		expect(computeAutoTune(baseSettings()).liteMode).toBe(false);
	});

	it("CI=true takes precedence over 8GENT_FULL=1", () => {
		process.env.CI = "true";
		process.env["8GENT_FULL"] = "1";
		setIsTTY(true);
		// CI rule fires first - lite wins.
		expect(computeAutoTune(baseSettings()).liteMode).toBe(true);
	});
});

// ─── computeAutoTune: intro banner auto rules ───────────────────────────────
describe("computeAutoTune - intro banner auto detection", () => {
	let snap: EnvSnapshot;
	beforeEach(() => {
		snap = snapshotEnv();
		clearEnv();
	});
	afterEach(() => restoreEnv(snap));

	it("non-TTY -> off", () => {
		setIsTTY(false);
		expect(computeAutoTune(baseSettings()).showIntro).toBe(false);
	});

	it("8GENT_NO_INTRO=1 -> off", () => {
		setIsTTY(true);
		process.env["8GENT_NO_INTRO"] = "1";
		expect(computeAutoTune(baseSettings()).showIntro).toBe(false);
	});

	it("8GENT_LITE=1 -> off", () => {
		setIsTTY(true);
		process.env["8GENT_LITE"] = "1";
		expect(computeAutoTune(baseSettings()).showIntro).toBe(false);
	});

	it("interactive (TTY, no env) -> on", () => {
		setIsTTY(true);
		expect(computeAutoTune(baseSettings()).showIntro).toBe(true);
	});
});

// ─── computeAutoTune: voice silence pass-through ────────────────────────────
describe("computeAutoTune - voice silence", () => {
	let snap: EnvSnapshot;
	beforeEach(() => {
		snap = snapshotEnv();
		clearEnv();
	});
	afterEach(() => restoreEnv(snap));

	it("passes silence threshold from settings unchanged", () => {
		const settings = baseSettings();
		settings.voice.silenceThresholdMs = 1500;
		expect(computeAutoTune(settings).voiceSilenceMs).toBe(1500);
	});
});

// ─── VoiceSilenceLearner ────────────────────────────────────────────────────
describe("VoiceSilenceLearner", () => {
	let tmpDir: string;
	let historyPath: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-silence-"));
		historyPath = path.join(tmpDir, "voice-silence-history.jsonl");
	});

	afterEach(() => {
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	it("returns 2000ms with <5 samples", () => {
		const learner = new VoiceSilenceLearner(historyPath);
		expect(learner.getRecommendedThreshold()).toBe(2000);
		learner.observePause(1500);
		learner.observePause(1600);
		expect(learner.getRecommendedThreshold()).toBe(2000);
	});

	it("returns mean + 1 stddev with >=5 samples", () => {
		const learner = new VoiceSilenceLearner(historyPath);
		// Samples chosen so mean=1500, all equal -> stddev=0, recommendation=1500.
		for (let i = 0; i < 5; i++) learner.observePause(1500);
		expect(learner.getRecommendedThreshold()).toBe(1500);
	});

	it("clamps recommendation to [800, 5000]", () => {
		const lowLearner = new VoiceSilenceLearner(historyPath);
		// All small -> would recommend below 800 -> clamp to 800.
		for (let i = 0; i < 5; i++) lowLearner.observePause(500);
		expect(lowLearner.getRecommendedThreshold()).toBe(800);

		// Fresh path for the high case.
		const highPath = path.join(tmpDir, "high.jsonl");
		const highLearner = new VoiceSilenceLearner(highPath);
		// Mix of huge values -> mean+stddev will exceed 5000 -> clamp to 5000.
		for (const ms of [6000, 7000, 8000, 9000, 10000]) highLearner.observePause(ms);
		expect(highLearner.getRecommendedThreshold()).toBe(5000);
	});

	it("persists samples across instances", () => {
		const a = new VoiceSilenceLearner(historyPath);
		for (let i = 0; i < 5; i++) a.observePause(1200);
		// New instance reads the same file.
		const b = new VoiceSilenceLearner(historyPath);
		expect(b.getRecommendedThreshold()).toBe(1200);
	});

	it("ignores non-positive and non-finite samples", () => {
		const learner = new VoiceSilenceLearner(historyPath);
		learner.observePause(0);
		learner.observePause(-100);
		learner.observePause(Number.NaN);
		learner.observePause(Number.POSITIVE_INFINITY);
		expect(learner.getRecommendedThreshold()).toBe(2000);
	});

	it("skips corrupt lines on load", () => {
		// Hand-write a file with a mix of valid and corrupt entries.
		const lines = [
			JSON.stringify({ ts: 1, ms: 1500 }),
			"not json at all",
			JSON.stringify({ ts: 2, ms: 1500 }),
			"{broken",
			JSON.stringify({ ts: 3, ms: 1500 }),
			JSON.stringify({ ts: 4, ms: 1500 }),
			JSON.stringify({ ts: 5, ms: 1500 }),
		];
		fs.writeFileSync(historyPath, `${lines.join("\n")}\n`, "utf8");
		const learner = new VoiceSilenceLearner(historyPath);
		// 5 valid samples, all 1500 -> recommendation = 1500.
		expect(learner.getRecommendedThreshold()).toBe(1500);
	});

	it("keeps only the last 50 samples in memory", () => {
		const learner = new VoiceSilenceLearner(historyPath);
		// Insert 60 samples at 1500ms.
		for (let i = 0; i < 60; i++) learner.observePause(1500);
		// Cap is 50, all 1500 -> recommendation still 1500 (clamped above 800).
		expect(learner.getRecommendedThreshold()).toBe(1500);
	});
});
