/**
 * The pure half of "one choice means no question" (#4720): no imports beyond
 * the local-provider list, so packages/eight/run.ts can use it without a cycle.
 * The half that reads keys and live model lists is packages/eight/auto-provider.ts.
 */
import { isLocalProvider } from "./local-providers";

/** What a local provider is called when it is the one that is not answering. */
export function localEngineLabel(provider: string): string {
	switch (provider) {
		case "8gent":
		case "ollama":
			return "Ollama";
		case "lmstudio":
			return "LM Studio";
		case "llama-server":
			return "llama-server";
		case "apfel":
		case "apple-foundation":
			return "Apple Foundation";
		default:
			return provider;
	}
}

/**
 * The one provider to use instead of `active`, or null. Only a LOCAL active
 * provider is ever swapped: a hosted provider the person chose is never
 * replaced behind their back. Exactly one other hosted provider with a key
 * switches; zero or several change nothing.
 */
export function soleRunnableProvider(active: string, hosted: readonly string[]): string | null {
	if (!isLocalProvider(active)) return null;
	const others = hosted.filter((n) => n !== active);
	return others.length === 1 ? others[0] : null;
}

/** The one transcript line: what was down, what is answering, how to change it. */
export function autoSwitchLine(from: string, toLabel: string, model: string): string {
	return `${localEngineLabel(from)} is not running; using ${toLabel} ${model}. /provider to change.`;
}
