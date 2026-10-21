import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ProviderManager } from "./index";
import { type PolicyState, decideRoute, readLedger, recordCall, updateCall } from "./locality";
import { guardFetch } from "./locality-wire";
import { type ConsultDeps, consult, providerSend, readConsultSettings } from "./consult";

const SK = `sk-${"a1B2c3D4e5F6g7H8i9J0"}kLmN`;
const EMAIL = "sarah.connor@cyberdyne-systems.com";
const IP = "203.0.113.42";
const PATHV = "/Users/jdoe/clients/zenith-bank/contracts/q3.pdf";
const QUESTION = `Why does ${PATHV} fail for ${EMAIL}? The server ${IP} rejects key ${SK} for Project Falcon.`;
const ORIGINALS = [SK, EMAIL, IP, "zenith-bank", "jdoe", "Falcon"];

let dir: string;
let ledger: string;
const realFetch = globalThis.fetch;
const policy = (p: PolicyState["policy"]): PolicyState => ({ policy: p, localHosts: [] });

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "consult-"));
	ledger = path.join(dir, "locality.jsonl");
});
afterEach(() => {
	globalThis.fetch = realFetch;
	fs.rmSync(dir, { recursive: true, force: true });
});

/** A real ProviderManager on a cloud host, a stubbed network under the wire guard, a real ledger file. */
function rig(state: PolicyState, mask = true) {
	const settings = path.join(dir, "providers.json");
	fs.writeFileSync(
		settings,
		JSON.stringify({
			activeProvider: "openrouter",
			activeModel: "some/model",
			providers: { openrouter: { enabled: true, apiKey: "test-key" } },
		}),
	);
	const bodies: string[] = [];
	const stub = (async (_url: string, init: any) => {
		bodies.push(String(init.body));
		const sent = JSON.parse(init.body);
		const user = sent.messages.map((m: any) => m.content).join(" ");
		const email = user.match(/\{\{EMAIL_\d+\}\}/)?.[0];
		return new Response(
			JSON.stringify({
				choices: [{ message: { content: `Check the account ${email} first.` } }],
				usage: { prompt_tokens: 40, completion_tokens: 9 },
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}) as unknown as typeof fetch;
	globalThis.fetch = guardFetch(stub, {
		state: () => state,
		nameOf: (hp) => hp,
		record: (c) => recordCall(c, ledger),
		update: (id, u) => updateCall(id, u, ledger),
		notify: () => {},
	});
	const mgr = new ProviderManager(settings);
	const deps: ConsultDeps = {
		state: () => state,
		settings: () => ({ mask, terms: ["Falcon"] }),
		send: providerSend(mgr),
	};
	return { deps, bodies };
}

describe("/consult", () => {
	test("the outgoing request body holds no original value", async () => {
		const { deps, bodies } = rig(policy("local-first"));
		const out = await consult(QUESTION, deps);
		expect(bodies.length).toBe(1);
		for (const v of ORIGINALS) expect(bodies[0]).not.toContain(v);
		expect(bodies[0]).toContain("{{EMAIL_1}}");
		// one stateless request: system line plus the question, nothing else
		expect(JSON.parse(bodies[0]).messages.length).toBe(2);
		// the answer is filled back in locally
		expect(out).toContain(`Check the account ${EMAIL} first.`);
		// the screen shows counts by type
		expect(out).toContain("1 secret, 1 email, 1 IP address, 1 home path, 1 listed term");
	});

	test("the ledger records a cloud call with masked:true and holds no text", async () => {
		const { deps } = rig(policy("cloud-first"));
		await consult(QUESTION, deps);
		const rows = readLedger(ledger);
		expect(rows.length).toBe(1);
		expect(rows[0].local).toBe(false);
		expect((rows[0] as any).masked).toBe(true);
		expect(rows[0].tokensIn).toBe(40);
		const raw = fs.readFileSync(ledger, "utf8");
		for (const v of [...ORIGINALS, "{{EMAIL_1}}", "Check the account"]) expect(raw).not.toContain(v);
	});

	test("no file written during a consult holds an original or a placeholder map", async () => {
		const { deps } = rig(policy("local-first"));
		await consult(QUESTION, deps);
		const all = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf8"));
		for (const text of all) for (const v of ORIGINALS) expect(text).not.toContain(v);
	});

	test("local-only refuses with the plain refusal and sends nothing", async () => {
		const { deps, bodies } = rig(policy("local-only"));
		const out = await consult(QUESTION, deps);
		const want = decideRoute({
			policy: "local-only",
			provider: "a cloud provider",
			local: false,
			pickedForTab: true,
		});
		expect(want.action).toBe("refuse");
		expect(out).toBe((want as any).message);
		expect(bodies.length).toBe(0);
		expect(readLedger(ledger).length).toBe(0);
	});

	test("a forced local-only (bad settings file) also refuses", async () => {
		const { deps, bodies } = rig({ policy: "local-only", why: "settings.json is empty", localHosts: [] });
		const out = await consult(QUESTION, deps);
		expect(out).toContain("local-only");
		expect(out).toContain("settings.json is empty");
		expect(bodies.length).toBe(0);
	});

	test("routing.mask false sends as typed and the ledger line is not marked masked", async () => {
		const { deps } = rig(policy("local-first"), false);
		const out = await consult("plain question about sorting", deps);
		expect(out).toContain("Masking is off");
		const rows = readLedger(ledger);
		expect((rows[0] as any).masked).toBeUndefined();
	});

	test("a failed send says so and applies nothing", async () => {
		const deps: ConsultDeps = {
			state: () => policy("local-first"),
			settings: () => ({ mask: true, terms: [] }),
			send: async () => {
				throw new Error("boom");
			},
		};
		expect(await consult("hello there", deps)).toContain("boom");
	});

	test("an empty question shows usage", async () => {
		const { deps } = rig(policy("local-first"));
		expect(await consult("   ", deps)).toContain("Usage: /consult");
	});
});

describe("readConsultSettings", () => {
	const write = (v: unknown) => {
		const f = path.join(dir, "settings.json");
		fs.writeFileSync(f, typeof v === "string" ? v : JSON.stringify(v));
		return f;
	};
	test("defaults to mask on, no terms", () => {
		expect(readConsultSettings(path.join(dir, "missing.json"))).toEqual({ mask: true, terms: [] });
	});
	test("reads mask, terms and provider", () => {
		const f = write({ routing: { mask: false, maskTerms: ["Acme", 3, "Falcon"], consultProvider: " x " } });
		expect(readConsultSettings(f)).toEqual({ mask: false, terms: ["Acme", "Falcon"], provider: "x" });
	});
	test("an unreadable file keeps masking on", () => {
		expect(readConsultSettings(write("{nope")).mask).toBe(true);
	});
});
