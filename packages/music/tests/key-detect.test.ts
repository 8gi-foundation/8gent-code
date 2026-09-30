import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_RATE, detectKey, estimateKey, keyFromChroma } from "../key-detect";

const NOTE: Record<string, number> = {
	C: 0,
	"C#": 1,
	D: 2,
	Eb: 3,
	E: 4,
	F: 5,
	"F#": 6,
	G: 7,
	Ab: 8,
	A: 9,
	Bb: 10,
	B: 11,
};
const hz = (pc: number, octave: number) => 440 * 2 ** ((pc + 12 * (octave + 1) - 69) / 12);

/** A chord progression as summed sines with a few harmonics, one chord per second. */
function progression(chords: string[][], seconds = 2): Float32Array {
	const per = SAMPLE_RATE * seconds;
	const out = new Float32Array(per * chords.length);
	chords.forEach((chord, c) => {
		const freqs = chord.map((n, i) => hz(NOTE[n], i === 0 ? 2 : 3));
		for (let i = 0; i < per; i++) {
			const t = i / SAMPLE_RATE;
			let v = 0;
			for (const f of freqs)
				for (let h = 1; h <= 3; h++) v += Math.sin(2 * Math.PI * f * h * t) / (h * h);
			out[c * per + i] = v / (freqs.length * 2);
		}
	});
	return out;
}

describe("local key estimate (#3192)", () => {
	test("i - iv - V - i in A minor reads as A minor", () => {
		const s = progression([
			["A", "C", "E"],
			["D", "F", "A"],
			["E", "Ab", "B"],
			["A", "C", "E"],
		]);
		expect(estimateKey(s)?.key).toBe("A minor");
	});

	test("I - IV - V - I in C major reads as C major", () => {
		const s = progression([
			["C", "E", "G"],
			["F", "A", "C"],
			["G", "B", "D"],
			["C", "E", "G"],
		]);
		expect(estimateKey(s)?.key).toBe("C major");
	});

	test("I - IV - V - I in G major reads as G major", () => {
		const s = progression([
			["G", "B", "D"],
			["C", "E", "G"],
			["D", "F#", "A"],
			["G", "B", "D"],
		]);
		expect(estimateKey(s)?.key).toBe("G major");
	});

	test("i - iv - V - i in D minor and F# minor, I - IV - V - I in Eb major", () => {
		expect(
			estimateKey(
				progression([
					["D", "F", "A"],
					["G", "Bb", "D"],
					["A", "C#", "E"],
					["D", "F", "A"],
				]),
			)?.key,
		).toBe("D minor");
		expect(
			estimateKey(
				progression([
					["F#", "A", "C#"],
					["B", "D", "F#"],
					["C#", "F", "Ab"],
					["F#", "A", "C#"],
				]),
			)?.key,
		).toBe("F# minor");
		expect(
			estimateKey(
				progression([
					["Eb", "G", "Bb"],
					["Ab", "C", "Eb"],
					["Bb", "D", "F"],
					["Eb", "G", "Bb"],
				]),
			)?.key,
		).toBe("Eb major");
	});

	test("silence names no key", () => {
		expect(estimateKey(new Float32Array(SAMPLE_RATE * 4))).toBeNull();
	});

	test("a flat profile (no tonal centre) names no key", () => {
		expect(keyFromChroma(new Array(12).fill(1))).toBeNull();
	});

	test("too short a sample names no key", () => {
		expect(estimateKey(new Float32Array(100))).toBeNull();
	});

	const ffmpeg = (() => {
		try {
			return (
				execFileSync("/bin/sh", ["-c", "command -v ffmpeg"], { encoding: "utf-8" }).trim() || null
			);
		} catch {
			return null;
		}
	})();

	test.skipIf(!ffmpeg)(
		"end to end through ffmpeg: a rendered E minor chord file reads as E minor",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "keydetect-"));
			try {
				const wav = join(dir, "em.wav");
				// E minor: E3 G3 B3 with a low E2 root.
				const expr = [82.41, 164.81, 196.0, 246.94].map((f) => `0.2*sin(2*PI*${f}*t)`).join("+");
				execFileSync(ffmpeg!, [
					"-hide_banner",
					"-loglevel",
					"error",
					"-f",
					"lavfi",
					"-i",
					`aevalsrc=${expr}:s=44100:d=8`,
					wav,
				]);
				const job = detectKey(wav, { ffmpeg: ffmpeg!, offsetSec: 1, seconds: 5, timeoutMs: 10000 });
				expect((await job.promise)?.key).toBe("E minor");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	);
});
