/**
 * 8J-D student: a frozen bge-small-en-v1.5 encoder (int8 ONNX, MIT) plus a
 * 384x3 softmax head distilled from the local 27B teacher's [allow, ask, block]
 * distribution over PUBLIC commands. It returns probabilities and two deferral
 * signals, never a verdict: thresholds live in policy.ts, deferral in the guard.
 *
 *   score(command) -> { probs, ood, oodScore, truncated, tokens }
 *
 * Nothing heavy ships in the repo. Weights are read from a directory
 * (EIGHT_DECIDE_STUDENT_DIR, default ~/.8gent/models/8j-student):
 *
 *   meta.json      { encoder, encoderSha256?, dim, maxTokens, k, oodThreshold }
 *   head.json      { W: number[3][dim], b: number[3] }
 *   ood-bank.f32   L2-normalised training embeddings, float32, row-major (n x dim)
 *
 * `encoder` is a directory holding model_quantized.onnx and vocab.txt
 * (Xenova/bge-small-en-v1.5). onnxruntime-node is an OPTIONAL dependency and
 * is imported dynamically, like node-llama-cpp in backends/llamacpp.ts. When it
 * or the weights are missing, `loadStudent` throws DecideUnavailableError and
 * the caller keeps today's path.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type ChoiceAnswer,
	type DecideBackend,
	DecideError,
	DecideUnavailableError,
	type SystemOneRequest,
	type SystemOneResponse,
	validateRequest,
} from "./types";

export const STUDENT_CLASSES = ["allow", "ask", "block"] as const;
export type StudentClass = (typeof STUDENT_CLASSES)[number];

// ----- WordPiece tokenizer (HF BertTokenizer parity: uncased, strip accents) --

/** HF `_is_punctuation`: ASCII non-alphanumeric printable ranges, or any Unicode P* category. */
function isPunctuation(ch: string): boolean {
	const cp = ch.codePointAt(0) ?? 0;
	if (
		(cp >= 33 && cp <= 47) ||
		(cp >= 58 && cp <= 64) ||
		(cp >= 91 && cp <= 96) ||
		(cp >= 123 && cp <= 126)
	)
		return true;
	return /\p{P}/u.test(ch);
}
function isWhitespace(ch: string): boolean {
	return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || /\p{Zs}/u.test(ch);
}
function isControl(ch: string): boolean {
	if (ch === "\t" || ch === "\n" || ch === "\r") return false;
	return /\p{Cc}|\p{Cf}|\p{Co}|\p{Cs}/u.test(ch);
}
function isCjk(cp: number): boolean {
	return (
		(cp >= 0x4e00 && cp <= 0x9fff) ||
		(cp >= 0x3400 && cp <= 0x4dbf) ||
		(cp >= 0x20000 && cp <= 0x2a6df) ||
		(cp >= 0x2a700 && cp <= 0x2b73f) ||
		(cp >= 0x2b740 && cp <= 0x2b81f) ||
		(cp >= 0x2b820 && cp <= 0x2ceaf) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0x2f800 && cp <= 0x2fa1f)
	);
}

export class WordPieceTokenizer {
	readonly cls: number;
	readonly sep: number;
	readonly unk: number;
	constructor(
		readonly vocab: ReadonlyMap<string, number>,
		readonly maxCharsPerWord = 100,
	) {
		const get = (t: string) => {
			const id = vocab.get(t);
			if (id === undefined) throw new DecideError(`vocab has no ${t}`);
			return id;
		};
		this.cls = get("[CLS]");
		this.sep = get("[SEP]");
		this.unk = get("[UNK]");
	}

	static fromVocabText(text: string): WordPieceTokenizer {
		const m = new Map<string, number>();
		text.split("\n").forEach((t, i) => {
			const tok = t.replace(/\r$/, "");
			if (tok.length && !m.has(tok)) m.set(tok, i);
		});
		return new WordPieceTokenizer(m);
	}

	/** BertNormalizer + BertPreTokenizer: the words WordPiece sees. */
	basicTokens(text: string): string[] {
		let clean = "";
		for (const ch of text) {
			const cp = ch.codePointAt(0) ?? 0;
			if (cp === 0 || cp === 0xfffd || isControl(ch)) continue;
			if (isWhitespace(ch)) clean += " ";
			else if (isCjk(cp)) clean += ` ${ch} `;
			else clean += ch;
		}
		clean = clean
			.toLowerCase()
			.normalize("NFD")
			.replace(/\p{Mn}/gu, "");
		const out: string[] = [];
		for (const word of clean.split(" ")) {
			if (!word) continue;
			let cur = "";
			for (const ch of word) {
				if (isPunctuation(ch)) {
					if (cur) out.push(cur);
					out.push(ch);
					cur = "";
				} else cur += ch;
			}
			if (cur) out.push(cur);
		}
		return out;
	}

	/** Word-piece ids for the text, without [CLS]/[SEP]. */
	pieces(text: string): number[] {
		const ids: number[] = [];
		for (const word of this.basicTokens(text)) {
			const chars = [...word];
			if (chars.length > this.maxCharsPerWord) {
				ids.push(this.unk);
				continue;
			}
			const sub: number[] = [];
			let start = 0;
			let bad = false;
			while (start < chars.length) {
				let end = chars.length;
				let found = -1;
				while (start < end) {
					const piece = (start > 0 ? "##" : "") + chars.slice(start, end).join("");
					const id = this.vocab.get(piece);
					if (id !== undefined) {
						found = id;
						break;
					}
					end--;
				}
				if (found < 0) {
					bad = true;
					break;
				}
				sub.push(found);
				start = end;
			}
			if (bad) ids.push(this.unk);
			else ids.push(...sub);
		}
		return ids;
	}

	/**
	 * [CLS] pieces [SEP], cut to `maxTokens` in total. `tokens` is the untruncated
	 * length including [CLS]/[SEP]; `truncated` is true when anything was cut.
	 */
	encode(text: string, maxTokens: number): { ids: number[]; tokens: number; truncated: boolean } {
		const p = this.pieces(text);
		const tokens = p.length + 2;
		const keep = Math.max(0, maxTokens - 2);
		return {
			ids: [this.cls, ...p.slice(0, keep), this.sep],
			tokens,
			truncated: tokens > maxTokens,
		};
	}
}

// ----- head + OOD math (pure, tested without the encoder) ---------------------

export interface StudentHead {
	W: number[][];
	b: number[];
}

export function softmax(z: number[]): number[] {
	const m = Math.max(...z);
	const e = z.map((x) => Math.exp(x - m));
	const s = e.reduce((a, b) => a + b, 0);
	return e.map((x) => x / s);
}

export function applyHead(head: StudentHead, x: Float32Array | number[]): number[] {
	const z = head.W.map((row, c) => {
		let s = head.b[c];
		for (let i = 0; i < row.length; i++) s += row[i] * x[i];
		return s;
	});
	return softmax(z);
}

export function l2normalise(x: Float32Array): Float32Array {
	let s = 0;
	for (let i = 0; i < x.length; i++) s += x[i] * x[i];
	const n = Math.sqrt(s) || 1;
	const out = new Float32Array(x.length);
	for (let i = 0; i < x.length; i++) out[i] = x[i] / n;
	return out;
}

/**
 * kNN OOD score: 1 - mean cosine similarity to the k nearest rows of the bank
 * (rows and x are L2-normalised). Higher is further from the training data.
 */
export function knnScore(bank: Float32Array, dim: number, x: Float32Array, k: number): number {
	const n = Math.floor(bank.length / dim);
	if (n === 0) return Number.POSITIVE_INFINITY;
	const kk = Math.min(k, n);
	const top = new Float64Array(kk).fill(-2);
	for (let r = 0; r < n; r++) {
		let s = 0;
		const o = r * dim;
		for (let i = 0; i < dim; i++) s += bank[o + i] * x[i];
		if (s > top[kk - 1]) {
			let j = kk - 1;
			while (j > 0 && top[j - 1] < s) {
				top[j] = top[j - 1];
				j--;
			}
			top[j] = s;
		}
	}
	let sum = 0;
	for (const s of top) sum += s;
	return 1 - sum / kk;
}

/** Sentence vector from a [1, n, dim] hidden state: the CLS row, or the mean over all n rows. */
export function pool(
	hidden: Float32Array,
	n: number,
	dim: number,
	how: "cls" | "mean",
): Float32Array {
	if (how === "cls") return hidden.slice(0, dim);
	const out = new Float32Array(dim);
	for (let t = 0; t < n; t++) for (let i = 0; i < dim; i++) out[i] += hidden[t * dim + i];
	for (let i = 0; i < dim; i++) out[i] /= n;
	return out;
}

// ----- ONNX encoder (optional dependency) ---------------------------------------

interface OrtTensor {
	data: Float32Array;
	dims: readonly number[];
}
interface OrtSession {
	inputNames: readonly string[];
	outputNames: readonly string[];
	run(feeds: Record<string, unknown>): Promise<Record<string, OrtTensor>>;
}
export interface OnnxRuntimeModule {
	InferenceSession: { create(path: string, opts?: Record<string, unknown>): Promise<OrtSession> };
	Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
}
/** Loads the optional package. Injected in tests. */
export type OnnxLoader = () => Promise<OnnxRuntimeModule>;
// A variable specifier keeps the bundler and typechecker from resolving the optional package.
const ORT_PACKAGE = "onnxruntime-node";
export const defaultOnnxLoader: OnnxLoader = async () => {
	const mod = (await import(ORT_PACKAGE)) as OnnxRuntimeModule & { default?: OnnxRuntimeModule };
	return mod.InferenceSession ? mod : (mod.default as OnnxRuntimeModule);
};

export interface StudentMeta {
	encoder: string;
	encoderSha256?: string;
	dim: number;
	maxTokens: number;
	k: number;
	oodThreshold: number;
	trainedOn?: string;
	/** "cls" (bge default, first token) or "mean" (attention-masked mean). Default "cls". */
	pooling?: "cls" | "mean";
}

export interface StudentScore {
	/** [allow, ask, block], sums to 1. */
	probs: number[];
	/** true when the kNN score is above the 99th-percentile threshold from training. */
	ood: boolean;
	oodScore: number;
	/** true when the command is longer than meta.maxTokens word pieces. */
	truncated: boolean;
	tokens: number;
}

export interface Student {
	readonly meta: StudentMeta;
	/** Word-piece length check without running the encoder (a truncated command defers anyway). */
	measure(text: string): { tokens: number; truncated: boolean };
	/** L2-normalised CLS embedding. */
	embed(text: string): Promise<{ vec: Float32Array; tokens: number; truncated: boolean }>;
	score(command: string): Promise<StudentScore>;
}

export function defaultStudentDir(env: Record<string, string | undefined> = process.env): string {
	return (
		env.EIGHT_DECIDE_STUDENT_DIR?.trim() ||
		path.join(env.HOME?.trim() || os.homedir(), ".8gent", "models", "8j-student")
	);
}

export interface LoadStudentOptions {
	dir?: string;
	loader?: OnnxLoader;
	/** onnxruntime intra-op threads. Default env EIGHT_STUDENT_THREADS, else 4. */
	threads?: number;
	/** Load only the encoder (training-time embedding, before a head exists). */
	encoderOnly?: boolean;
	/** Encoder dir when encoderOnly (no meta.json yet). */
	encoderDir?: string;
	maxTokens?: number;
	/** Pooling when encoderOnly. */
	pooling?: "cls" | "mean";
}

function readJson<T>(file: string): T {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch (err) {
		throw new DecideUnavailableError(`student file unreadable: ${file}: ${(err as Error).message}`);
	}
}

export async function loadStudent(opts: LoadStudentOptions = {}): Promise<Student> {
	const dir = opts.dir ?? defaultStudentDir();
	const meta: StudentMeta = opts.encoderOnly
		? {
				encoder: opts.encoderDir ?? "",
				dim: 384,
				maxTokens: opts.maxTokens ?? 256,
				k: 10,
				oodThreshold: Number.POSITIVE_INFINITY,
				pooling: opts.pooling,
			}
		: readJson<StudentMeta>(path.join(dir, "meta.json"));
	const encDir = meta.encoder.startsWith("~")
		? path.join(os.homedir(), meta.encoder.slice(1))
		: meta.encoder;
	const modelFile = path.join(encDir, "model_quantized.onnx");
	const vocabFile = path.join(encDir, "vocab.txt");
	if (!fs.existsSync(modelFile) || !fs.existsSync(vocabFile))
		throw new DecideUnavailableError(`student encoder missing in ${encDir}`);
	const tok = WordPieceTokenizer.fromVocabText(fs.readFileSync(vocabFile, "utf8"));
	const ort = await (opts.loader ?? defaultOnnxLoader)().catch((err: Error) => {
		throw new DecideUnavailableError(
			`onnxruntime-node not installed (optional dependency): ${err.message}`,
		);
	});
	const threads = opts.threads ?? (Number(process.env.EIGHT_STUDENT_THREADS) || 4);
	const session = await ort.InferenceSession.create(modelFile, {
		executionProviders: ["cpu"],
		intraOpNumThreads: threads,
		interOpNumThreads: 1,
		graphOptimizationLevel: "all",
	});
	const head = opts.encoderOnly ? null : readJson<StudentHead>(path.join(dir, "head.json"));
	if (
		head &&
		(head.W.length !== 3 || head.W.some((r) => r.length !== meta.dim) || head.b.length !== 3)
	) {
		throw new DecideUnavailableError(`student head shape is not 3x${meta.dim}`);
	}
	let bank = new Float32Array(0);
	if (!opts.encoderOnly) {
		const buf = fs.readFileSync(path.join(dir, "ood-bank.f32"));
		bank = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
	}

	const embed = async (text: string) => {
		const { ids, tokens, truncated } = tok.encode(text, meta.maxTokens);
		const n = ids.length;
		const feeds: Record<string, unknown> = {
			input_ids: new ort.Tensor(
				"int64",
				BigInt64Array.from(ids, (x) => BigInt(x)),
				[1, n],
			),
			attention_mask: new ort.Tensor("int64", new BigInt64Array(n).fill(1n), [1, n]),
			token_type_ids: new ort.Tensor("int64", new BigInt64Array(n), [1, n]),
		};
		for (const k of Object.keys(feeds)) if (!session.inputNames.includes(k)) delete feeds[k];
		const out = await session.run(feeds);
		const hidden = out.last_hidden_state ?? out[session.outputNames[0]];
		return {
			vec: l2normalise(pool(hidden.data, n, meta.dim, meta.pooling ?? "cls")),
			tokens,
			truncated,
		};
	};

	return {
		meta,
		measure(text: string) {
			const { tokens, truncated } = tok.encode(text, meta.maxTokens);
			return { tokens, truncated };
		},
		embed,
		async score(command: string): Promise<StudentScore> {
			if (!head) throw new DecideError("student loaded encoder-only; no head");
			const { vec, tokens, truncated } = await embed(command);
			const probs = applyHead(head, vec);
			const oodScore = knnScore(bank, meta.dim, vec, meta.k);
			return { probs, ood: !(oodScore <= meta.oodThreshold), oodScore, truncated, tokens };
		},
	};
}

// ----- DecideBackend adapter ------------------------------------------------------

/** The command inside a `guardState` block (the JSON line between the markers), or the state itself. */
export function commandFromState(state: string): string {
	const lines = state.split("\n");
	const i = lines.findIndex((l) => /^<<<CMD-[0-9a-f]{16}$/.test(l));
	if (i >= 0 && i + 1 < lines.length) {
		try {
			const v = JSON.parse(lines[i + 1]);
			if (typeof v === "string") return v;
		} catch {
			// fall through: judge the raw state
		}
	}
	return state;
}

/**
 * Answers only the 3-way [allow, ask, block] `choice` question, with the
 * student's probabilities. It never applies thresholds (policy.ts does), so
 * eval/run.ts-style scorers can use it unchanged.
 */
export class StudentBackend implements DecideBackend {
	readonly name = "student";
	readonly model: string;
	constructor(private readonly student: Student) {
		this.model = `bge-small-en-v1.5+head${student.meta.trainedOn ? `@${student.meta.trainedOn}` : ""}`;
	}
	async ask(request: SystemOneRequest): Promise<SystemOneResponse> {
		validateRequest(request);
		const t0 = performance.now();
		const answers: ChoiceAnswer[] = [];
		for (const q of request.questions) {
			if (q.kind !== "choice" || q.options.length !== 3) {
				throw new DecideError(
					`student answers only the 3-way allow/ask/block choice question, not "${q.id}"`,
				);
			}
			const s = await this.student.score(commandFromState(request.state));
			let chosen = 0;
			for (let i = 1; i < 3; i++) if (s.probs[i] > s.probs[chosen]) chosen = i;
			answers.push({
				id: q.id,
				kind: "choice",
				probabilities: s.probs,
				chosen,
				confidence: s.probs[chosen],
			});
		}
		return { answers, backend: this.name, model: this.model, latencyMs: performance.now() - t0 };
	}
}
