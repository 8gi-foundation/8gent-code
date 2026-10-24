/**
 * Ollama cloud models, kept off the default path.
 *
 * Ollama lists a model whose tag ends "-cloud" (or ":cloud") in /api/tags next
 * to the local ones, with a tiny size. Asking for it does not run it here: the
 * Ollama daemon forwards the prompt to ollama.com. The daemon allows that
 * unless it was started with OLLAMA_NO_CLOUD=1, and 8gent does not start the
 * daemon, so it cannot set that. What 8gent controls is which model it picks
 * and which it will talk to:
 *
 *   - automatic choices and listings drop cloud tags (dropOllamaCloud);
 *   - the Ollama client refuses one before anything is sent (assertOllamaLocal);
 *   - EIGHT_OLLAMA_CLOUD=1 is the single opt-in, and it is named for what it does.
 *
 * The local-first gate (scripts/local-first-gate.ts) fails the build when a new
 * reader of /api/tags appears that neither uses this file nor is on its reviewed
 * list.
 */

type Env = Record<string, string | undefined>;

/** True when the person chose to let prompts go to Ollama's cloud. Only 1|true|on|yes. */
export function ollamaCloudAllowed(env: Env = process.env): boolean {
	const v = (env.EIGHT_OLLAMA_CLOUD ?? "").trim().toLowerCase();
	return v === "1" || v === "true" || v === "on" || v === "yes";
}

/** A model tag Ollama forwards off the machine. */
export function isOllamaCloudModel(name: string | null | undefined): boolean {
	const m = (name ?? "").trim().toLowerCase();
	return m.endsWith("-cloud") || m.endsWith(":cloud");
}

/** The models with cloud tags removed, unless the person opted in. Order kept. */
export function dropOllamaCloud<T>(
	models: readonly T[],
	nameOf: (m: T) => string | null | undefined,
	env: Env = process.env,
): T[] {
	if (ollamaCloudAllowed(env)) return [...models];
	return models.filter((m) => !isOllamaCloudModel(nameOf(m)));
}

/** For string lists. */
export function dropOllamaCloudNames(names: readonly string[], env: Env = process.env): string[] {
	return dropOllamaCloud(names, (n) => n, env);
}

/** Said when a cloud tag is refused, so the person knows nothing was sent and how to change it. */
export const OLLAMA_CLOUD_REFUSED =
	"is an Ollama cloud model: Ollama would send your prompt to ollama.com, so nothing was sent. Pick a local model, or set EIGHT_OLLAMA_CLOUD=1 to allow it.";

/** Throws before any request when `model` is a cloud tag and the person has not opted in. */
export function assertOllamaLocal(model: string, env: Env = process.env): void {
	if (isOllamaCloudModel(model) && !ollamaCloudAllowed(env)) {
		throw new Error(`${model} ${OLLAMA_CLOUD_REFUSED}`);
	}
}
