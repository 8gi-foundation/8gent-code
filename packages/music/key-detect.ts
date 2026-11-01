/**
 * Local musical-key estimate for the DJ (#3192). No cloud, no new dependency.
 *
 * ffmpeg (already one of the DJ's tools) decodes a short mono sample at
 * 11025 Hz; a Hann-windowed FFT folds each frame's spectrum into a 12-bin
 * pitch-class profile; the profile is correlated against the 24 rotated
 * Krumhansl-Kessler key profiles. The winner is labelled an estimate, and a
 * weak or near-tied result is reported as unknown rather than guessed.
 */

import { type ChildProcess, spawn } from "node:child_process";

export const SAMPLE_RATE = 11025;
const FRAME = 4096;
const F_HI = 2000;

export const PITCH_NAMES = [
	"C",
	"C#",
	"D",
	"Eb",
	"E",
	"F",
	"F#",
	"G",
	"Ab",
	"A",
	"Bb",
	"B",
] as const;

// Krumhansl-Kessler probe-tone profiles, tonic first.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** In-place iterative radix-2 FFT. `re.length` must be a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
	const n = re.length;
	for (let i = 1, j = 0; i < n; i++) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			[re[i], re[j]] = [re[j], re[i]];
			[im[i], im[j]] = [im[j], im[i]];
		}
	}
	for (let len = 2; len <= n; len <<= 1) {
		const ang = (-2 * Math.PI) / len;
		const wr = Math.cos(ang);
		const wi = Math.sin(ang);
		for (let i = 0; i < n; i += len) {
			let cr = 1;
			let ci = 0;
			for (let k = 0; k < len / 2; k++) {
				const a = i + k;
				const b = a + len / 2;
				const tr = re[b] * cr - im[b] * ci;
				const ti = re[b] * ci + im[b] * cr;
				re[b] = re[a] - tr;
				im[b] = im[a] - ti;
				re[a] += tr;
				im[a] += ti;
				const ncr = cr * wr - ci * wi;
				ci = cr * wi + ci * wr;
				cr = ncr;
			}
		}
	}
}

/** MIDI range of the fundamentals considered: C2 to B6. */
const MIDI_LO = 36;
const MIDI_HI = 95;
/** Harmonic weights for pitch salience: a note owns its overtones, so its fifth (3rd harmonic) is not counted as a note of its own. */
const HARMONICS = [1, 0.5, 0.33, 0.25];

/**
 * The 12-bin pitch-class profile of a mono signal (index 0 = C).
 *
 * Per frame, each candidate note's salience is its harmonic-weighted
 * spectral magnitude minus what its lower octave and lower fifth would
 * explain; the raw spectrum alone lets every note's 3rd harmonic vote for
 * its fifth and drags the estimate a fifth up (C major read as G major).
 */
export function chroma(samples: Float32Array, sampleRate = SAMPLE_RATE): number[] {
	const out = new Array(12).fill(0);
	const hann = new Float64Array(FRAME);
	for (let i = 0; i < FRAME; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME - 1));
	const half = FRAME / 2;
	const binOf = (f: number) => Math.round((f * FRAME) / sampleRate);
	const re = new Float64Array(FRAME);
	const im = new Float64Array(FRAME);
	const mag = new Float64Array(half);
	const sal = new Float64Array(MIDI_HI + 1);
	for (let start = 0; start + FRAME <= samples.length; start += FRAME) {
		for (let i = 0; i < FRAME; i++) {
			re[i] = samples[start + i] * hann[i];
			im[i] = 0;
		}
		fft(re, im);
		for (let k = 0; k < half; k++) mag[k] = Math.log1p(Math.hypot(re[k], im[k]));
		// Peak magnitude within +-1 bin, so slightly detuned notes still count.
		const at = (f: number) => {
			const b = binOf(f);
			if (b < 1 || b >= half - 1) return 0;
			return Math.max(mag[b - 1], mag[b], mag[b + 1]);
		};
		for (let m = MIDI_LO; m <= MIDI_HI; m++) {
			const f0 = 440 * 2 ** ((m - 69) / 12);
			let v = 0;
			HARMONICS.forEach((w, h) => {
				v += w * at(f0 * (h + 1));
			});
			sal[m] = v;
		}
		for (let m = MIDI_LO; m <= MIDI_HI; m++) {
			if (440 * 2 ** ((m - 69) / 12) > F_HI) break;
			// What a note an octave or a twelfth below would already explain here.
			const below = Math.max(
				m - 12 >= MIDI_LO ? sal[m - 12] * HARMONICS[1] : 0,
				m - 19 >= MIDI_LO ? sal[m - 19] * HARMONICS[2] : 0,
			);
			const v = sal[m] - below;
			if (v > 0) out[m % 12] += v;
		}
	}
	return out;
}

function pearson(a: number[], b: number[]): number {
	const n = a.length;
	const ma = a.reduce((s, v) => s + v, 0) / n;
	const mb = b.reduce((s, v) => s + v, 0) / n;
	let num = 0;
	let da = 0;
	let db = 0;
	for (let i = 0; i < n; i++) {
		num += (a[i] - ma) * (b[i] - mb);
		da += (a[i] - ma) ** 2;
		db += (b[i] - mb) ** 2;
	}
	return da === 0 || db === 0 ? 0 : num / Math.sqrt(da * db);
}

export interface KeyEstimate {
	/** "A minor", "C major". */
	key: string;
	/** Correlation of the winning profile, -1..1. */
	score: number;
	/** Winner's lead over the runner-up that is not its relative key. */
	margin: number;
}

/** Below this the profile does not look tonal enough to name a key. */
export const MIN_SCORE = 0.5;

/** The best-matching key for a pitch-class profile, or null when it is too weak to name. */
export function keyFromChroma(profile: number[]): KeyEstimate | null {
	if (profile.every((v) => v === 0)) return null;
	const scored: { key: string; score: number; pc: number; minor: boolean }[] = [];
	for (let pc = 0; pc < 12; pc++) {
		const rot = (p: number[]) => p.map((_, i) => p[(i - pc + 12) % 12]);
		scored.push({
			key: `${PITCH_NAMES[pc]} major`,
			score: pearson(profile, rot(MAJOR)),
			pc,
			minor: false,
		});
		scored.push({
			key: `${PITCH_NAMES[pc]} minor`,
			score: pearson(profile, rot(MINOR)),
			pc,
			minor: true,
		});
	}
	scored.sort((a, b) => b.score - a.score);
	const best = scored[0];
	if (best.score < MIN_SCORE) return null;
	// Relative major/minor share their notes; being close to it is expected, not doubt.
	const relPc = best.minor ? (best.pc + 3) % 12 : (best.pc + 9) % 12;
	const rival = scored.find((s) => s !== best && !(s.pc === relPc && s.minor !== best.minor));
	return { key: best.key, score: best.score, margin: best.score - (rival?.score ?? 0) };
}

/** Key estimate for raw mono samples. */
export function estimateKey(samples: Float32Array, sampleRate = SAMPLE_RATE): KeyEstimate | null {
	if (samples.length < FRAME) return null;
	return keyFromChroma(chroma(samples, sampleRate));
}

export interface DecodeOptions {
	ffmpeg: string;
	/** Seconds into the source to start. Omit for live streams. */
	offsetSec?: number;
	/** Seconds of audio to analyse. */
	seconds?: number;
	/** Give up after this long (a stream may be slow to deliver). */
	timeoutMs?: number;
}

/** A running decode that can be abandoned: `cancel()` stops the ffmpeg this started, by its own PID. */
export interface KeyJob {
	promise: Promise<KeyEstimate | null>;
	cancel(): void;
}

/** Decode a short sample of `src` with ffmpeg and estimate its key. Off the event loop throughout. */
export function detectKey(src: string, opts: DecodeOptions): KeyJob {
	const seconds = opts.seconds ?? 20;
	const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];
	if (opts.offsetSec && opts.offsetSec > 0) args.push("-ss", String(opts.offsetSec));
	args.push(
		"-t",
		String(seconds),
		"-i",
		src,
		"-vn",
		"-ac",
		"1",
		"-ar",
		String(SAMPLE_RATE),
		"-f",
		"f32le",
		"-",
	);
	let child: ChildProcess | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let settled = false;
	const promise = new Promise<KeyEstimate | null>((resolve) => {
		const done = (v: KeyEstimate | null) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(v);
		};
		try {
			child = spawn(opts.ffmpeg, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
		} catch {
			done(null);
			return;
		}
		const chunks: Buffer[] = [];
		const cap = seconds * SAMPLE_RATE * 4;
		let got = 0;
		child.stdout?.on("data", (b: Buffer) => {
			if (got < cap) {
				chunks.push(b);
				got += b.length;
			}
		});
		child.on("error", () => done(null));
		child.on("close", () => {
			const buf = Buffer.concat(chunks);
			const n = Math.floor(buf.length / 4);
			const samples = new Float32Array(n);
			for (let i = 0; i < n; i++) samples[i] = buf.readFloatLE(i * 4);
			done(estimateKey(samples));
		});
		timer = setTimeout(() => {
			try {
				child?.kill("SIGTERM");
			} catch {}
		}, opts.timeoutMs ?? 30000);
		(timer as { unref?: () => void }).unref?.();
	});
	return {
		promise,
		cancel() {
			if (settled) return;
			try {
				child?.kill("SIGTERM");
			} catch {}
		},
	};
}
