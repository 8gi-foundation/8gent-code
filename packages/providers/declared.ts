/**
 * 8gent Code - user-declared providers
 *
 * A provider named in `~/.8gent/providers.json` that the compiled registry has
 * never heard of is a DECLARATION, not a typo. It needs a `baseUrl` and
 * nothing else; every other field falls back to a conservative default. This
 * is what lets a user point 8gent-code at a local endpoint we did not
 * anticipate - a llama.cpp build, a vLLM box, a second Ollama on another
 * machine - without editing compiled TypeScript.
 *
 * `compat` picks the wire shape the router speaks to that endpoint:
 *
 *   "openai"    POST {baseUrl}/chat/completions   GET {baseUrl}/models
 *   "ollama"    POST {baseUrl}/api/chat           GET {baseUrl}/api/tags
 *   "anthropic" POST {baseUrl}/messages           GET {baseUrl}/models
 *
 * A declaration never shadows a built-in. An entry whose name IS compiled in
 * stays what it always was: a partial override of that built-in's config.
 */

import { THINKING_LEVELS_ORDERED } from "../types/index.js";
import type { ProviderConfig } from "./index";

/** Wire shape a provider's endpoint speaks. */
export type ProviderCompat = "openai" | "ollama" | "anthropic";

const COMPAT_VALUES: readonly string[] = ["openai", "ollama", "anthropic"];

/**
 * Turn one raw `providers.json` entry into a full `ProviderConfig`, or null if
 * it is not a usable declaration. `baseUrl` is the whole point of a
 * declaration - without a reachable endpoint there is nothing to route to, and
 * registering it would only punch a hole in the `setActiveProvider` guard.
 */
export function normalizeDeclaredProvider(
	name: string,
	raw: Partial<ProviderConfig>,
): ProviderConfig | null {
	if (!name.trim()) return null;
	const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "";
	if (!baseUrl) return null;
	try {
		// http(s) only. A declared base URL becomes a fetch target, and `new URL`
		// alone would happily accept file: or data:.
		const protocol = new URL(baseUrl).protocol;
		if (protocol !== "http:" && protocol !== "https:") return null;
	} catch {
		return null;
	}

	const compat = (
		COMPAT_VALUES.includes(raw.compat as string) ? raw.compat : "openai"
	) as ProviderCompat;
	const models = Array.isArray(raw.models) ? raw.models.filter((m) => typeof m === "string") : [];

	return {
		name,
		displayName: typeof raw.displayName === "string" && raw.displayName ? raw.displayName : name,
		baseUrl,
		// Declared endpoints are keyless by default - the common case is a local
		// server with no auth. An empty apiKeyEnv is the DECLARATION that no key
		// exists, which is what the OpenAI-compatible auth gate reads.
		apiKeyEnv: typeof raw.apiKeyEnv === "string" ? raw.apiKeyEnv : "",
		apiKey: typeof raw.apiKey === "string" ? raw.apiKey : undefined,
		// May be empty: `discoverModels()` fills it from the endpoint itself.
		defaultModel: typeof raw.defaultModel === "string" ? raw.defaultModel : (models[0] ?? ""),
		models,
		// Writing the declaration IS the opt-in. An explicit false still disables.
		enabled: raw.enabled !== false,
		supportsTools: raw.supportsTools !== false,
		supportsStreaming: raw.supportsStreaming !== false,
		// Vision is opt-in: assuming it and being wrong produces a 400 on the
		// first image, which reads as a broken provider rather than a missing
		// capability.
		supportsVision: raw.supportsVision === true,
		// Filtered against the known levels: this comes from a hand-edited JSON
		// file, and an unrecognised level would be forwarded to the endpoint as a
		// `reasoning_effort` it cannot parse.
		supportedThinkingLevels: Array.isArray(raw.supportedThinkingLevels)
			? raw.supportedThinkingLevels.filter((level) => THINKING_LEVELS_ORDERED.includes(level))
			: [],
		compat,
		declared: true,
	};
}

/**
 * Collect every usable declaration out of a `providers.json` `providers` map.
 * `builtinNames` is passed in rather than imported so this module stays free of
 * a cycle back to the registry.
 */
export function parseDeclaredProviders(
	raw: Record<string, Partial<ProviderConfig>> | undefined,
	builtinNames: ReadonlySet<string>,
	warn: (message: string) => void = (m) => console.warn(m),
): Record<string, ProviderConfig> {
	const declared: Record<string, ProviderConfig> = {};
	if (!raw || typeof raw !== "object") return declared;
	for (const [name, entry] of Object.entries(raw)) {
		if (builtinNames.has(name)) continue; // an override of a built-in, not a declaration
		if (!entry || typeof entry !== "object") continue;
		const config = normalizeDeclaredProvider(name, entry);
		if (config) {
			declared[name] = config;
			continue;
		}
		// Say so. A typo'd `baseurl` key used to make the whole declaration
		// vanish in silence, and the user's next symptom was "Unknown provider"
		// for something they can see in their own file.
		warn(
			`providers.json: ignoring "${name}" - a declared provider needs a valid ` +
				`http(s) "baseUrl". Got: ${JSON.stringify(entry.baseUrl ?? null)}`,
		);
	}
	return declared;
}

/** Endpoint that lists servable models for a given wire shape. */
export function modelsUrlFor(baseUrl: string, compat: ProviderCompat): string {
	const base = baseUrl.replace(/\/+$/, "");
	return compat === "ollama" ? `${base}/api/tags` : `${base}/models`;
}

/** How long to wait on a declared endpoint before giving up on discovery. */
export const DISCOVERY_TIMEOUT_MS = 5000;

/** Longest error body echoed back into a thrown message. */
const MAX_ERROR_BODY = 500;

/**
 * Ask an endpoint what it can serve. OpenAI-compatible and Anthropic both
 * answer `{ data: [{ id }] }`; Ollama answers `{ models: [{ name }] }`. Throws
 * on a non-2xx so a misconfigured base URL surfaces as itself rather than as an
 * empty model picker.
 *
 * Always bounded by a timeout. This feature exists to let users point at a box
 * on their LAN, and a sleeping laptop or a stale IP black-holes the connection
 * rather than refusing it - Bun's fetch has no default timeout, so without this
 * the caller waits forever.
 */
export async function discoverModelsAt(
	baseUrl: string,
	compat: ProviderCompat = "openai",
	apiKey?: string,
	timeoutMs: number = DISCOVERY_TIMEOUT_MS,
): Promise<string[]> {
	const url = modelsUrlFor(baseUrl, compat);
	// Anthropic authenticates with x-api-key, not a bearer token. Sending the
	// wrong one is a 401 that reads as "endpoint down" rather than "wrong auth".
	const headers: Record<string, string> = !apiKey
		? {}
		: compat === "anthropic"
			? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
			: { Authorization: `Bearer ${apiKey}` };

	let response: Response;
	try {
		response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
	} catch (err) {
		if ((err as { name?: string })?.name === "TimeoutError") {
			throw new Error(`Model discovery timed out after ${timeoutMs}ms for ${url}`);
		}
		throw err;
	}

	if (!response.ok) {
		// Capped: this endpoint is user-supplied and can return an arbitrarily
		// large body, which ends up in an error message that gets logged.
		const body = (await response.text()).slice(0, MAX_ERROR_BODY);
		throw new Error(`Model discovery failed for ${url}: ${response.status} ${body}`);
	}
	const data = (await response.json()) as {
		data?: { id?: string }[];
		models?: { name?: string; model?: string }[];
	};
	const ids = [
		...(data.data ?? []).map((m) => m.id),
		...(data.models ?? []).map((m) => m.name ?? m.model),
	];
	return ids.filter((id): id is string => typeof id === "string" && id.length > 0);
}
