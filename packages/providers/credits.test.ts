import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CREDIT_REFRESH_MS,
	creditBlocks,
	creditGaugeText,
	creditStatus,
	refreshCredits,
} from "./credits";
import { type FailoverChain, type FailoverChannel, ModelFailover } from "./failover";

let dir: string;
let file: string;
const KEY = { OPENROUTER_API_KEY: "sk-test-secret" };
const noVault = () => undefined;
const T0 = 1_000_000;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "credits-"));
	file = join(dir, "credits.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const seed = (usd: number, at = T0) =>
	writeFileSync(file, JSON.stringify({ fetchedAt: at, remaining: { openrouter: usd } }));
const opts = (env: Record<string, string | undefined> = KEY, now = T0) => ({
	file,
	env,
	now: () => now,
	readKey: noVault,
});

describe("creditStatus", () => {
	test("local providers report local without a file", () => {
		for (const id of ["8gent", "ollama"]) expect(creditStatus(id, opts({}))).toEqual({ kind: "local" });
	});

	test("cached amount is returned, not stale inside 10 min", () => {
		seed(3.2);
		expect(creditStatus("openrouter", opts())).toEqual({ kind: "amount", usd: 3.2, stale: false });
	});

	test("a cache older than 10 min is marked stale", () => {
		seed(3.2);
		const s = creditStatus("openrouter", opts(KEY, T0 + CREDIT_REFRESH_MS + 1));
		expect(s).toEqual({ kind: "amount", usd: 3.2, stale: true });
	});

	test("zero credit is empty", () => {
		seed(0);
		expect(creditStatus("openrouter", opts())).toEqual({ kind: "empty" });
	});

	test("missing key is nokey, even with a cached number", () => {
		seed(5);
		expect(creditStatus("openrouter", opts({}))).toEqual({ kind: "nokey" });
	});

	test("no cache file or a corrupt one is unknown, never a throw", () => {
		expect(creditStatus("openrouter", opts())).toEqual({ kind: "unknown" });
		writeFileSync(file, "{not json");
		expect(creditStatus("openrouter", opts())).toEqual({ kind: "unknown" });
	});

	test("a hosted provider with no balance endpoint is unknown", () => {
		expect(creditStatus("groq", opts({ GROQ_API_KEY: "x" }))).toEqual({ kind: "unknown" });
	});
});

describe("creditGaugeText", () => {
	test("local, amount, unknown, empty, no key", () => {
		seed(3.2);
		expect(creditGaugeText("ollama", opts({}))).toBe("local");
		expect(creditGaugeText("openrouter", opts())).toBe("$3.20 left");
		expect(creditGaugeText("groq", opts({ GROQ_API_KEY: "x" }))).toBe("credit ?");
		expect(creditGaugeText("openrouter", opts({}))).toBe("no key");
		seed(0);
		expect(creditGaugeText("openrouter", opts())).toBe("$0.00 left");
	});
});

describe("refreshCredits", () => {
	const ok = (limit_remaining: number | null) => async () =>
		new Response(JSON.stringify({ data: { limit_remaining } }), { status: 200 });

	test("writes the cache and never stores the key", async () => {
		await refreshCredits({ ...opts(), fetchFn: ok(7.5) });
		const raw = readFileSync(file, "utf-8");
		expect(JSON.parse(raw).remaining.openrouter).toBe(7.5);
		expect(raw).not.toContain("sk-test-secret");
	});

	test("at most once per 10 minutes", async () => {
		let calls = 0;
		const f = async () => {
			calls++;
			return ok(1)();
		};
		await refreshCredits({ ...opts(), fetchFn: f });
		await refreshCredits({ ...opts(KEY, T0 + 1000), fetchFn: f });
		expect(calls).toBe(1);
		await refreshCredits({ ...opts(KEY, T0 + CREDIT_REFRESH_MS), fetchFn: f });
		expect(calls).toBe(2);
	});

	test("calls nothing without a key", async () => {
		let calls = 0;
		await refreshCredits({
			...opts({}),
			fetchFn: async () => {
				calls++;
				return ok(1)();
			},
		});
		expect(calls).toBe(0);
	});

	test("a throwing or failing fetch never throws and keeps the old number", async () => {
		seed(2, T0 - CREDIT_REFRESH_MS - 1);
		await refreshCredits({
			...opts(),
			fetchFn: async () => {
				throw new Error("offline");
			},
		});
		expect(JSON.parse(readFileSync(file, "utf-8")).remaining.openrouter).toBe(2);
		await refreshCredits({ ...opts(KEY, T0 + 2 * CREDIT_REFRESH_MS), fetchFn: async () => new Response("", { status: 500 }) });
		expect(existsSync(file)).toBe(true);
	});

	test("an uncapped key (null remaining) drops the number", async () => {
		seed(2, T0 - CREDIT_REFRESH_MS - 1);
		await refreshCredits({ ...opts(), fetchFn: ok(null) });
		expect(creditStatus("openrouter", opts())).toEqual({ kind: "unknown" });
	});
});

describe("failover skips a dry cloud lane", () => {
	const chains: Record<FailoverChannel, Record<string, FailoverChain>> = {
		text: {
			m: {
				models: [
					{ model: "or-model", provider: "openrouter" },
					{ model: "local-model", provider: "ollama" },
				],
			},
		},
		computer: {},
	};
	const mk = (creditBlocked: (p: string) => boolean) =>
		new ModelFailover(chains, { allow: null, allowHosted: true, creditBlocked });

	test("skips openrouter when blocked, logs one line, records the reason", () => {
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		const fo = mk((p) => p === "openrouter");
		expect(fo.resolve("m")).toEqual({ model: "local-model", provider: "ollama" });
		fo.resolve("m");
		const lines = warn.mock.calls.filter((c) => String(c[0]).includes("openrouter skipped"));
		expect(lines.length).toBe(1);
		expect(lines.join()).not.toContain("sk-");
		expect(fo.getEvents().at(-1)?.reason).toBe("credit-empty");
		warn.mockRestore();
	});

	test("keeps the head when it has credit", () => {
		expect(mk(() => false).resolve("m").provider).toBe("openrouter");
	});

	test("creditBlocks flags empty and nokey only", () => {
		seed(0);
		expect(creditBlocks("openrouter", opts())).toBe(true);
		expect(creditBlocks("openrouter", opts({}))).toBe(true);
		seed(1);
		expect(creditBlocks("openrouter", opts())).toBe(false);
		expect(creditBlocks("ollama", opts({}))).toBe(false);
	});
});
