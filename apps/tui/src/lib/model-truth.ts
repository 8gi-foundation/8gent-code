/**
 * Which model the screen names (#3102).
 *
 * The agent reroutes when the configured model cannot serve a turn: not
 * installed (model-reroute.ts), or it fails the tool-capability probe
 * (Law 2 in agent.ts). It then self-corrects its own config.model. The
 * screen must name the model that ran, not the one that was asked for,
 * and may show the asked one only when it is clearly marked as asked.
 *
 * Display only. Whether a tab agent is reused still keys on the spec it
 * was built for (canReuseTabAgent, #3084), never on anything here.
 *
 * Pure: no React, no Ink.
 */

export interface ModelTruthInput {
	/** The model the TUI is configured for (currentModel). */
	asked: string;
	/** The model the active tab agent was built for. Undefined: unknown. */
	built?: string;
	/** The agent's live config.model, which a reroute self-corrects. */
	live?: string;
	/** The model the agent's last reroute event named, if any. It lands
	 *  before config.model does, so it is right during the rerouted turn. */
	routed?: string;
}

export interface ModelTruth {
	/** The model that ran, or will run, the turn. */
	ran: string;
	/** The configured model, present only when it is not the one that ran. */
	asked?: string;
}

export function modelOnScreen(input: ModelTruthInput): ModelTruth {
	const { asked } = input;
	// An agent built for some other model is on its way out: it is dropped
	// and rebuilt for `asked` before any turn runs, so what it ran says
	// nothing about the next turn.
	if (!asked || (input.built !== undefined && input.built !== asked)) return { ran: asked };
	const ran = input.routed || input.live || asked;
	return ran === asked ? { ran } : { ran, asked };
}

/**
 * Which provider the screen names beside the model that ran. A reroute can
 * move the turn to another provider as well as another model (for example
 * `8gent` asked, the installed qwen3.8:27b-mlx served by `ollama`), and the
 * reroute event carries it. The provider follows the route the same way the
 * model does: the routed one while the routed model is the one on screen,
 * else the configured one.
 */
export function providerOnScreen(input: {
	/** The configured provider (currentProvider). */
	asked: string;
	/** The last reroute event for the active agent, if any. */
	routed?: { model: string; provider: string };
	/** The model on screen (modelOnScreen(...).ran). */
	ran: string;
}): string {
	const { routed } = input;
	return routed?.provider && routed.model === input.ran ? routed.provider : input.asked;
}

/**
 * The route the screen names: the model that ran (with the asked one when
 * different) and the provider that served it. The reroute event is passed
 * whole, so its provider cannot be dropped on the way to the screen.
 */
export function routeOnScreen(
	input: Omit<ModelTruthInput, "routed"> & {
		/** The configured provider (currentProvider). */
		askedProvider: string;
		/** The active agent's last reroute event, if any. */
		routed?: { model: string; provider: string };
	},
): ModelTruth & { provider: string } {
	const shown = modelOnScreen({ ...input, routed: input.routed?.model });
	return {
		...shown,
		provider: providerOnScreen({
			asked: input.askedProvider,
			routed: input.routed,
			ran: shown.ran,
		}),
	};
}

/** One-line form, for surfaces with a single text slot. */
export function askedNote(asked: string): string {
	return `(asked ${asked})`;
}
