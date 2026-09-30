/**
 * Provider health probe for the status bar `X/Y agents` indicator.
 *
 * Polls each configured local inference provider and returns counts:
 *   live    — number currently responding
 *   total   — number configured (each provider only counts once)
 *
 * Order is intentional and deterministic so the status bar updates feel
 * stable: Apple Foundation -> LM Studio -> Ollama. Cloud providers are
 * NOT included here; this slot reports local-first availability so the
 * user can see at a glance which engines are warmed up.
 */

import { resolveOllamaBaseUrl } from "../../../../packages/ai/text-tool-endpoint.js";

export interface ProviderStatus {
	name: "apfel" | "lmstudio" | "ollama";
	live: boolean;
}

const HTTP_TIMEOUT_MS = 1500;

async function probeUrl(url: string): Promise<boolean> {
	try {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
		try {
			const res = await fetch(url, { signal: ctrl.signal });
			return res.ok;
		} finally {
			clearTimeout(t);
		}
	} catch {
		return false;
	}
}

/**
 * Probe each local inference provider over HTTP and report `live/total`.
 * apfel (Apple Foundation), LM Studio, Ollama are the three local engines
 * the TUI surfaces in its `X/Y agents` slot.
 *
 * WHAT THIS INDICATOR MEANS, precisely: it is a REACHABILITY check, not a
 * liveness check, and the two are not the same fact. Measured 2026-08-28 -
 * apfel served `/v1/models` with a 200 while every completion returned HTTP
 * 500 "Apple Intelligence is not enabled", and Ollama answered `/api/tags` in
 * 3ms while every completion on it timed out behind a runner wedged in
 * "Stopping...". Both would show a green light here.
 *
 * That is fine for a status glyph and NOT fine for routing, so routing must
 * not read this. This stays cheap on purpose: it runs on an 8s poll, and
 * firing real inference at three providers every 8 seconds would pin models
 * in memory to light up one character in the status bar.
 */
export async function probeProviders(): Promise<{
	live: number;
	total: number;
	statuses: ProviderStatus[];
}> {
	// 11435, not 11500. The bridge listens on 11435 (verified live 2026-08-28,
	// pid 1012); nothing has ever listened on 11500, so this indicator has been
	// reporting apfel dead while apfel was up. Do NOT "fix" it to 11434 - that
	// is Ollama's port, and Ollama answers instead of refusing, so apfel would
	// silently show the health of a different engine. Same trap, worse failure.
	// packages/providers/index.ts is the source of truth and is test-pinned.
	const apfelHost =
		(process.env.APFEL_BASE_URL && process.env.APFEL_BASE_URL.replace(/\/v1$/, "")) ||
		"http://127.0.0.1:11435";
	const apfelLive = await probeUrl(`${apfelHost}/health`).catch(() => false);
	// Some apfel builds only expose /v1/models, not /health.
	const apfelOk = apfelLive || (await probeUrl(`${apfelHost}/v1/models`));

	const lmStudioHost = process.env.LM_STUDIO_HOST || "http://localhost:1234";
	const lmStudioLive = await probeUrl(`${lmStudioHost}/v1/models`);

	// The configured Ollama, resolved like everywhere else (OLLAMA_BASE_URL,
	// then OLLAMA_HOST, normalised). A bare host:port OLLAMA_HOST, which the
	// ollama CLI accepts, used to be an invalid URL here and read as down.
	const ollamaHost = resolveOllamaBaseUrl();
	const ollamaLive = await probeUrl(`${ollamaHost}/api/tags`);

	const statuses: ProviderStatus[] = [
		{ name: "apfel", live: apfelOk },
		{ name: "lmstudio", live: lmStudioLive },
		{ name: "ollama", live: ollamaLive },
	];

	const live = statuses.filter((s) => s.live).length;
	return { live, total: statuses.length, statuses };
}
