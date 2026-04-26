/**
 * Cost estimation.
 *
 * Rough USD-per-million-token table used to attribute spend to a tenant
 * at emit time. Local providers are 0. Cloud rates are conservative
 * 2026-Q1 list prices — refine when billing reconciliation lands.
 *
 * The point isn't accounting precision, it's catching a tenant who
 * burns 100x what they should so we can call them before the bill does.
 */

interface ModelRate {
	/** USD per million prompt tokens. */
	promptPerM: number;
	/** USD per million completion tokens. */
	completionPerM: number;
}

/** Provider-level fallback rates (used when model isn't in the table). */
const PROVIDER_DEFAULTS: Record<string, ModelRate> = {
	"8gent": { promptPerM: 0, completionPerM: 0 },
	ollama: { promptPerM: 0, completionPerM: 0 },
	lmstudio: { promptPerM: 0, completionPerM: 0 },
	"apple-foundation": { promptPerM: 0, completionPerM: 0 },
	apfel: { promptPerM: 0, completionPerM: 0 },
	openrouter: { promptPerM: 0.5, completionPerM: 1.5 },
	openai: { promptPerM: 2.5, completionPerM: 10 },
	anthropic: { promptPerM: 3, completionPerM: 15 },
	groq: { promptPerM: 0.5, completionPerM: 0.8 },
	grok: { promptPerM: 5, completionPerM: 15 },
	mistral: { promptPerM: 2, completionPerM: 6 },
	together: { promptPerM: 0.6, completionPerM: 0.6 },
	fireworks: { promptPerM: 0.5, completionPerM: 0.5 },
	replicate: { promptPerM: 1, completionPerM: 1 },
	deepseek: { promptPerM: 0.27, completionPerM: 1.1 },
};

/** Specific model overrides (substring match against modelId). */
const MODEL_OVERRIDES: Array<{ match: RegExp; rate: ModelRate }> = [
	{ match: /:free$/i, rate: { promptPerM: 0, completionPerM: 0 } },
	{ match: /eight-1/i, rate: { promptPerM: 0, completionPerM: 0 } },
	{ match: /gpt-5/i, rate: { promptPerM: 5, completionPerM: 15 } },
	{ match: /opus-4/i, rate: { promptPerM: 15, completionPerM: 75 } },
	{ match: /sonnet-4/i, rate: { promptPerM: 3, completionPerM: 15 } },
	{ match: /haiku-4/i, rate: { promptPerM: 0.8, completionPerM: 4 } },
];

export function estimateCostUsd(
	provider: string,
	model: string,
	promptTokens: number,
	completionTokens: number,
): number {
	for (const o of MODEL_OVERRIDES) {
		if (o.match.test(model)) {
			return rate(promptTokens, completionTokens, o.rate);
		}
	}
	const r = PROVIDER_DEFAULTS[provider.toLowerCase()] ?? { promptPerM: 0, completionPerM: 0 };
	return rate(promptTokens, completionTokens, r);
}

function rate(prompt: number, completion: number, r: ModelRate): number {
	return (prompt * r.promptPerM + completion * r.completionPerM) / 1_000_000;
}
