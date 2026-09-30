/**
 * #3237: the agent's two-stage compactor must use the active provider's real
 * context window, and each checkpoint must build on the one before it.
 *
 * Drives the agent's own post-turn pass (observeTwoStage) with the model call
 * replaced, so no model runs. Token counts use the compactor's estimator:
 * 4 chars per token plus 4 per message.
 */

import { expect, test } from "bun:test";
import { Agent } from "./agent";

type Msg = { role: string; content: string };
type Probe = {
	messageHistory: Msg[];
	twoStageCheckpoints: { summary: string; cutoffIndex: number; tokensAtCapture: number }[];
	observeTwoStage(providerConfig: unknown): Promise<void>;
	generateCheckpoint(providerConfig: unknown, prompt: string): Promise<string>;
};

function agentOn(runtime: string) {
	const agent = new Agent({ model: "m", runtime } as ConstructorParameters<
		typeof Agent
	>[0]) as unknown as Probe;
	const prompts: string[] = [];
	agent.generateCheckpoint = async (_cfg, prompt) => {
		prompts.push(prompt);
		return "NEW_SUMMARY";
	};
	return { agent, prompts };
}

/** A system message plus alternating turns of about 1,000 tokens each. */
function historyOf(turns: number): Msg[] {
	const msgs: Msg[] = [{ role: "system", content: "sys" }];
	for (let i = 0; i < turns; i++) {
		msgs.push({ role: i % 2 ? "assistant" : "user", content: `turn ${i} ${"x".repeat(3990)}` });
	}
	return msgs;
}

test("a 200k provider does not compact at about 30k tokens", async () => {
	const { agent, prompts } = agentOn("anthropic");
	agent.messageHistory = historyOf(30);
	await agent.observeTwoStage({ name: "anthropic", model: "m" });
	expect(prompts).toHaveLength(0);
	expect(agent.twoStageCheckpoints).toHaveLength(0);
	expect(agent.messageHistory).toHaveLength(31);
});

test("a 32k provider still compacts at about 30k tokens (the window is real, not just larger)", async () => {
	const { agent, prompts } = agentOn("ollama");
	agent.messageHistory = historyOf(30);
	await agent.observeTwoStage({ name: "ollama", model: "m" });
	expect(prompts).toHaveLength(1);
	expect(agent.messageHistory.length).toBeLessThan(31);
});

test("a checkpoint is written on top of the previous checkpoint's summary", async () => {
	const { agent, prompts } = agentOn("ollama");
	agent.twoStageCheckpoints.push({
		summary: "PRIOR_DECISION_SENTINEL: keep the retry cap at 3",
		cutoffIndex: 5,
		tokensAtCapture: 21000,
	});
	// About 23k tokens: over the 65% checkpoint line of 32,768, under 80%.
	agent.messageHistory = historyOf(23);
	await agent.observeTwoStage({ name: "ollama", model: "m" });
	expect(prompts).toHaveLength(1);
	expect(prompts[0]).toContain("PRIOR_DECISION_SENTINEL: keep the retry cap at 3");
	expect(agent.twoStageCheckpoints.at(-1)?.summary).toBe("NEW_SUMMARY");
});
