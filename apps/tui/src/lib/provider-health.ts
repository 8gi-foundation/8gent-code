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
 */
export async function probeProviders(): Promise<{
	live: number;
	total: number;
	statuses: ProviderStatus[];
}> {
	const apfelHost =
		(process.env.APFEL_BASE_URL && process.env.APFEL_BASE_URL.replace(/\/v1$/, "")) ||
		"http://localhost:11500";
	const apfelLive = await probeUrl(`${apfelHost}/health`).catch(() => false);
	// Some apfel builds only expose /v1/models, not /health.
	const apfelOk = apfelLive || (await probeUrl(`${apfelHost}/v1/models`));

	const lmStudioHost = process.env.LM_STUDIO_HOST || "http://localhost:1234";
	const lmStudioLive = await probeUrl(`${lmStudioHost}/v1/models`);

	const ollamaHost = process.env.OLLAMA_HOST || "http://localhost:11434";
	const ollamaLive = await probeUrl(`${ollamaHost}/api/tags`);

	const statuses: ProviderStatus[] = [
		{ name: "apfel", live: apfelOk },
		{ name: "lmstudio", live: lmStudioLive },
		{ name: "ollama", live: ollamaLive },
	];

	const live = statuses.filter((s) => s.live).length;
	return { live, total: statuses.length, statuses };
}
