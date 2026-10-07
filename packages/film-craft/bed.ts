/**
 * Original music bed, synthesised here: no samples, no downloads, no library tracks.
 * Concepts from the 8GI cinematic bed: a sub drone, detuned additive pads on i-VI-III-VII whose brightness
 * opens with the film, an eighth-note pluck pulse from the first cut, a soft kick that drives the middle,
 * a riser into and a low boom on every cut, a lift to the major at the close, a synthetic hall, tanh glue,
 * peak -1 dBFS. Deterministic for the same inputs.
 */
import { writeFileSync } from "node:fs";
import presets from "./presets.json";

export type BedSpec = {
	key: string;
	transpose: number;
	bpm: number;
	progression: string;
	liftAtClose: boolean;
	pulse: boolean;
	kick: boolean;
};
export type BedResult = {
	path: string;
	seconds: number;
	key: string;
	peakDb: number;
	rmsDb: number;
};

const SR = 48000;
const N: Record<string, number> = {
	A1: -36,
	E2: -29,
	F2: -28,
	G2: -26,
	A2: -24,
	C3: -21,
	E3: -17,
	G3: -14,
	A3: -12,
	B3: -10,
	C4: -9,
	Cs4: -8,
	D3: -19,
	D4: -7,
	E4: -5,
	F4: -4,
	G4: -2,
};
const CHORDS: Record<string, string[]> = {
	Am: ["A2", "E3", "A3", "C4", "E4"],
	F: ["F2", "C3", "A3", "C4", "F4"],
	C: ["C3", "G3", "C4", "E4", "G4"],
	G: ["G2", "D3", "B3", "D4", "G4"],
	A: ["A2", "E3", "A3", "Cs4", "E4"],
};
const ROOT: Record<string, string> = { Am: "A2", F: "F2", C: "C3", G: "G2", A: "A2" };
const PROG = ["Am", "F", "C", "G"];

function rng(seed: number) {
	let a = seed >>> 0;
	const u = () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return { u, n: () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u()) };
}
function interp(x: number, pts: [number, number][]): number {
	const p = [...pts].sort((a, b) => a[0] - b[0]);
	if (x <= p[0][0]) return p[0][1];
	for (let i = 1; i < p.length; i++)
		if (x <= p[i][0]) {
			const [x0, y0] = p[i - 1];
			const [x1, y1] = p[i];
			return x1 > x0 ? y0 + ((y1 - y0) * (x - x0)) / (x1 - x0) : y1;
		}
	return p[p.length - 1][1];
}
/** Adds sum_h sin(2 pi f h t + ph) / h^tilt into dst[i0..i1) by phasor recurrence (no per-sample sin). */
function additive(
	dst: Float64Array,
	i0: number,
	i1: number,
	f: number,
	harm: number,
	tilt: number,
	gain: number,
	ph: number,
	env?: (k: number) => number,
) {
	for (let h = 1; h <= harm && f * h < 16000; h++) {
		const w = (2 * Math.PI * f * h) / SR;
		const c = 2 * Math.cos(w);
		const g = gain / h ** tilt;
		let s1 = Math.sin(ph * h - w);
		let s0 = Math.sin(ph * h - 2 * w);
		for (let i = i0; i < i1 && i < dst.length; i++) {
			const s = c * s1 - s0;
			s0 = s1;
			s1 = s;
			dst[i] += s * g * (env ? env(i - i0) : 1);
		}
	}
}
function onePole(x: Float64Array, hz: number, high = false) {
	const k = Math.exp((-2 * Math.PI * hz) / SR);
	let y = 0;
	for (let i = 0; i < x.length; i++) {
		y = (1 - k) * x[i] + k * y;
		x[i] = high ? x[i] - y : y;
	}
	return x;
}
/** Schroeder hall: 4 combs and 2 allpasses; each channel gets its own delays. */
function hall(x: Float64Array, right: boolean): Float64Array {
	const out = new Float64Array(x.length);
	for (const d of (right ? [1601, 1789, 1931, 2087] : [1559, 1693, 1867, 2053]).map((v) => v * 2)) {
		const buf = new Float64Array(d);
		let j = 0;
		let lp = 0;
		for (let i = 0; i < x.length; i++) {
			const y = buf[j];
			lp = 0.7 * y + 0.3 * lp;
			buf[j] = x[i] + lp * 0.84;
			out[i] += y / 4;
			j = (j + 1) % d;
		}
	}
	for (const d of [556, 441]) {
		const buf = new Float64Array(d);
		let j = 0;
		for (let i = 0; i < out.length; i++) {
			const b = buf[j];
			const v = out[i] + b * 0.5;
			out[i] = b - v * 0.5;
			buf[j] = v;
			j = (j + 1) % d;
		}
	}
	return out;
}

export function generateBed(o: {
	seconds: number;
	out: string;
	hits?: number[];
	bed?: string | BedSpec;
	seed?: number;
	close?: number;
}): BedResult {
	const spec: BedSpec =
		typeof o.bed === "object"
			? o.bed
			: (presets.beds as Record<string, BedSpec>)[o.bed ?? "a-minor-lift"];
	if (!spec)
		throw new Error(`unknown bed '${o.bed}'. Known: ${Object.keys(presets.beds).join(", ")}`);
	const T = o.seconds;
	if (!(T > 0 && T <= 600)) throw new Error("seconds must be between 0 and 600");
	const R = rng(o.seed ?? 8);
	const n = Math.round(T * SR);
	const hits = (o.hits ?? []).filter((h) => h > 0 && h < T);
	const BEAT = 60 / spec.bpm;
	const fh = hits[0] ?? T * 0.1;
	const close = o.close ?? T * 0.88;
	const d0 = T * 0.55;
	const d1 = T * 0.75;
	const hz = (note: string) => 440 * 2 ** ((N[note] + spec.transpose) / 12);
	const energy = (t: number) =>
		interp(t, [
			[0, 0.12],
			[Math.min(2, fh * 0.3), 0.3],
			[fh, 0.4],
			[d0, 0.7],
			[d1, 0.95],
			[close - 0.01, 0.6],
			[close, 1],
			[T - 2.5, 0.85],
			[T, 0],
		]);
	const E = new Float64Array(n);
	for (let i = 0; i < n; i++) E[i] = energy(i / SR);
	const sub = new Float64Array(n);
	const padL = new Float64Array(n);
	const padR = new Float64Array(n);
	const pl = new Float64Array(n);
	const pr = new Float64Array(n);
	const kick = new Float64Array(n);
	const fx = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		const t = i / SR;
		const v =
			Math.sin(2 * Math.PI * hz("A1") * t) + 0.45 * Math.sin(2 * Math.PI * hz("E2") * t + 0.7);
		sub[i] =
			Math.tanh(v * 1.2) *
			0.11 *
			interp(t, [
				[0, 0],
				[1.5, 1],
				[T - 3, 1],
				[T, 0],
			]) *
			(0.45 + 0.55 * E[i]);
	}
	const seg = BEAT * 8;
	const chordAt = (t: number) =>
		spec.liftAtClose && t >= close - 0.01 ? "A" : PROG[Math.floor(t / seg) % 4];
	for (let s0 = 0; s0 < T; ) {
		let s1 = Math.min(T, s0 + seg);
		if (spec.liftAtClose && s0 < close && close < s1) s1 = close;
		const i0 = Math.round(s0 * SR);
		const i1 = Math.round(s1 * SR);
		const ln = (i1 - i0) / SR;
		let bright = 0;
		for (let i = i0; i < i1; i++) bright += E[i];
		bright /= Math.max(1, i1 - i0);
		const xf = (k: number) => Math.min(1, k / SR / 0.9, (ln - k / SR) / 0.9 + 0.15);
		for (const note of CHORDS[chordAt(s0)])
			for (const [det, pan] of [
				[-0.07, 0.15],
				[0, 0.5],
				[0.08, 0.85],
			]) {
				const f = hz(note) * 2 ** (det / 12);
				const ph = R.u() * 6.28;
				const ph2 = R.u() * 6.28;
				const tmp = new Float64Array(i1 - i0);
				additive(tmp, 0, tmp.length, f, 8, 1.9 - 0.9 * bright, 0.05, ph, xf);
				additive(tmp, 0, tmp.length, f * 2, 5, 2.2 - 0.9 * bright, 0.035 * bright, ph2, xf);
				for (let k = 0; k < tmp.length; k++) {
					padL[i0 + k] += tmp[k] * (1 - pan);
					padR[i0 + k] += tmp[k] * pan;
				}
			}
		s0 = s1;
	}
	if (spec.pulse)
		for (let s = fh, i = 0; s < T - 1; s += BEAT / 2, i++) {
			const c = chordAt(s);
			const f = hz(ROOT[c]) * 4 * (i % 4 === 2 ? 1.5 : i % 8 === 7 ? 2 : 1);
			const pan = i % 2 ? 0.3 : 0.7;
			const a = 0.14 + 0.22 * E[Math.min(n - 1, Math.round(s * SR))];
			const at = Math.round(s * SR);
			const tmp = new Float64Array(SR / 2);
			const env = (k: number) => Math.exp(-k / SR / 0.11) * (1 - Math.exp(-k / SR / 0.003));
			additive(tmp, 0, tmp.length, f, 7, 1.6, a, R.u() * 6.28, env);
			for (let k = 0; k < tmp.length && at + k < n; k++) {
				pl[at + k] += tmp[k] * (1 - pan);
				pr[at + k] += tmp[k] * pan;
			}
		}
	if (spec.kick)
		for (let s = fh, b = 0; s < Math.min(close, T - 1); s += BEAT, b++) {
			const drive = s >= d0 && s < d1;
			if (!drive && b % 2) continue;
			let ph = 0;
			const at = Math.round(s * SR);
			for (let k = 0; k < SR / 2 && at + k < n; k++) {
				const t = k / SR;
				ph += (2 * Math.PI * (45 + 75 * Math.exp(-t / 0.04))) / SR;
				kick[at + k] += Math.sin(ph) * Math.exp(-t / 0.22) * (drive ? 0.9 : 0.55);
			}
		}
	const pump = new Float64Array(n);
	let ke = 0;
	const kk = Math.exp(-1 / (0.09 * SR));
	for (let i = 0; i < n; i++) {
		ke = (1 - kk) * Math.abs(kick[i]) + kk * ke;
		pump[i] = 1 - Math.min(0.55, ke * 1.6);
	}
	const boom = (at: number, g: number) => {
		let ph = 0;
		const nz = new Float64Array(Math.round(3.2 * SR));
		for (let k = 0; k < nz.length; k++) nz[k] = R.n();
		onePole(nz, 900);
		for (let k = 0; k < nz.length && at + k < n; k++) {
			const t = k / SR;
			ph += (2 * Math.PI * (28 + 52 * Math.exp(-t / 0.25))) / SR;
			if (at + k >= 0)
				fx[at + k] += (Math.sin(ph) * Math.exp(-t / 1.1) + nz[k] * Math.exp(-t / 0.35) * 0.6) * g;
		}
	};
	for (const h of hits) {
		const len = Math.round(1.6 * SR);
		const at = Math.round(h * SR) - len;
		const nz = new Float64Array(len);
		for (let k = 0; k < len; k++) nz[k] = R.n();
		onePole(onePole(nz, 400, true), 7000);
		let ph = 0;
		for (let k = 0; k < len; k++) {
			const x = k / len;
			ph += (2 * Math.PI * (220 + 660 * x * x)) / SR;
			if (at + k >= 0) fx[at + k] += (nz[k] * 0.5 + Math.sin(ph) * 0.15) * x ** 2.4 * 0.3;
		}
		boom(Math.round(h * SR), 0.4);
	}
	if (spec.liftAtClose && close < T) boom(Math.round(close * SR), 0.55);
	const wetIn = (L: boolean) => {
		const w = new Float64Array(n);
		for (let i = 0; i < n; i++)
			w[i] =
				((L ? padL[i] : padR[i]) * (0.12 + E[i]) + (L ? pl[i] : pr[i])) * pump[i] + fx[i] * 0.6;
		return w;
	};
	const wl = hall(wetIn(true), false);
	const wr = hall(wetIn(false), true);
	const out = [new Float64Array(n), new Float64Array(n)];
	let peak = 1e-9;
	for (let i = 0; i < n; i++) {
		const t = i / SR;
		const tail = interp(t, [
			[0, 0],
			[0.05, 1],
			[T - 2.8, 1],
			[T, 0],
		]);
		for (const [c, pad, pu, w] of [
			[0, padL, pl, wl],
			[1, padR, pr, wr],
		] as const) {
			out[c][i] =
				(sub[i] +
					(pad[i] * (0.12 + E[i]) + pu[i]) * pump[i] +
					kick[i] * 0.45 +
					fx[i] +
					w[i] * 0.35) *
				tail;
			peak = Math.max(peak, Math.abs(out[c][i]));
		}
	}
	let p2 = 1e-9;
	for (const ch of out)
		for (let i = 0; i < n; i++) {
			ch[i] = Math.tanh((ch[i] / peak) * 1.15);
			p2 = Math.max(p2, Math.abs(ch[i]));
		}
	const g = 10 ** (-1 / 20) / p2;
	const buf = Buffer.alloc(44 + n * 4);
	buf.write("RIFF", 0, "ascii");
	buf.writeUInt32LE(36 + n * 4, 4);
	buf.write("WAVEfmt ", 8, "ascii");
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(2, 22);
	buf.writeUInt32LE(SR, 24);
	buf.writeUInt32LE(SR * 4, 28);
	buf.writeUInt16LE(4, 32);
	buf.writeUInt16LE(16, 34);
	buf.write("data", 36, "ascii");
	buf.writeUInt32LE(n * 4, 40);
	let sq = 0;
	let pk = 0;
	for (let i = 0; i < n; i++)
		for (let c = 0; c < 2; c++) {
			const v = Math.round(out[c][i] * g * 32767);
			buf.writeInt16LE(Math.max(-32768, Math.min(32767, v)), 44 + i * 4 + c * 2);
			sq += (v / 32768) ** 2;
			pk = Math.max(pk, Math.abs(v) / 32768);
		}
	writeFileSync(o.out, buf);
	return {
		path: o.out,
		seconds: T,
		key: spec.key,
		peakDb: 20 * Math.log10(pk),
		rmsDb: 10 * Math.log10(sq / (2 * n) + 1e-12),
	};
}
