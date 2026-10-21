import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type LedgerEntry,
	type RouteDecision,
	type RoutingPolicy,
	SESSION_ID,
	chipText,
	decideRoute,
	meterOf,
	privacyReport,
	readLedger,
	readPolicy,
	recordCall,
	routeCommand,
} from "./locality";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "locality-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entry = (over: Partial<LedgerEntry>): LedgerEntry => ({
	ts: "2026-10-21T10:00:00.000Z",
	session: "s1",
	provider: "ollama",
	local: true,
	tokensIn: 0,
	tokensOut: 0,
	bytesSent: 0,
	...over,
});

describe("decideRoute table", () => {
	const rows: Array<
		[RoutingPolicy, boolean, boolean, boolean | undefined, RouteDecision["action"]]
	> = [
		// policy, local, pickedForTab, localReachable, expected action
		["local-only", true, true, undefined, "allow-local"],
		["local-first", true, false, undefined, "allow-local"],
		["cloud-first", true, false, undefined, "allow-local"],
		["local-only", false, true, true, "refuse"],
		["local-only", false, false, false, "refuse"],
		["cloud-first", false, false, true, "allow-cloud"],
		["local-first", false, true, true, "allow-cloud"],
		["local-first", false, false, true, "use-local"],
		["local-first", false, false, false, "allow-cloud"],
		["local-first", false, false, undefined, "allow-cloud"],
	];
	for (const [policy, local, pickedForTab, localReachable, want] of rows) {
		test(`${policy} local=${local} picked=${pickedForTab} reachable=${localReachable} -> ${want}`, () => {
			const d = decideRoute({ policy, provider: "cloudco", local, pickedForTab, localReachable });
			expect(d.action).toBe(want);
			// a cloud call is never silent
			if (d.action === "allow-cloud") expect(d.notice).toContain("cloudco");
		});
	}

	test("local-only refusal is plain: names the provider, says nothing left, says how to change", () => {
		const d = decideRoute({
			policy: "local-only",
			provider: "minimax",
			local: false,
			pickedForTab: true,
		});
		if (d.action !== "refuse") throw new Error("expected refuse");
		expect(d.message).toContain("local-only");
		expect(d.message).toContain("minimax");
		expect(d.message).toContain("Nothing left this machine");
		expect(d.message).toContain("/route local-first");
		expect(d.message).not.toMatch(/agent/i);
	});
});

describe("policy storage", () => {
	test("default is local-first when the file is missing, empty or wrong", () => {
		const f = join(dir, "settings.json");
		expect(readPolicy(f)).toBe("local-first");
		writeFileSync(f, JSON.stringify({ routing: { policy: "bogus" } }));
		expect(readPolicy(f)).toBe("local-first");
	});

	test("/route saves, keeps other settings, and rejects unknown values", () => {
		const f = join(dir, "settings.json");
		writeFileSync(f, JSON.stringify({ voice: { on: true }, routing: { other: 1 } }));
		expect(routeCommand("local-only", f)).toBe("Routing policy set to local-only.");
		const saved = JSON.parse(readFileSync(f, "utf8"));
		expect(saved.voice).toEqual({ on: true });
		expect(saved.routing).toEqual({ other: 1, policy: "local-only" });
		expect(readPolicy(f)).toBe("local-only");
		expect(routeCommand("everything", f)).toContain("Unknown policy");
		expect(readPolicy(f)).toBe("local-only");
		expect(routeCommand("", f)).toContain("local-only");
	});
});

describe("ledger", () => {
	test("one JSON line per call, with the fixed fields", () => {
		const f = join(dir, "locality.jsonl");
		recordCall({ provider: "ollama", local: true, tokensIn: 100, tokensOut: 20 }, f);
		recordCall({ provider: "minimax", local: false, tokensIn: 500, tokensOut: 50 }, f);
		const lines = readFileSync(f, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		const [a, b] = lines.map((l) => JSON.parse(l));
		expect(Object.keys(a).sort()).toEqual(
			["bytesSent", "local", "provider", "session", "tokensIn", "tokensOut", "ts"].sort(),
		);
		expect(a).toMatchObject({
			provider: "ollama",
			local: true,
			tokensIn: 100,
			tokensOut: 20,
			bytesSent: 0,
		});
		expect(b).toMatchObject({
			provider: "minimax",
			local: false,
			bytesSent: 2000,
			session: SESSION_ID,
		});
	});

	test("a secret-looking prompt handed to the recorder never reaches the file", () => {
		const f = join(dir, "locality.jsonl");
		const secret = "sk-live-SECRET-9f8e7d6c-do-not-log";
		const call = {
			provider: "minimax",
			local: false,
			tokensIn: 10,
			tokensOut: 5,
			prompt: `my key is ${secret}`,
			response: secret,
			messages: [{ role: "user", content: secret }],
		};
		recordCall(call as any, f);
		const raw = readFileSync(f, "utf8");
		expect(raw).not.toContain(secret);
		expect(raw).not.toContain("prompt");
		expect(raw).not.toContain("messages");
	});

	test("a call with no measured tokens writes nothing; a torn line is skipped on read", () => {
		const f = join(dir, "locality.jsonl");
		expect(
			recordCall({ provider: "ollama", local: true, tokensIn: 0, tokensOut: 0 }, f),
		).toBeNull();
		recordCall({ provider: "ollama", local: true, tokensIn: 3, tokensOut: 1 }, f);
		writeFileSync(f, `${readFileSync(f, "utf8")}{"ts":"x","prov\n`);
		expect(readLedger(f)).toHaveLength(1);
		expect(readLedger(join(dir, "missing.jsonl"))).toEqual([]);
	});
});

describe("meter maths", () => {
	test("share is by tokens, rounded, and null when nothing was measured", () => {
		expect(meterOf([]).localPct).toBeNull();
		const m = meterOf([
			entry({ tokensIn: 900, tokensOut: 20 }),
			entry({ local: false, provider: "minimax", tokensIn: 70, tokensOut: 10, bytesSent: 280 }),
		]);
		expect(m.localTokens).toBe(920);
		expect(m.cloudTokens).toBe(80);
		expect(m.localPct).toBe(92);
		expect(m.cloudCalls).toHaveLength(1);
	});

	test("all cloud is 0%, all local is 100%", () => {
		expect(meterOf([entry({ local: false, tokensIn: 5 })]).localPct).toBe(0);
		expect(meterOf([entry({ tokensIn: 5 })]).localPct).toBe(100);
	});

	test("chip counts today only", () => {
		const now = new Date(2026, 9, 21, 15, 0, 0);
		const today = new Date(2026, 9, 21, 9, 0, 0).toISOString();
		const old = new Date(2026, 9, 20, 9, 0, 0).toISOString();
		const rows = [
			entry({ ts: today, tokensIn: 92 }),
			entry({ ts: today, local: false, tokensIn: 8 }),
			entry({ ts: old, local: false, tokensIn: 10000 }),
		];
		expect(chipText(rows, now)).toBe("92% local today");
		expect(chipText([entry({ ts: old, tokensIn: 5 })], now)).toBeNull();
	});

	test("/privacy lists policy, both scopes and each cloud call with provider and size", () => {
		const now = new Date(2026, 9, 21, 15, 0, 0);
		const ts = new Date(2026, 9, 21, 9, 30, 15).toISOString();
		const rows = [
			entry({ ts, session: "mine", tokensIn: 300 }),
			entry({
				ts,
				session: "mine",
				local: false,
				provider: "minimax",
				tokensIn: 100,
				tokensOut: 50,
				bytesSent: 400,
			}),
			entry({ ts, session: "other", tokensIn: 1000 }),
		];
		const out = privacyReport(rows, "local-first", now, "mine");
		expect(out).toContain("Routing policy: local-first");
		expect(out).toContain("Today: 90% local by tokens");
		expect(out).toContain("This session: 67% local by tokens");
		expect(out).toContain("minimax");
		expect(out).toContain("150 tokens");
		expect(out).toContain("400 B");
	});
});
