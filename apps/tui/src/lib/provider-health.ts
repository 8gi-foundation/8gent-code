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

import { existsSync } from "node:fs";
import { homedir, platform, arch, release } from "node:os";
import { join } from "node:path";

export interface ProviderStatus {
	name: "apple-foundation" | "lmstudio" | "ollama";
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

function appleFoundationConfigured(): boolean {
	if (platform() !== "darwin") return false;
	if (arch() !== "arm64") return false;
	const major = Number.parseInt(release().split(".")[0] ?? "0", 10);
	if (Number.isFinite(major) && major < 25) return false;
	return existsSync(join(homedir(), ".8gent", "bin", "apple-foundation-bridge"));
}

/**
 * Probe each provider that's configured on this host. Apple Foundation only
 * counts toward `total` when the host qualifies (Tahoe + arm64 + bridge bin).
 */
export async function probeProviders(): Promise<{
	live: number;
	total: number;
	statuses: ProviderStatus[];
}> {
	const statuses: ProviderStatus[] = [];

	if (appleFoundationConfigured()) {
		// The bridge is a local binary; if the file is there we count it as live.
		// A heartbeat probe could be added later if the bridge exposes one.
		statuses.push({ name: "apple-foundation", live: true });
	}

	const lmStudioHost = process.env.LM_STUDIO_HOST || "http://localhost:1234";
	const lmStudioLive = await probeUrl(`${lmStudioHost}/v1/models`);
	statuses.push({ name: "lmstudio", live: lmStudioLive });

	const ollamaHost = process.env.OLLAMA_HOST || "http://localhost:11434";
	const ollamaLive = await probeUrl(`${ollamaHost}/api/tags`);
	statuses.push({ name: "ollama", live: ollamaLive });

	const live = statuses.filter((s) => s.live).length;
	return { live, total: statuses.length, statuses };
}
