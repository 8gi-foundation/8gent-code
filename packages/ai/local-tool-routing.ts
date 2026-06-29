/**
 * Local-model tool routing integrity.
 *
 * Two concerns, both proven by dogfooding the lmstudio path with real models:
 *
 *  1. modelSupportsNativeTools() - a PER-MODEL capability probe. The coarse
 *     "lmstudio/ollama are tool-incapable" assumption is wrong: gemma's GGUF
 *     template 400s on a native `tools` payload, but ornith-1.0-9b accepts it
 *     and returns a clean tool_call. Keying the text-tools gate on the provider
 *     name forced ornith into the text protocol, where its native-style output
 *     did not parse and writes silently failed. We probe the actual served
 *     model once (cached) so capable models use the native AI SDK loop and
 *     genuinely incapable templates fall back to text-tools.
 *
 *  2. buildWriteHonestyNote() - a post-turn guard for the text-tool path. Local
 *     models routinely claim "saved to launch-report.html" while the write tool
 *     either failed or never ran, leaving nothing on disk. The harness knows the
 *     ground truth (tool success + whether any write ran), so it appends a
 *     factual correction instead of letting the model's prose lie.
 */

import { resolveTextToolEndpoint } from "./text-tool-endpoint";

// ── 1. Per-model native-tool capability probe ────────────────────────────────

// Cache keyed by `${provider}:${model}` so we probe a given served model at most
// once per process. A miss costs one tiny chat/completions round; a hit is free.
const nativeToolCache = new Map<string, boolean>();

export interface NativeToolProbeOpts {
	provider: string;
	model: string;
	/** Override the chat-completions endpoint (defaults to the provider's). */
	endpoint?: string;
	/** Probe timeout; on timeout we default to the safe answer (false). */
	timeoutMs?: number;
}

/**
 * Returns true iff the served model's chat template ACCEPTS a native `tools`
 * payload. That template-level acceptance is the real signal: gemma's GGUF
 * template throws ("Cannot call something that is not a function") and the
 * endpoint 4xxs / returns an error body, while ornith renders the payload and
 * replies normally. We deliberately do NOT require a tool_call in the probe
 * reply - a capable model may decline to call a throwaway health-check tool, and
 * requiring one produced false negatives that kept ornith on text-tools.
 *
 * Conservative by design: any error, timeout, non-2xx, or error body resolves to
 * FALSE, routing the model through the text-tool protocol (the prior behaviour),
 * so a false negative never regresses - it only forgoes the native upgrade.
 */
export async function modelSupportsNativeTools(opts: NativeToolProbeOpts): Promise<boolean> {
	const key = `${opts.provider}:${opts.model}`;
	const cached = nativeToolCache.get(key);
	if (cached !== undefined) return cached;

	const endpoint = opts.endpoint || resolveTextToolEndpoint(opts.provider);
	const timeoutMs = opts.timeoutMs ?? 6000;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	let supported = false;
	try {
		const res = await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: opts.model,
				messages: [
					{
						role: "user",
						content:
							"Acknowledge this health check by calling the report_ready tool with ok set to true.",
					},
				],
				tools: [
					{
						type: "function",
						function: {
							name: "report_ready",
							description: "Acknowledge readiness for a health probe.",
							parameters: {
								type: "object",
								properties: { ok: { type: "boolean" } },
								required: ["ok"],
							},
						},
					},
				],
				tool_choice: "auto",
				max_tokens: 64,
				temperature: 0,
				stream: false,
			}),
			signal: controller.signal,
		});

		if (res.ok) {
			const data = (await res.json().catch(() => null)) as {
				error?: unknown;
				choices?: unknown[];
			} | null;
			// Template accepted the tools payload: 2xx, no error body, a real
			// completion came back. Whether it chose to call the probe tool is
			// irrelevant to capability.
			supported = !!data && !data.error && Array.isArray(data.choices) && data.choices.length > 0;
		}
	} catch {
		// timeout / unreachable / parse failure -> safe default (text-tools)
		supported = false;
	} finally {
		clearTimeout(timer);
	}

	nativeToolCache.set(key, supported);
	return supported;
}

/** Test-only: reset the probe cache between cases. */
export function __resetNativeToolCache(): void {
	nativeToolCache.clear();
}

// ── 2. Post-turn write-honesty guard (text-tool path) ────────────────────────

export interface WriteOutcome {
	path: string;
	ok: boolean;
	reason?: string;
}

// A past-tense completion claim attached to a writable file extension. Present
// tense ("I will write...") and bare filenames are deliberately not matched, to
// keep the guard high-precision (no footer on honest replies).
const WRITE_CLAIM =
	/\b(saved|wrote|written|created|generated|produced|placed|output)\b[^.\n]*\.(html?|md|markdown|txt|tsx?|jsx?|css|json|ya?ml|toml|py|rs|go|java|sh|svg|vue|svelte)\b/i;

/**
 * Returns a factual correction to append to the assistant's reply when its claim
 * about writing a file disagrees with what actually happened, or "" when the
 * reply is consistent with disk reality.
 *
 *  - Case A: a write tool ran and FAILED -> name the path(s) that were not saved.
 *  - Case B: the reply claims a save but NO write succeeded this turn -> say so.
 */
export function buildWriteHonestyNote(finalText: string, writes: WriteOutcome[]): string {
	const succeeded = writes.filter((w) => w.ok);
	// A failed write to a path that ALSO succeeded later (e.g. the model retried
	// with a valid relative path after an absolute one was blocked) is not a
	// real loss, so it does not warrant a warning.
	const failed = writes.filter((w) => !w.ok && !succeeded.some((s) => s.path === w.path));

	if (failed.length > 0) {
		const lines = failed.map(
			(w) => `  - \`${w.path}\` was NOT written${w.reason ? ` (${w.reason})` : ""}`,
		);
		const which = failed.length > 1 ? "those paths" : "that path";
		return `\n\n⚠️ Verification: a file write did not complete, despite anything stated above:\n${lines.join(
			"\n",
		)}\nNothing was saved to ${which}.`;
	}

	if (succeeded.length === 0 && WRITE_CLAIM.test(finalText)) {
		return "\n\n⚠️ Verification: the reply claims a file was written, but no write tool ran this turn. Nothing was actually saved to disk.";
	}

	return "";
}
