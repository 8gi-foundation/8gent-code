/**
 * A pinned session's sub-agents stay on its provider (#3762).
 *
 * When the user named a provider (`--provider`, or a host that sets
 * `providerPinned`), a provider error ends that agent's turn with a plain
 * message and never moves to another provider (#3746). Every agent that session
 * starts (spawn_agent, the agent pool, delegation) follows the same rule:
 * it runs on the parent's provider and model, pinned.
 *
 * The pin rides an AsyncLocalStorage the Agent binds around each chat() turn,
 * the same way the agent depth and the permission mode ride theirs, so a
 * spawner needs no extra argument and a child cannot opt out. An un-pinned
 * parent binds nothing: its children are exactly as before.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface ProviderPin {
	/** The runtime/provider the user named. */
	runtime: string;
	/** The model the pinned parent runs, used when the child names none. */
	model?: string;
}

const _pin = new AsyncLocalStorage<ProviderPin | undefined>();

/** Run fn as an agent whose pin is `pin` (undefined: un-pinned, clearing any outer pin). */
export function runWithProviderPin<T>(pin: ProviderPin | undefined, fn: () => T): T {
	return _pin.run(pin, fn);
}

/** The pin of the agent whose call is in flight, or undefined when it is un-pinned. */
export function currentProviderPin(): ProviderPin | undefined {
	return _pin.getStore();
}

/** The pin a parent with this config binds: only an explicitly pinned parent has one. */
export function pinFromConfig(config: {
	runtime?: string;
	model?: string;
	providerPinned?: boolean;
}): ProviderPin | undefined {
	if (!config.providerPinned || !config.runtime) return undefined;
	return { runtime: config.runtime, model: config.model };
}

/**
 * The provider fields a child config takes from the in-flight pin: runtime and
 * `providerPinned` always, and the parent's model when the child named none.
 * Empty when the caller is un-pinned, so the child is built as before.
 */
export function inheritedProviderFields(
	pin: ProviderPin | undefined,
	childModel?: string,
): { runtime?: string; providerPinned?: true; model?: string } {
	if (!pin) return {};
	return {
		runtime: pin.runtime,
		providerPinned: true,
		...(childModel === undefined && pin.model ? { model: pin.model } : {}),
	};
}
