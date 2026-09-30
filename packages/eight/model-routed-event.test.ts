/**
 * The agent tells its UI when a different model serves the turn (#3102).
 *
 * Covers the emitter both reroute sites in chat() call: the listener gets the
 * requested and the used model, and a listener that throws never changes the
 * turn (the Law 2 site sits inside a best-effort try, where a throw would have
 * silently cancelled the switch). The wiring into a real rerouted turn is
 * proven by the pilot run l3-bugfix-m5 with a model that is not installed.
 */

import { expect, test } from "bun:test";
import { Agent } from "./agent";
import type { AgentEventCallbacks } from "./types";

type Emit = { emitModelRouted: (requested: string, used: string, provider: string) => void };

function agentWith(events: AgentEventCallbacks): Emit {
	return new Agent({ model: "eight-1.0-q3:14b", runtime: "ollama", events }) as unknown as Emit;
}

test("onModelRouted receives the asked and the used model", () => {
	const seen: unknown[] = [];
	agentWith({ onModelRouted: (e) => seen.push(e) }).emitModelRouted("eight-1.0-q3:14b", "qwen3.8:27b-mlx", "ollama");
	expect(seen).toEqual([{ requested: "eight-1.0-q3:14b", used: "qwen3.8:27b-mlx", provider: "ollama" }]);
});

test("a listener that throws is contained", () => {
	const agent = agentWith({
		onModelRouted: () => {
			throw new Error("ui fault");
		},
	});
	expect(() => agent.emitModelRouted("a", "b", "ollama")).not.toThrow();
});

test("no listener is fine", () => {
	expect(() => agentWith({}).emitModelRouted("a", "b", "ollama")).not.toThrow();
});
