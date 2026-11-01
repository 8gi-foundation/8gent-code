/**
 * The /provider list and the /status first line, as pure functions (#4720).
 *
 * The picker used to list providers in registry order, so a keyed MiniMax sat
 * 19 rows down behind "12 more below" while an unreachable Ollama was marked
 * "Currently active". Now what can run is first, what cannot is last and
 * dimmed, and the active row says so when it is not answering.
 */
import type { ProviderOption } from "../components/select-input.js";
import { ENGINE_FOR } from "./readiness.js";

/** The latest probe per local engine: name to up. */
export type EngineMap = Readonly<Record<string, boolean>>;

export type ProviderAvailability = "runnable" | "not-reachable" | "unavailable";

/**
 * Can this provider run a turn right now, as far as is known without a call?
 * A local engine the probe reported down is "not-reachable" (selectable: it may
 * be started). A provider that needs a key and has none, or is switched off, is
 * "unavailable". Everything else is "runnable": an engine the probe has not
 * reported on is not treated as down.
 */
export function availabilityOf(p: ProviderOption, engines: EngineMap): ProviderAvailability {
	const mapped = ENGINE_FOR[p.name];
	if (mapped) return engines[mapped.engine] === false ? "not-reachable" : "runnable";
	if (!p.enabled) return "unavailable";
	if (p.needsKey !== false && !p.hasApiKey) return "unavailable";
	return "runnable";
}

export interface OrderedProvider extends ProviderOption {
	availability: ProviderAvailability;
}

/** Runnable first, then not reachable, then unavailable. Stable inside each group. */
export function orderProviders(
	providers: readonly ProviderOption[],
	engines: EngineMap,
): OrderedProvider[] {
	const rank: Record<ProviderAvailability, number> = {
		runnable: 0,
		"not-reachable": 1,
		unavailable: 2,
	};
	return providers
		.map((p, i) => ({ p: { ...p, availability: availabilityOf(p, engines) }, i }))
		.sort((a, b) => rank[a.p.availability] - rank[b.p.availability] || a.i - b.i)
		.map((x) => x.p);
}

/** What the picker prints under the highlighted row. */
export function providerRowNote(p: OrderedProvider, isActive: boolean): string {
	if (isActive) return p.availability === "runnable" ? "Currently active" : "active, not reachable";
	if (p.availability === "not-reachable") return "Not reachable right now";
	if (p.hasApiKey) return "API key configured";
	if (p.needsKey === false) return "No key needed";
	return "No API key (requires setup)";
}

/**
 * `/status` first line: provider, model, and whether it can run. The wording
 * follows the same readiness the NOW strip shows, so the two cannot disagree.
 */
export function statusFirstLine(o: {
	provider: string;
	label: string;
	model: string;
	readiness: { state: string; reason?: string | null };
}): string {
	const model = o.model.trim() || "no model yet";
	const state =
		o.readiness.state === "ready"
			? "reachable"
			: o.readiness.state === "checking"
				? "checking"
				: /key/i.test(o.readiness.reason ?? "")
					? `not ready (${o.readiness.reason})`
					: `not reachable (${o.readiness.reason || "not ready"})`;
	return `Provider: ${o.label} (${o.provider}), model ${model}, ${state}`;
}
