/**
 * #179: a provider failure says why, falls through the configured chain, and
 * never crosses the privacy line. Each test names the fault it pins.
 */
import { describe, expect, test } from "bun:test";
import { ModelFailover } from "../providers/failover";
import { answeredLine, exhaustedMessage, failureReason, fallThroughHop } from "./agent";

const asked = { provider: "minimax", model: "minimax-m2" };
const noChains = () => ({ text: {}, computer: {} });
const opts = (policy: "local-only" | "local-first" | "cloud-first") => ({
	allowHosted: false,
	policy: () => policy,
	hasCredentials: () => true,
});

describe("(2) a failed cloud turn falls through to a local provider that is available", () => {
	test("a model with no chain of its own still reaches a local entry", () => {
		const primary = new ModelFailover(noChains(), opts("local-first"));
		primary.markDown(asked.model, asked.provider);
		const hop = fallThroughHop(primary, asked, asked, "text", opts("local-first"), []);
		expect(hop.provider).toBe("ollama");
		expect(hop.provider).not.toBe("minimax");
	});

	test("one line says which provider answered and why the first did not", () => {
		const line = answeredLine(asked, { provider: "ollama", model: "eight:latest" }, [
			{ provider: "minimax", model: "minimax-m2", error: "connect ECONNREFUSED 127.0.0.1:1" },
		]);
		expect(line).toBe(
			"ollama/eight:latest answered. minimax/minimax-m2 did not: connection refused.",
		);
		expect(line.includes("\n")).toBe(false);
	});

	test("local-only with the local provider down: no cloud entry is ever the next hop", () => {
		const o = opts("local-only");
		const primary = new ModelFailover(noChains(), o);
		const down = [
			{ provider: "ollama", model: "eight:latest" },
			{ provider: "ollama", model: "qwen3.5:latest" },
		];
		const hop = fallThroughHop(primary, asked, asked, "text", o, down);
		expect(["ollama", "8gent", "apple-foundation"]).toContain(hop.provider);
		// every local entry is down: the hop must not become a hosted provider
		const last = fallThroughHop(primary, down[1], asked, "text", o, down);
		expect(["minimax", "openrouter"]).not.toContain(last.provider);
	});
});

describe("(3) the failure message names each provider with its real reason", () => {
	test("each provider tried, in order, one short line each", () => {
		const msg = exhaustedMessage({
			errors: [
				{ provider: "ollama", model: "qwen3:14b", error: "connect ECONNREFUSED 127.0.0.1:11434" },
				{ provider: "minimax", model: "minimax-m2", error: "no progress for 300s (quiet gap)" },
				{ provider: "openrouter", model: "x:free", error: "429 rate limit exceeded" },
			],
			policy: "local-first",
			skipped: [],
		});
		const lines = msg.split("\n");
		expect(lines[0]).toBe("All providers exhausted (3 attempted):");
		expect(lines[1]).toBe("  - ollama/qwen3:14b: connection refused");
		expect(lines[2]).toBe("  - minimax/minimax-m2: timed out after 300 seconds");
		expect(lines[3]).toBe("  - openrouter/x:free: rate limited");
	});

	test("the next step comes from the reasons, not a fixed 'send again'", () => {
		const refused = exhaustedMessage({
			errors: [{ provider: "ollama", model: "m", error: "ECONNREFUSED" }],
			policy: "local-first",
			skipped: [],
		});
		expect(refused).toMatch(/\nnext: .*ollama/);
		expect(refused).not.toContain("send again");
		const signedOut = exhaustedMessage({
			errors: [{ provider: "minimax", model: "m", error: "401 Unauthorized" }],
			policy: "local-first",
			skipped: [],
		});
		expect(signedOut).toMatch(/\nnext: .*\/apikeys/);
	});

	test("local-only with the local provider down says nothing went to the cloud", () => {
		const msg = exhaustedMessage({
			errors: [{ provider: "ollama", model: "m", error: "ECONNREFUSED" }],
			policy: "local-only",
			skipped: [],
		});
		expect(msg).toContain("Nothing was sent to a cloud provider: routing policy is local-only.");
	});

	test("a key in an auth failure never reaches any message", () => {
		const secret = "sk-proj-AbCdEf0123456789SECRETSECRET";
		const raw = `401 Incorrect API key provided: ${secret}. Authorization: Bearer ${secret}`;
		const msg = exhaustedMessage({
			errors: [{ provider: "openai", model: "m", error: raw }],
			policy: "local-first",
			skipped: [],
		});
		expect(msg).not.toContain(secret);
		expect(msg).toContain("not signed in");
		expect(failureReason("something odd: token=abcdef1234567890zzzz")).not.toContain(
			"abcdef1234567890zzzz",
		);
		expect(
			answeredLine(asked, { provider: "ollama", model: "e" }, [
				{ provider: "openai", model: "m", error: raw },
			]),
		).not.toContain(secret);
	});
});
