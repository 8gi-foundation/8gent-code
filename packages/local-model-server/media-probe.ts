/**
 * Local media capability probe (#3422).
 *
 * Asks the model servers on THIS machine what they can make (chat, image,
 * music, 3d, ...) by reading `GET /v1/models`, so a media path can try a local
 * model before any cloud call. Concept from mlx-serve's agent skill (read
 * `/v1/models`, pick by `capabilities`, never guess an id, say so plainly when
 * nothing can do the job); no code is taken from it and nothing is installed.
 *
 * Rules this file keeps:
 *   - Loopback only. A non-loopback base URL is refused before any request
 *     and redirects are not followed. A model whose `state` is "remote" is
 *     never picked, but that field is mlx-serve's: a loopback server that
 *     proxies to a cloud model without saying so cannot be detected here.
 *   - Bounded reads: /v1/models bodies over 2 MB are refused (Content-Length
 *     first, then a counting reader), as are oversized capability lists.
 *   - A declared `capabilities` list is authoritative. Without one, a model is
 *     classed by a short list of known media model names, and anything else is
 *     classed as nothing. A chat model is never assumed to make images.
 *   - Ids are returned exactly as the server listed them, never constructed.
 *   - Short timeouts, bounded work, no regex that can backtrack.
 */

import { resolveOllamaBaseUrl } from "./ollama-host";
import { isLlamaServerSelected, isOllamaEnabled, resolveLlamaServerUrl } from "./select";

type Env = Record<string, string | undefined>;

export type MediaCapability = "chat" | "image" | "music" | "3d" | (string & {});

export interface ProbedModel {
	/** The id exactly as the server listed it. */
	id: string;
	/** Server root the model was listed by (no trailing slash, no /v1). */
	baseUrl: string;
	capabilities: string[];
	/** "declared": the server's own capabilities list. "name": matched a known media model name. */
	source: "declared" | "name";
	/** Server-reported load state when given (mlx-serve: ready | unloaded | remote). */
	state?: string;
}

export interface EndpointReport {
	baseUrl: string;
	ok: boolean;
	/** Why the endpoint gave nothing: refused, unreachable, HTTP status, bad body. */
	error?: string;
	modelCount: number;
}

export interface MediaProbeResult {
	endpoints: EndpointReport[];
	models: ProbedModel[];
}

export type LocalPick =
	| { ok: true; model: ProbedModel }
	| { ok: false; reason: string; answered: number; asked: number };

/** The capabilities this probe picks for. Chat discovery stays with orchestration/local-model-detect. */
export const MEDIA_CAPABILITIES: readonly string[] = ["image", "music", "3d"];

export const DEFAULT_MLX_SERVE_URL = "http://127.0.0.1:11234";
export const DEFAULT_LM_STUDIO_URL = "http://localhost:1234";
export const DEFAULT_PROBE_TIMEOUT_MS = 1500;
/** Upper bound on models read per endpoint, so a hostile or broken list costs bounded work. */
const MAX_MODELS_PER_ENDPOINT = 500;
const MAX_ID_LENGTH = 256;
/** Largest /v1/models body read. A real list is a few KB. */
export const MAX_MODELS_BODY_BYTES = 2 * 1024 * 1024;
/** Capability entries kept per model, and the longest entry kept. */
const MAX_CAPABILITIES = 32;
const MAX_CAPABILITY_LENGTH = 32;

export class BodyTooLargeError extends Error {
	constructor(maxBytes: number) {
		super(`response body over ${maxBytes} bytes`);
		this.name = "BodyTooLargeError";
	}
}

/**
 * Read a response body into memory, refusing more than `maxBytes`: a
 * Content-Length over the cap is refused before reading, and a counting
 * reader cancels the stream as soon as the running total passes it, so a
 * server that lies about (or omits) its length still costs at most the cap.
 */
export async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
	const declared = Number(res.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) {
		await res.body?.cancel().catch(() => {});
		throw new BodyTooLargeError(maxBytes);
	}
	if (!res.body) return new Uint8Array(0);
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel().catch(() => {});
			throw new BodyTooLargeError(maxBytes);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.byteLength;
	}
	return out;
}

/** A server-supplied string made safe for one log line: C0 and C1 control characters removed. */
export function safeForLog(text: string): string {
	let out = "";
	for (const ch of text) {
		const c = ch.charCodeAt(0);
		if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) continue;
		out += ch;
	}
	return out;
}

/** Strip trailing slashes and a trailing "/v1" without a regex. */
export function serverRoot(raw: string): string {
	let v = raw.trim();
	while (v.endsWith("/")) v = v.slice(0, -1);
	if (v.endsWith("/v1")) v = v.slice(0, -3);
	while (v.endsWith("/")) v = v.slice(0, -1);
	return v;
}

/** True only for http(s) URLs whose host is this machine: localhost, 127.0.0.0/8, ::1. */
export function isLoopbackUrl(raw: string): boolean {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return false;
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return false;
	if (u.username || u.password) return false;
	const host = u.hostname.toLowerCase();
	if (host === "localhost" || host === "[::1]" || host === "::1") return true;
	const parts = host.split(".");
	if (parts.length !== 4 || parts[0] !== "127") return false;
	return parts.every(
		(p) =>
			p.length > 0 &&
			p.length <= 3 &&
			[...p].every((c) => c >= "0" && c <= "9") &&
			Number(p) <= 255,
	);
}

/**
 * The local servers worth asking, from the same env the rest of the harness
 * reads: mlx-serve (MLX_SERVE_URL), LM Studio (LM_STUDIO_HOST), Ollama when it
 * is enabled for the process, llama-server when it is selected. Deduplicated.
 * Non-loopback values are kept here so the probe can report the refusal.
 */
export function configuredLocalEndpoints(env: Env = process.env): string[] {
	const list = [
		env.MLX_SERVE_URL?.trim() || DEFAULT_MLX_SERVE_URL,
		env.LM_STUDIO_HOST?.trim() || DEFAULT_LM_STUDIO_URL,
	];
	if (isOllamaEnabled(env)) list.push(resolveOllamaBaseUrl(env));
	if (isLlamaServerSelected(env)) list.push(resolveLlamaServerUrl(env));
	return [...new Set(list.map(serverRoot))];
}

/** Lower-case alphanumeric tokens of a model id, split on everything else. Linear. */
function tokens(id: string): string[] {
	const out: string[] = [];
	let cur = "";
	for (const ch of id.toLowerCase()) {
		if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) cur += ch;
		else if (cur) {
			out.push(cur);
			cur = "";
		}
	}
	if (cur) out.push(cur);
	return out;
}

/**
 * Known media model names, as token sequences. Deliberately short: a miss
 * means "no local model can do X" and the cloud path runs as before; a false
 * hit would send a sprite prompt to a chat model.
 */
const NAME_PATTERNS: ReadonlyArray<{ cap: string; seq: string[] }> = [
	{ cap: "image", seq: ["flux"] },
	{ cap: "image", seq: ["stable", "diffusion"] },
	{ cap: "image", seq: ["sdxl"] },
	{ cap: "image", seq: ["sd3"] },
	{ cap: "image", seq: ["z", "image"] },
	{ cap: "image", seq: ["qwen", "image"] },
	{ cap: "music", seq: ["musicgen"] },
	{ cap: "music", seq: ["ace", "step"] },
	{ cap: "music", seq: ["stable", "audio"] },
	{ cap: "3d", seq: ["hunyuan3d"] },
	{ cap: "3d", seq: ["trellis"] },
	{ cap: "3d", seq: ["triposr"] },
	{ cap: "3d", seq: ["triposg"] },
];

function hasSeq(toks: string[], seq: string[]): boolean {
	for (let i = 0; i + seq.length <= toks.length; i++) {
		let hit = true;
		for (let j = 0; j < seq.length; j++) {
			if (toks[i + j] !== seq[j]) {
				hit = false;
				break;
			}
		}
		if (hit) return true;
	}
	return false;
}

/** Media capabilities implied by a model id alone. [] when the name is not a known media model. */
export function capabilitiesFromName(id: string): string[] {
	const toks = tokens(id);
	const caps = new Set<string>();
	for (const p of NAME_PATTERNS) if (hasSeq(toks, p.seq)) caps.add(p.cap);
	return [...caps];
}

/**
 * Classify one `/v1/models` entry. Returns null when the entry has no usable
 * id. A string-array `capabilities` field wins; otherwise the name decides.
 */
export function classifyModel(entry: unknown, baseUrl: string): ProbedModel | null {
	if (!entry || typeof entry !== "object") return null;
	const e = entry as Record<string, unknown>;
	const id = e.id;
	if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) return null;
	const state = typeof e.state === "string" ? e.state : undefined;
	if (Array.isArray(e.capabilities)) {
		const capabilities = e.capabilities
			.slice(0, MAX_CAPABILITIES)
			.filter((c): c is string => typeof c === "string" && c.length <= MAX_CAPABILITY_LENGTH)
			.map((c) => c.toLowerCase());
		return { id, baseUrl, capabilities, source: "declared", state };
	}
	return { id, baseUrl, capabilities: capabilitiesFromName(id), source: "name", state };
}

export interface ProbeOptions {
	/** Server roots to ask. Default: configuredLocalEndpoints(env). */
	endpoints?: string[];
	env?: Env;
	timeoutMs?: number;
	fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

async function probeOne(
	baseUrl: string,
	timeoutMs: number,
	fetchImpl: NonNullable<ProbeOptions["fetchImpl"]>,
): Promise<{ report: EndpointReport; models: ProbedModel[] }> {
	if (!isLoopbackUrl(baseUrl)) {
		return {
			report: { baseUrl, ok: false, error: "refused: not a loopback host", modelCount: 0 },
			models: [],
		};
	}
	let res: Response;
	try {
		res = await fetchImpl(`${baseUrl}/v1/models`, {
			method: "GET",
			redirect: "manual",
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		const name = (err as Error)?.name;
		const error = name === "TimeoutError" || name === "AbortError" ? "timed out" : "unreachable";
		return { report: { baseUrl, ok: false, error, modelCount: 0 }, models: [] };
	}
	if (!res.ok) {
		return {
			report: { baseUrl, ok: false, error: `HTTP ${res.status}`, modelCount: 0 },
			models: [],
		};
	}
	let bytes: Uint8Array;
	try {
		bytes = await readCapped(res, MAX_MODELS_BODY_BYTES);
	} catch (err) {
		const error = err instanceof BodyTooLargeError ? "body too large" : "body read failed";
		return { report: { baseUrl, ok: false, error, modelCount: 0 }, models: [] };
	}
	let body: unknown;
	try {
		body = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return { report: { baseUrl, ok: false, error: "body is not JSON", modelCount: 0 }, models: [] };
	}
	const data = (body as { data?: unknown } | null)?.data;
	if (!Array.isArray(data)) {
		return { report: { baseUrl, ok: false, error: "no data list", modelCount: 0 }, models: [] };
	}
	const models: ProbedModel[] = [];
	for (const entry of data.slice(0, MAX_MODELS_PER_ENDPOINT)) {
		const m = classifyModel(entry, baseUrl);
		if (m) models.push(m);
	}
	return { report: { baseUrl, ok: true, modelCount: models.length }, models };
}

/** Ask every configured local server for its models, in parallel. Never throws. */
export async function probeLocalMediaCapabilities(
	opts: ProbeOptions = {},
): Promise<MediaProbeResult> {
	const endpoints = (opts.endpoints ?? configuredLocalEndpoints(opts.env ?? process.env)).map(
		serverRoot,
	);
	const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
	const fetchImpl = opts.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
	const results = await Promise.all(endpoints.map((b) => probeOne(b, timeoutMs, fetchImpl)));
	return { endpoints: results.map((r) => r.report), models: results.flatMap((r) => r.models) };
}

/**
 * Pick a local model for one media capability (image, music, 3d). Ready
 * models first, then unloaded ones (they load on first request), never one
 * mlx-serve marks "remote". Endpoint order breaks ties. When nothing fits, the
 * reason says so plainly; no id is invented. Chat is not picked here: name
 * matching never classes chat models, so "no local model can do chat" would
 * be false. Use orchestration/local-model-detect for chat.
 */
export function pickLocalModel(result: MediaProbeResult, capability: string): LocalPick {
	const cap = capability.toLowerCase();
	const answered = result.endpoints.filter((e) => e.ok).length;
	const asked = result.endpoints.length;
	if (!MEDIA_CAPABILITIES.includes(cap)) {
		return {
			ok: false,
			reason: `${cap} is not a media capability this probe picks for (image, music, 3d)`,
			answered,
			asked,
		};
	}
	const capable = result.models.filter((m) => m.capabilities.includes(cap) && m.state !== "remote");
	const ready = capable.find(
		(m) => m.state === undefined || m.state === "ready" || m.state === "loaded",
	);
	const pick = ready ?? capable[0];
	if (pick) return { ok: true, model: pick };
	return {
		ok: false,
		reason: `no local model can do ${cap} (${answered} of ${asked} local model servers answered)`,
		answered,
		asked,
	};
}
