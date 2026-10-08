/**
 * Audio-first decide backend: Neuphonic NeuDecide (Apache-2.0, 43 MB ONNX).
 *
 * A spoken command plus a small candidate set (intent or tool names) goes
 * in; a choice answer comes out, with no transcript in between. Opt-in
 * prototype behind EIGHT_VOICE_DECIDE=1, default off (issue #3688).
 *
 * Same shape as the text backends in this folder: `name`, `model`, `ask()`
 * returning `{ answer, backend, model, latencyMs }`, where `answer` is the
 * same `ChoiceAnswer` the text backends return. As there, the backend only
 * reports; code owns the threshold (`pickIntent`).
 *
 * This only ever picks an intent. It executes nothing. Whatever the caller
 * does with the intent still goes through the normal TUI and permission path.
 *
 * Limits from the authors: English only, 30 s audio cap (longer audio is
 * truncated by the model, so we refuse it and fall back to Whisper).
 *
 * The real backend shells out to the `neudecide` Python package with
 * HF_HUB_OFFLINE=1, so it never downloads anything at routing time. The
 * weights sit behind a Hugging Face contact-sharing gate; fetching them is a
 * step James does himself (see the PR for #3688). Until then every call
 * fails and the voice path falls back to Whisper.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChoiceAnswer, DecideError, answerFromDistribution, renormalise } from "../types";

/** The model truncates past this, so we do not send it. */
export const MAX_AUDIO_MS = 30_000;
/** Keep the tool list well inside the model's 1,536 tool-token limit. */
export const MAX_AUDIO_CANDIDATES = 32;
/** Default threshold for routing straight from audio. Code owns it. */
export const DEFAULT_MIN_CONFIDENCE = 0.8;
const DEFAULT_TIMEOUT_MS = 2_000;

export interface AudioCandidate {
	/** Intent or tool name returned on a match. */
	name: string;
	/** What it does; the model reads this, so it should be clear. */
	description: string;
}

/**
 * Intents the audio router may pick. Low-risk dictation and session controls
 * only. Lifecycle verbs (approve, reject, dispatch, merge, stop, steer) are
 * left out on purpose: they can ship or kill work, so they stay on the
 * transcript path with the grammar's stricter matching.
 */
export const VOICE_DECIDE_CANDIDATES: AudioCandidate[] = [
	{ name: "submit", description: "Send the composed input." },
	{ name: "scratch", description: "Clear the current input buffer." },
	{ name: "undo_word", description: "Remove the last dictated word." },
	{ name: "newline", description: "Insert a line break." },
	{ name: "help", description: "Read the available voice commands." },
	{ name: "repeat", description: "Repeat the last spoken response." },
	{ name: "cancel", description: "Dismiss the current voice interaction." },
];

export interface AudioDecideRequest {
	/** WAV bytes (16 kHz mono PCM is what the recorder produces). */
	audio: Uint8Array;
	candidates: AudioCandidate[];
}

export interface AudioDecideResponse {
	/** Null when the model says no candidate applies. */
	answer: ChoiceAnswer | null;
	/**
	 * False when the probabilities are not a real distribution from the
	 * model. NeuDecide's public API returns a call, not scores, so its
	 * answers are one-hot and this is false.
	 */
	calibrated: boolean;
	backend: string;
	model: string;
	latencyMs: number;
}

export interface AudioDecideBackend {
	readonly name: string;
	readonly model: string;
	ask(request: AudioDecideRequest): Promise<AudioDecideResponse>;
}

export function voiceDecideEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return env.EIGHT_VOICE_DECIDE === "1";
}

/** Duration of a PCM WAV from its fmt byte rate and data chunk size, or null. */
export function wavDurationMs(buf: Uint8Array): number | null {
	if (buf.length < 12) return null;
	const tag = (o: number) => String.fromCharCode(buf[o], buf[o + 1], buf[o + 2], buf[o + 3]);
	if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
	const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	let byteRate = 0;
	let off = 12;
	while (off + 8 <= buf.length) {
		const id = tag(off);
		const size = v.getUint32(off + 4, true);
		if (id === "fmt " && off + 16 <= buf.length) byteRate = v.getUint32(off + 16, true);
		if (id === "data") {
			if (byteRate <= 0) return null;
			// The recorder may leave the size field unset while streaming; use what is there.
			const bytes = Math.min(size, buf.length - off - 8);
			return Math.round((bytes / byteRate) * 1000);
		}
		off += 8 + size + (size % 2);
	}
	return null;
}

function validate(request: AudioDecideRequest): void {
	if (!(request.audio instanceof Uint8Array) || request.audio.length === 0) {
		throw new DecideError("audio must be non-empty WAV bytes");
	}
	const c = request.candidates;
	if (!Array.isArray(c) || c.length < 2 || c.length > MAX_AUDIO_CANDIDATES) {
		throw new DecideError(`audio decide needs 2..${MAX_AUDIO_CANDIDATES} candidates`);
	}
	const seen = new Set<string>();
	for (const k of c) {
		if (!k || typeof k.name !== "string" || k.name.length === 0)
			throw new DecideError("candidate.name must be non-empty");
		if (seen.has(k.name)) throw new DecideError(`duplicate candidate "${k.name}"`);
		seen.add(k.name);
	}
}

function choiceAnswer(candidates: AudioCandidate[], dist: number[]): ChoiceAnswer {
	const q = {
		id: "intent",
		kind: "choice" as const,
		prompt: "intent",
		options: candidates.map((c) => c.name),
	};
	return answerFromDistribution(q, dist) as ChoiceAnswer;
}

/**
 * Deterministic offline MOCK. For tests and the bench's dry run only. The
 * scorer gets the audio and candidates and returns raw masses (one per
 * candidate) or null for "no candidate applies".
 */
export class MockAudioBackend implements AudioDecideBackend {
	readonly name = "mock-audio";
	readonly model = "mock";
	constructor(
		private readonly scorer: (audio: Uint8Array, candidates: AudioCandidate[]) => number[] | null,
	) {}

	async ask(request: AudioDecideRequest): Promise<AudioDecideResponse> {
		validate(request);
		const masses = this.scorer(request.audio, request.candidates);
		const answer = masses === null ? null : choiceAnswer(request.candidates, renormalise(masses));
		return { answer, calibrated: true, backend: this.name, model: this.model, latencyMs: 0 };
	}
}

/** Runs NeuDecide on a WAV path with a tools JSON string; returns its stdout. */
export type NeuDecideRunner = (wavPath: string, toolsJson: string) => Promise<string>;

const PY = `import json, sys
from neudecide import NeuDecide
calls = NeuDecide.from_pretrained().generate(sys.argv[1], json.loads(sys.argv[2]))
print(json.dumps(calls))`;

/** Default runner: `python3 -c` against an installed `neudecide`, offline only. */
export function pythonRunner(
	env: Record<string, string | undefined> = process.env,
): NeuDecideRunner {
	const python = env.EIGHT_NEUDECIDE_PYTHON?.trim() || "python3";
	return async (wavPath, toolsJson) => {
		const proc = Bun.spawn([python, "-c", PY, wavPath, toolsJson], {
			stdout: "pipe",
			stderr: "pipe",
			env: { ...env, HF_HUB_OFFLINE: "1" },
		});
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (code !== 0)
			throw new DecideError(`neudecide exited ${code}: ${err.trim().split("\n").pop() ?? ""}`);
		return out;
	};
}

export interface NeuDecideBackendOptions {
	run?: NeuDecideRunner;
	env?: Record<string, string | undefined>;
}

export class NeuDecideBackend implements AudioDecideBackend {
	readonly name = "neudecide";
	readonly model = "neuphonic/neudecide-q4";
	private readonly run: NeuDecideRunner;

	constructor(opts: NeuDecideBackendOptions = {}) {
		this.run = opts.run ?? pythonRunner(opts.env);
	}

	async ask(request: AudioDecideRequest): Promise<AudioDecideResponse> {
		validate(request);
		// Tools as the model expects them: name, description, JSON Schema parameters.
		const tools = request.candidates.map((c) => ({
			name: c.name,
			description: c.description,
			parameters: { type: "object", properties: {} },
		}));
		const dir = mkdtempSync(join(tmpdir(), "8gent-neudecide-"));
		const wavPath = join(dir, "in.wav");
		const t0 = performance.now();
		let out: string;
		try {
			writeFileSync(wavPath, request.audio);
			out = await this.run(wavPath, JSON.stringify(tools));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		const latencyMs = performance.now() - t0;
		let calls: unknown;
		try {
			calls = JSON.parse(out.trim());
		} catch {
			throw new DecideError("neudecide: output is not JSON");
		}
		if (!Array.isArray(calls)) throw new DecideError("neudecide: output is not a list");
		let answer: ChoiceAnswer | null = null;
		if (calls.length === 1) {
			const name = (calls[0] as { name?: unknown })?.name;
			const idx = request.candidates.findIndex((c) => c.name === name);
			if (idx >= 0)
				answer = choiceAnswer(
					request.candidates,
					request.candidates.map((_, i) => (i === idx ? 1 : 0)),
				);
		}
		return { answer, calibrated: false, backend: this.name, model: this.model, latencyMs };
	}
}

/** Threshold step. Code, not the backend, decides what is confident enough. */
export function pickIntent(
	res: AudioDecideResponse,
	candidates: AudioCandidate[],
	minConfidence = DEFAULT_MIN_CONFIDENCE,
): { choice: string; confidence: number } | "unsure" {
	const a = res.answer;
	if (!a || a.confidence < minConfidence) return "unsure";
	const c = candidates[a.chosen];
	return c ? { choice: c.name, confidence: a.confidence } : "unsure";
}

export type VoiceRoute =
	| { routed: true; choice: string; confidence: number; backend: string }
	| { routed: false; reason: "too-long" | "not-wav" | "unsure" | "error"; detail?: string };

/**
 * Decide whether a recorded command can skip transcription. Never throws:
 * every failure is a fallback to the existing Whisper path.
 */
export async function routeVoiceAudio(
	backend: AudioDecideBackend,
	audio: Uint8Array,
	candidates: AudioCandidate[],
	opts: { minConfidence?: number; timeoutMs?: number } = {},
): Promise<VoiceRoute> {
	const ms = wavDurationMs(audio);
	if (ms === null) return { routed: false, reason: "not-wav" };
	if (ms > MAX_AUDIO_MS) return { routed: false, reason: "too-long" };
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new DecideError("timeout")),
				opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			);
		});
		const res = await Promise.race([backend.ask({ audio, candidates }), timeout]);
		const pick = pickIntent(res, candidates, opts.minConfidence);
		if (pick === "unsure") return { routed: false, reason: "unsure" };
		return { routed: true, choice: pick.choice, confidence: pick.confidence, backend: res.backend };
	} catch (err) {
		return {
			routed: false,
			reason: "error",
			detail: err instanceof Error ? err.message : String(err),
		};
	} finally {
		if (timer) clearTimeout(timer);
	}
}
