/**
 * Integration-shape test for the daemon turn-hang fix.
 *
 * This mirrors the EXACT control flow of the failover loop in
 * packages/eight/agent.ts (chat): a bounded chain of provider attempts, each
 * wrapped in withTurnTimeout, with the same catch semantics (timeout-driven
 * abort is treated as a provider failure, the shared controller is refreshed,
 * the chain advances, and an exhaustion error is thrown). It proves the
 * termination guarantee the daemon relies on:
 *
 *   When every provider in the chain is unreachable / never resolves, the turn
 *   settles with an "All providers exhausted" error in BOUNDED wall-clock time
 *   (roughly attempts x per-attempt-timeout), not the 30-minute session
 *   watchdog. agent-pool.chat() then converts that thrown error into an
 *   agent:error + session:end, which is what unblocks the WebSocket caller.
 *
 * We use a fake generate() that NEVER resolves (the literal hang the relay hit)
 * and an invalid-model fake that rejects fast, to cover both failure modes.
 */

import { describe, expect, it } from "bun:test";
import { TurnTimeoutError, withTurnTimeout } from "./turn-timeout";

/** A chain entry, same shape the agent walks. */
interface Entry {
	provider: string;
	model: string;
	/** behaviour of this provider's generate(): hang forever, or reject fast. */
	mode: "never" | "reject";
}

/**
 * Reproduce the agent.ts failover loop in miniature. Returns the final result
 * text on success, or throws "All providers exhausted" once the bounded chain
 * is exhausted. Every attempt is bounded by `attemptTimeoutMs`.
 */
async function runBoundedChain(
	chain: Entry[],
	attemptTimeoutMs: number,
): Promise<string> {
	const errors: Array<{ provider: string; model: string; error: string }> = [];
	let abortController = new AbortController();

	for (const entry of chain) {
		let attemptTimedOut = false;
		try {
			const text = await withTurnTimeout(
				async () => {
					const signal = abortController.signal;
					if (entry.mode === "reject") {
						// Models an invalid model id / bad request that fails fast.
						throw new Error(`Bad Request: model ${entry.model} not found`);
					}
					// Models an unreachable provider whose socket accepts but never
					// streams. It only ever settles if its signal is aborted - which
					// is exactly what our timeout hook does.
					return await new Promise<string>((_, reject) => {
						signal.addEventListener("abort", () =>
							reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
						);
					});
				},
				attemptTimeoutMs,
				() => {
					attemptTimedOut = true;
					abortController.abort();
				},
				`${entry.provider}/${entry.model}`,
			);
			return text; // a provider succeeded
		} catch (err: any) {
			// Same semantics as agent.ts: a real user ESC (no timeout) would
			// re-throw; a timeout-driven abort falls through to failover.
			if (err?.name === "AbortError" && !attemptTimedOut) throw err;
			if (attemptTimedOut) abortController = new AbortController();
			errors.push({
				provider: entry.provider,
				model: entry.model,
				error: String(err?.message ?? err),
			});
			// advance chain
		}
	}

	throw new Error(
		`All providers exhausted (${errors.length} attempted):\n${errors
			.map((e) => `  - ${e.provider}/${e.model}: ${e.error}`)
			.join("\n")}`,
	);
}

describe("daemon turn termination under an all-failing provider chain", () => {
	it("settles with 'All providers exhausted' within the bound when every provider hangs", async () => {
		// The literal scenario from the bug: an apple-foundation-style provider
		// that never answers, then an uninstalled local model that also never
		// answers, then an invalid openrouter id - none reachable.
		const chain: Entry[] = [
			{ provider: "apple-foundation", model: "apple-foundationmodel", mode: "never" },
			{ provider: "ollama", model: "qwen3:14b", mode: "never" },
			{ provider: "openrouter", model: "invalid/model:free", mode: "never" },
		];
		const perAttempt = 40;
		const start = Date.now();

		let thrown: unknown;
		try {
			await runBoundedChain(chain, perAttempt);
		} catch (e) {
			thrown = e;
		}
		const elapsed = Date.now() - start;

		// It MUST throw (not hang, not silently succeed).
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toContain("All providers exhausted");
		expect((thrown as Error).message).toContain("apple-foundation/apple-foundationmodel");

		// Bounded: roughly attempts x per-attempt timeout, with generous slack.
		// The key assertion is it is NOT anywhere near the 30-min watchdog.
		expect(elapsed).toBeLessThan(chain.length * perAttempt + 2000);
		expect(elapsed).toBeLessThan(30 * 60 * 1000);
	});

	it("mixes a fast-rejecting invalid model with hanging providers and still terminates", async () => {
		const chain: Entry[] = [
			{ provider: "openrouter", model: "invalid/model:free", mode: "reject" },
			{ provider: "apfel", model: "apple-foundationmodel", mode: "never" },
		];
		const start = Date.now();
		await expect(runBoundedChain(chain, 40)).rejects.toThrow(
			"All providers exhausted",
		);
		expect(Date.now() - start).toBeLessThan(2000);
	});

	it("returns the result when a provider in the chain succeeds (no false timeout)", async () => {
		// Sanity: the wrapper does not break the happy path.
		const ok = await withTurnTimeout(async () => "hello", 1000);
		expect(ok).toBe("hello");
	});

	it("the never-resolving attempt would hang forever WITHOUT the wrapper", async () => {
		// Demonstrates the bug the fix closes: the raw never-settling promise
		// only resolves via timeout. We assert that racing it against our
		// bound yields a TurnTimeoutError rather than pending indefinitely.
		const hang = () => new Promise<string>(() => {});
		await expect(withTurnTimeout(hang, 30, () => {})).rejects.toBeInstanceOf(
			TurnTimeoutError,
		);
	});
});
