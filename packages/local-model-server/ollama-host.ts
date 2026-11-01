/**
 * The one Ollama host resolver (#3149). There used to be two that disagreed:
 * packages/ai's gave a bare OLLAMA_HOST such as "gpu-box" Ollama's default
 * port, and System One's (packages/decide) did not, so the same env reached
 * gpu-box:11434 for chat and gpu-box:80 for System One. Both now call this.
 */

/** Ollama's default server root, used when no env var names another. */
export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

/**
 * Normalise an Ollama host value to a server root ("http://h:port", no path):
 *   - "127.0.0.1:21434"            -> "http://127.0.0.1:21434"
 *   - "gpu-box" (no scheme, no port) -> "http://gpu-box:11434" (Ollama's own rule)
 *   - "http://h:11434/v1/"         -> "http://h:11434" (an OpenAI-style base)
 * Returns null for an empty value. Pure.
 */
export function normaliseOllamaHost(raw: string | undefined): string | null {
	let v = (raw ?? "").trim().replace(/\/+$/, "");
	if (!v) return null;
	if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) {
		// A bare host with no port gets Ollama's default port, as the ollama CLI does.
		v = /:\d+(\/|$)/.test(v) ? `http://${v}` : `http://${v.replace(/\/.*$/, "")}:11434`;
	}
	return v.replace(/\/v1$/, "").replace(/\/+$/, "");
}

/**
 * The Ollama server root for this process: OLLAMA_BASE_URL, then OLLAMA_HOST,
 * then localhost:11434 (#3076). Injectable env so tests stay pure.
 */
export function resolveOllamaBaseUrl(env: Record<string, string | undefined> = process.env): string {
	return normaliseOllamaHost(env.OLLAMA_BASE_URL) ?? normaliseOllamaHost(env.OLLAMA_HOST) ?? DEFAULT_OLLAMA_BASE_URL;
}
