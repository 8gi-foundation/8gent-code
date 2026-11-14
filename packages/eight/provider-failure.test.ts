/**
 * #179: a provider failure says why, falls through the configured chain, and
 * never crosses the privacy line. Each test names the fault it pins.
 */
import { describe, expect, test } from "bun:test";
import { ModelFailover } from "../providers/failover";
import { answeredLine, exhaustedMessage, failureReason, fallThroughHop } from "./agent";

const asked = { provider: "minimax", model: "minimax-m2" };
type Entry = { model: string; provider: string };
type Policy = "local-only" | "local-first" | "cloud-first";
// Hosted ALLOWED and a key present for every provider: only the fall-through's own rules
// keep a hop on this machine.
const hostedOn = (policy: Policy) => ({
	allowHosted: true,
	policy: () => policy,
	hasCredentials: () => true,
});
const hostedOff = (policy: Policy) => ({ ...hostedOn(policy), allowHosted: false });
// A person's ~/.8gent/failover.json, as loadChains() would hand it over. The eight:latest
// anchor names a hosted step, so a fall-through that took it would leave the machine.
const anchor = {
	models: [
		{ model: "eight:latest", provider: "ollama" },
		{ model: "qwen3.5:latest", provider: "ollama" },
		{ model: "meta-llama/llama-3-8b-instruct:free", provider: "openrouter" },
	],
};
const personChains = (own: Record<string, { models: Entry[] }>) => ({
	text: { "eight:latest": anchor, ...own },
	computer: {},
});
const isHosted = (p: string) => !["ollama", "8gent", "lmstudio", "apple-foundation"].includes(p);

/** Every hop a turn takes when each provider it reaches fails, walked as the turn loop does. */
function walk(primary: ModelFailover, start: Entry): Entry[] {
	const down: Entry[] = [start];
	const tried = new Set([`${start.provider}::${start.model}`]);
	primary.markDown(start.model, start.provider);
	const path: Entry[] = [];
	let cur = start;
	for (let i = 0; i < 6; i++) {
		const next = fallThroughHop(primary, cur, start, "text", down);
		const key = `${next.provider}::${next.model}`;
		if (tried.has(key)) break;
		tried.add(key);
		path.push(next);
		primary.markDown(next.model, next.provider);
		down.push(next);
		cur = next;
	}
	console.log(
		`hop path from ${start.provider}/${start.model}:`,
		path.map((e) => `${e.provider}/${e.model}`).join(" -> ") || "(none)",
	);
	return path;
}

describe("(2) a failed cloud turn falls through to a local provider that is available", () => {
	test("a model with no chain of its own still reaches a local entry", () => {
		const primary = new ModelFailover(personChains({}), hostedOff("local-first"));
		primary.markDown(asked.model, asked.provider);
		const hop = fallThroughHop(primary, asked, asked, "text", [asked]);
		expect(hop).toEqual({ model: "eight:latest", provider: "ollama" });
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

	test("hosted allowed, key present, a local-only chain: every hop stays on this machine", () => {
		const start = { model: "qwen3:14b", provider: "ollama" };
		const own = { "qwen3:14b": { models: [start] } };
		const path = walk(new ModelFailover(personChains(own), hostedOn("local-first")), start);
		expect(path).toEqual([
			{ model: "eight:latest", provider: "ollama" },
			{ model: "qwen3.5:latest", provider: "ollama" },
		]);
		expect(path.filter((e) => isHosted(e.provider))).toEqual([]);
	});

	test("hosted allowed, key present, a local model with no chain: never sent to openrouter", () => {
		const start = { model: "qwen3:14b", provider: "ollama" };
		for (const policy of ["local-first", "cloud-first"] as const) {
			const path = walk(new ModelFailover(personChains({}), hostedOn(policy)), start);
			expect(path.filter((e) => isHosted(e.provider))).toEqual([]);
		}
	});

	test("hosted allowed: the only hosted hop is the one the person put in their own chain", () => {
		const start = { model: "qwen3:14b", provider: "ollama" };
		const theirs = { model: "qwen/qwen3-14b", provider: "openrouter" };
		const own = { "qwen3:14b": { models: [start, theirs] } };
		const path = walk(new ModelFailover(personChains(own), hostedOn("local-first")), start);
		expect(path.filter((e) => isHosted(e.provider))).toEqual([theirs]);
		expect(path).toContainEqual({ model: "eight:latest", provider: "ollama" });
		expect(path).not.toContainEqual(anchor.models[2]);
	});

	test("local-only, hosted allowed, a hosted step in their own chain: no hop is hosted", () => {
		const start = { model: "qwen3:14b", provider: "ollama" };
		const own = {
			"qwen3:14b": { models: [start, { model: "qwen/qwen3-14b", provider: "openrouter" }] },
		};
		const path = walk(new ModelFailover(personChains(own), hostedOn("local-only")), start);
		expect(path.length).toBeGreaterThan(0);
		expect(path.filter((e) => isHosted(e.provider))).toEqual([]);
	});

	test("a cloud model the person picked, every local step down: the turn ends, no other cloud", () => {
		const primary = new ModelFailover(personChains({}), hostedOn("local-first"));
		const path = walk(primary, asked);
		expect(path).toEqual([
			{ model: "eight:latest", provider: "ollama" },
			{ model: "qwen3.5:latest", provider: "ollama" },
		]);
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

describe("(4) secrets the scrubber used to miss never reach a message", () => {
	test("an access_token query value is hidden", () => {
		const out = failureReason("odd reply from /v1?access_token=FAKEFAKEFAKE0000");
		expect(out).not.toContain("FAKEFAKEFAKE0000");
		expect(out).toContain("access_token=[hidden]");
	});

	test("a key starting gsk_ is hidden", () => {
		const out = failureReason("odd reply, key gsk_FAKEFAKEFAKEFAKE0000 was used");
		expect(out).not.toContain("FAKEFAKEFAKEFAKE0000");
		expect(out).toContain("[hidden]");
	});

	test("a user and password inside a URL are hidden", () => {
		const out = failureReason("odd reply from https://someone:FAKEPASS0000@host.invalid/v1");
		expect(out).not.toContain("someone");
		expect(out).not.toContain("FAKEPASS0000");
		expect(out).toContain("https://[hidden]@host.invalid/v1");
	});
});
