/**
 * llama-server router mode (#4206): the calls behind /llama and /models.
 *
 * Router mode is llama-server started with no model (`--models-preset x.ini`,
 * `--models-dir`, or the cache). It lists every model it can serve on GET
 * /models with a `status` per model, loads one on POST /models/load, unloads on
 * POST /models/unload, and routes each chat request by its `model` field. GET
 * endpoints take `?model=<id>` in router mode. Only endpoints in the llama.cpp
 * tools/server README are used. Presets stay llama-server's own business: we
 * never parse or write the .ini.
 *
 * Every call carries a short timeout so a dead server never hangs the TUI.
 */

import { redactUrl } from "./select";
import { type LocalFetch, lateBoundFetch } from "./server";

export const LLAMA_STATUS_TIMEOUT_MS = 3_000;
/** POST /models/load returns at once; we poll GET /models until the model is up, failed, or this passes. */
export const LLAMA_LOAD_TIMEOUT_MS = 120_000;

export interface RouterModel {
	id: string;
	/** loaded | loading | unloaded | sleeping | downloading, or undefined outside router mode. */
	status?: string;
	/** The last load attempt failed (router `status.failed`). */
	failed?: boolean;
	/** Exit code of the failed model process, when the router reports one. */
	exitCode?: number;
}

export interface LlamaHealth {
	ok: boolean;
	/** HTTP status, or 0 when the server did not answer. */
	httpStatus: number;
	detail: string;
}

export interface LlamaRouterOptions {
	baseUrl: string;
	fetch?: LocalFetch;
	timeoutMs?: number;
	loadTimeoutMs?: number;
	/** Poll interval while waiting for a load (tests pass 0). */
	pollMs?: number;
}

/** The selected throughput and queue gauges from Prometheus /metrics. */
export const METRIC_KEYS = [
	"llamacpp:prompt_tokens_seconds",
	"llamacpp:predicted_tokens_seconds",
	"llamacpp:requests_processing",
	"llamacpp:requests_deferred",
	"llamacpp:n_tokens_max",
] as const;

/** Parse Prometheus text, keeping only METRIC_KEYS. Labelled series and comments are skipped. */
export function parsePrometheus(text: string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const line of text.split(/\r?\n/)) {
		const m = /^([a-zA-Z_:][\w:]*)\s+(\S+)/.exec(line.trim());
		if (!m || !(METRIC_KEYS as readonly string[]).includes(m[1])) continue;
		const v = Number(m[2]);
		if (Number.isFinite(v)) out[m[1]] = v;
	}
	return out;
}

/** Longest model id we accept from the server, and most models we list. */
export const MAX_MODEL_ID_CHARS = 256;
export const MAX_MODELS = 1_000;
const MAX_SERVER_TEXT_CHARS = 300;

/**
 * Server text made safe for a terminal line. Allowlist (as layout-compare cleanSelector):
 * printable ASCII, Unicode letters and digits survive; controls, escape sequences, line
 * breaks, bidi, zero-width and tag characters become a space. Cut to `max` code points.
 */
export function cleanServerText(s: string, max = MAX_SERVER_TEXT_CHARS): string {
	const flat = s
		.replace(/[^\x20-\x7e\p{L}\p{N}]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	const points = Array.from(flat);
	return points.length > max ? `${points.slice(0, max).join("")}...` : flat;
}

/** A model id is used verbatim in requests, so one that would need cleaning is dropped, not rewritten. */
export function isSafeModelId(id: string): boolean {
	return (
		id.length > 0 &&
		Array.from(id).length <= MAX_MODEL_ID_CHARS &&
		!/\s/.test(id) &&
		!/[^\x21-\x7e\p{L}\p{N}]/u.test(id)
	);
}

function errorText(body: unknown, fallback: string): string {
	const e = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
	if (typeof e === "string" && e) return cleanServerText(e) || fallback;
	const msg = e && typeof e === "object" ? (e as { message?: unknown }).message : undefined;
	return typeof msg === "string" && msg ? cleanServerText(msg) || fallback : fallback;
}

function why(err: unknown): string {
	const name = (err as { name?: string })?.name;
	if (name === "TimeoutError" || name === "AbortError") return "timed out";
	return cleanServerText(err instanceof Error ? err.message : String(err));
}

export function createLlamaRouter(opts: LlamaRouterOptions) {
	const base = opts.baseUrl.replace(/\/+$/, "");
	// Lines shown on screen never carry user:password from LLAMA_SERVER_URL.
	const shown = redactUrl(base);
	const fetchImpl = opts.fetch ?? lateBoundFetch;
	const timeoutMs = opts.timeoutMs ?? LLAMA_STATUS_TIMEOUT_MS;
	const loadTimeoutMs = opts.loadTimeoutMs ?? LLAMA_LOAD_TIMEOUT_MS;
	const pollMs = opts.pollMs ?? 500;
	// Router GETs name the model; autoload=false so asking about a model never loads it.
	const q = (model?: string) => (model ? `?model=${encodeURIComponent(model)}&autoload=false` : "");

	const get = (path: string, ms = timeoutMs) =>
		fetchImpl(`${base}${path}`, { signal: AbortSignal.timeout(ms) });
	const post = (path: string, body: unknown, ms: number) =>
		fetchImpl(`${base}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(ms),
		});

	async function health(): Promise<LlamaHealth> {
		try {
			const res = await get("/health");
			const body = await res.json().catch(() => null);
			return {
				ok: res.ok,
				httpStatus: res.status,
				detail: res.ok ? "ok" : errorText(body, `HTTP ${res.status}`),
			};
		} catch (err) {
			return { ok: false, httpStatus: 0, detail: `not reachable at ${shown} (${why(err)})` };
		}
	}

	/** Router GET /models (with status); a single-model server without it falls back to /v1/models. */
	async function models(): Promise<RouterModel[]> {
		let res = await get("/models");
		if (!res.ok) res = await get("/v1/models");
		if (!res.ok) throw new Error(`${shown} answered HTTP ${res.status} for the model list`);
		const data = ((await res.json()) as { data?: unknown })?.data;
		if (!Array.isArray(data)) return [];
		// Ids reach the screen and request URLs: control or invisible characters, or an
		// over-long id, drop the entry; the list itself is capped.
		return data.slice(0, MAX_MODELS).flatMap((m): RouterModel[] => {
			const id = (m as { id?: unknown })?.id;
			if (typeof id !== "string" || !isSafeModelId(id)) return [];
			const s = (m as { status?: { value?: unknown; failed?: unknown; exit_code?: unknown } })
				.status;
			return [
				{
					id,
					// Unknown states stay set (cleaned) so load() keeps waiting rather than calling them loaded.
					status:
						typeof s?.value === "string" ? cleanServerText(s.value, 32) || "unknown" : undefined,
					failed: s?.failed === true ? true : undefined,
					exitCode: typeof s?.exit_code === "number" ? s.exit_code : undefined,
				},
			];
		});
	}

	/** Prometheus gauges, or the reason they are missing (server started without --metrics). */
	async function metrics(model?: string): Promise<Record<string, number> | string> {
		try {
			const res = await get(`/metrics${q(model)}`);
			if (!res.ok)
				return res.status === 501 || res.status === 404
					? "off (start llama-server with --metrics)"
					: `HTTP ${res.status}`;
			return parsePrometheus(await res.text());
		} catch (err) {
			return why(err);
		}
	}

	/** Context size and sleep state from GET /props, the only memory facts the server documents. */
	async function props(model?: string): Promise<{ nCtx?: number; sleeping?: boolean } | string> {
		try {
			const res = await get(`/props${q(model)}`);
			if (!res.ok) return `HTTP ${res.status}`;
			const b = (await res.json()) as {
				default_generation_settings?: { n_ctx?: unknown };
				is_sleeping?: unknown;
			};
			const nCtx = b?.default_generation_settings?.n_ctx;
			return {
				nCtx: typeof nCtx === "number" ? nCtx : undefined,
				sleeping: typeof b?.is_sleeping === "boolean" ? b.is_sleeping : undefined,
			};
		} catch (err) {
			return why(err);
		}
	}

	async function change(
		action: "load" | "unload",
		model: string,
	): Promise<{ ok: boolean; detail: string }> {
		try {
			const res = await post(`/models/${action}`, { model }, timeoutMs);
			const body = await res.json().catch(() => null);
			if (!res.ok) return { ok: false, detail: errorText(body, `HTTP ${res.status}`) };
			if (body && (body as { success?: unknown }).success === false)
				return { ok: false, detail: errorText(body, "server said no") };
			return { ok: true, detail: "ok" };
		} catch (err) {
			return { ok: false, detail: why(err) };
		}
	}

	/**
	 * Ask the router to load `model`, then poll GET /models until it reports loaded (or
	 * sleeping, which reloads on the next request), the load fails, or loadTimeoutMs passes.
	 * The POST alone answers success before the model process has started (seen on b11146).
	 */
	async function load(model: string): Promise<{ ok: boolean; detail: string }> {
		const started = await change("load", model);
		if (!started.ok) return started;
		const deadline = Date.now() + loadTimeoutMs;
		let progressed = false;
		for (let polls = 1; Date.now() < deadline; polls++) {
			await new Promise((r) => setTimeout(r, pollMs));
			let m: RouterModel | undefined;
			try {
				m = (await models()).find((x) => x.id === model);
			} catch (err) {
				return { ok: false, detail: why(err) };
			}
			if (!m) return { ok: false, detail: "the server no longer lists it" };
			if (m.status === undefined || m.status === "loaded" || m.status === "sleeping")
				return { ok: true, detail: "ok" };
			if (m.status === "loading" || m.status === "downloading") progressed = true;
			// A stale "failed" from an earlier attempt can show before "loading": trust it only after progress.
			else if (m.status === "unloaded" && (progressed || polls >= 3))
				return {
					ok: false,
					detail: m.failed
						? `the model process exited${m.exitCode === undefined ? "" : ` with code ${m.exitCode}`}; the llama-server window has the reason`
						: "it did not load",
				};
		}
		return { ok: false, detail: `still loading after ${Math.round(loadTimeoutMs / 1000)} s` };
	}

	return {
		baseUrl: shown,
		health,
		models,
		metrics,
		props,
		load,
		unload: (model: string) => change("unload", model),
	};
}

export type LlamaRouter = ReturnType<typeof createLlamaRouter>;

/** Router mode shows itself: more than one model, or any model carrying a router `status`. */
export function isRouterMode(list: readonly object[]): boolean {
	return list.length > 1 || list.some((m) => (m as { status?: unknown }).status !== undefined);
}
