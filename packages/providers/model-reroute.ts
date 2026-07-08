/**
 * 8gent Code - Local Model Auto-Reroute
 *
 * A local (Ollama / LM Studio) turn must never surface a raw provider
 * "model not found" error to the user. The daemon can be pointed at a model
 * that is not installed (a stale `~/.8gent/config.json` / `roles.json`, or a
 * failover chain whose entries were never pulled). Historically that produced,
 * verbatim on the iOS app, `ollama chat completions 404: model 'qwen3.6:27b'
 * not found`.
 *
 * This module makes that path resilient: when a request fails because the model
 * is not available, it queries the models that ARE installed, picks the best
 * one, and retries the turn with it. Only when there is genuinely no usable
 * model anywhere (nothing installed locally AND no cloud key configured) does it
 * return a clean, human message - never a raw provider 404.
 *
 * Provider-agnostic: it keys off the error shape, not the provider, and reuses
 * the installed-model probe in `orchestration/local-model-detect` (loaded lazily
 * to keep the providers -> orchestration import graph acyclic).
 */

/** Minimal shape of a detected, installed local model (mirrors DetectedModel). */
export interface InstalledModel {
	provider: string;
	model: string;
	/** Heuristic capability score; higher = stronger. Embeddings score 0. */
	score: number;
}

/** Cloud providers whose presence means "a model is still reachable". */
const CLOUD_KEY_ENV_VARS = [
	"OPENROUTER_API_KEY",
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"GROQ_API_KEY",
	"XAI_API_KEY",
	"MISTRAL_API_KEY",
	"TOGETHER_API_KEY",
	"FIREWORKS_API_KEY",
	"REPLICATE_API_TOKEN",
	"DEEPSEEK_API_KEY",
] as const;

/** True when at least one cloud provider key is configured in the environment. */
export function hasCloudModelKey(): boolean {
	return CLOUD_KEY_ENV_VARS.some((k) => (process.env[k]?.trim().length ?? 0) > 0);
}

/**
 * Detect whether an error means the requested model is not available on the
 * local provider (as opposed to the server being down, a timeout, or an abort).
 *
 * Matches the two ways this shows up:
 *   - Ollama/LM Studio HTTP layer: `... chat completions 404: ... not found`
 *     (the exact string `text-tool-endpoint.ts` throws), any `404` + "model",
 *   - Ollama native `/api/chat`: body text `model '<id>' not found` /
 *     `model "<id>" not found` / `try pulling it first`.
 *
 * Deliberately does NOT match reachability failures (ECONNREFUSED, fetch failed,
 * timeouts) - those keep the existing "is Ollama running?" handling.
 */
export function isModelNotFoundError(err: unknown): boolean {
	const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
	if (!msg) return false;
	// Reachability failures are not model-not-found - let them fall through.
	if (/econnrefused|enotfound|eai_again|fetch failed|unable to connect|connection refused/.test(msg)) {
		return false;
	}
	if (/model .*not found/.test(msg)) return true;
	if (/try pulling it first|pull the model|no such model/.test(msg)) return true;
	// A 404 from a chat-completions call is, in practice, a missing model.
	if (msg.includes("404") && (msg.includes("model") || msg.includes("chat completions"))) {
		return true;
	}
	return false;
}

/**
 * Detect whether an error means the local provider itself is UNHEALTHY - the
 * model is nominally "there" but the backend can't answer - so the turn should
 * reroute to the best OTHER installed model rather than surface a dead brain.
 *
 * The load-bearing case: Apple Foundation is auto-selected on this host (the
 * bridge binary is installed), but Apple Intelligence is toggled OFF in System
 * Settings, so every call returns `"Apple Intelligence is not enabled"` (an
 * error body, not a 404). That is not "model not found", so without this the
 * agent kept the dead provider and stalled. We keep Apple Foundation ON (it is
 * the best pick where Apple Intelligence IS enabled); we just fail OFF it here.
 *
 * Reachability failures (ECONNREFUSED, timeouts) stay the caller's to handle -
 * those are "is the server up?", not "this provider can't answer right now".
 */
export function isProviderUnhealthyError(err: unknown): boolean {
	const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
	if (!msg) return false;
	if (/econnrefused|enotfound|eai_again|fetch failed|connection refused/.test(msg)) {
		return false;
	}
	return (
		/apple intelligence is not enabled/.test(msg) ||
		/apple intelligence.*(disabled|unavailable|not available)/.test(msg) ||
		/foundation model.*(unavailable|not available|disabled)/.test(msg) ||
		/model is not ready|assets? (are )?not (yet )?(available|downloaded)/.test(msg) ||
		// Apple Intelligence just enabled but the model is still downloading/warming:
		// the bridge returns "The model is not available. Try again later." Treat it
		// as a health failure so we fail over while it finishes, then use it once ready.
		/model (is )?not available|model unavailable|try again later/.test(msg)
	);
}

/**
 * Probe the locally-installed models across every local host (Ollama + LM
 * Studio + Apple Foundation). Loaded lazily so `packages/providers` never takes
 * a static dependency on `packages/orchestration` (which imports providers).
 */
async function defaultDetectInstalled(): Promise<InstalledModel[]> {
	const { detectLocalModels } = await import("../orchestration/local-model-detect");
	return detectLocalModels();
}

/**
 * Choose the best installed model to reroute to.
 *
 * Preference order:
 *   1. A model in `prefer` (e.g. the configured failover chain) that is
 *      actually installed - honour the operator's intended ordering first.
 *   2. Otherwise the highest-scoring installed model.
 * The missing model is always excluded so we never reroute to the thing that
 * just failed. Returns null when nothing usable is installed.
 */
export function chooseRerouteModel(
	installed: InstalledModel[],
	missingModel: string,
	prefer: string[] = [],
): InstalledModel | null {
	const missing = missingModel.trim().toLowerCase();
	const usable = installed.filter((m) => m.score > 0 && m.model.trim().toLowerCase() !== missing);
	if (usable.length === 0) return null;

	for (const name of prefer) {
		const wanted = name.trim().toLowerCase();
		const hit = usable.find((m) => m.model.trim().toLowerCase() === wanted);
		if (hit) return hit;
	}

	return [...usable].sort((a, b) => b.score - a.score)[0] ?? null;
}

/** Human-facing, provider-neutral message for the genuine no-model case. */
export function noModelAvailableMessage(missingModel: string, hasCloudKey: boolean): string {
	const head = `No model is available to answer this. The configured model "${missingModel}" is not installed`;
	if (hasCloudKey) {
		return `${head}, and no other local model is installed. Pull one with \`ollama pull <model>\`, or switch to a configured cloud model.`;
	}
	return `${head}. Pull one with \`ollama pull <model>\` (for example \`ollama pull llama3.2\`), or add a cloud provider key.`;
}

/** Outcome of a rerouted local call. */
export type LocalRerouteOutcome<T> =
	| { ok: true; value: T; usedProvider: string; usedModel: string; rerouted: boolean }
	| { ok: false; message: string };

/**
 * Run a local model turn with automatic reroute on "model not found".
 *
 * `run(provider, model)` performs one turn and REJECTS on failure. This wrapper:
 *   1. Runs it with the configured provider/model.
 *   2. If that rejects with a not-found error, probes the installed models,
 *      picks the best one, LOGS the reroute (via `onReroute`), and retries once.
 *   3. If nothing is installed, resolves to a clean human message (never the
 *      raw 404).
 *   4. Any other error (reachability, timeout, abort) is rethrown unchanged so
 *      the caller's existing handling still applies.
 *
 * `detect` and `hasCloudKey` are injectable purely so tests can drive the two
 * branches without a live Ollama.
 */
export async function callLocalModelWithReroute<T>(opts: {
	provider: string;
	model: string;
	run: (provider: string, model: string) => Promise<T>;
	prefer?: string[];
	detect?: () => Promise<InstalledModel[]>;
	hasCloudKey?: () => boolean;
	onReroute?: (missingModel: string, chosen: InstalledModel) => void;
}): Promise<LocalRerouteOutcome<T>> {
	const detect = opts.detect ?? defaultDetectInstalled;
	const cloudKey = opts.hasCloudKey ?? hasCloudModelKey;

	let provider = opts.provider;
	let model = opts.model;
	let rerouted = false;

	// At most two attempts: the original, then one reroute to an installed model.
	for (;;) {
		try {
			const value = await opts.run(provider, model);
			return { ok: true, value, usedProvider: provider, usedModel: model, rerouted };
		} catch (err) {
			// A not-found error OR an unhealthy local provider (e.g. Apple
			// Foundation when Apple Intelligence is off) triggers ONE reroute to
			// the best other installed model. Reachability failures, timeouts and
			// aborts stay the caller's to handle.
			if (rerouted || !(isModelNotFoundError(err) || isProviderUnhealthyError(err))) {
				throw err;
			}

			const installed = await detect().catch(() => [] as InstalledModel[]);
			const chosen = chooseRerouteModel(installed, model, opts.prefer);
			if (!chosen) {
				return { ok: false, message: noModelAvailableMessage(model, cloudKey()) };
			}

			opts.onReroute?.(model, chosen);
			provider = chosen.provider;
			model = chosen.model;
			rerouted = true;
			// Loop retries once with the rerouted provider/model.
		}
	}
}
