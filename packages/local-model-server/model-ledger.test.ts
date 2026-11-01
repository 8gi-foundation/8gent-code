/**
 * Model ledger (#4609): pin the local model identity on first use, warn when the
 * digest or quantisation behind the same name changes, re-pin on request.
 * Every provider response is stubbed; the ledger lives in a temp home.
 */
import { afterAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	checkModel,
	ledgerPath,
	modelLedgerDoctorLines,
	readLedger,
	repinModel,
} from "./model-ledger";

const homes: string[] = [];
afterAll(() => {
	for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
});
function home(): string {
	const h = fs.mkdtempSync(path.join(os.tmpdir(), "model-ledger-"));
	homes.push(h);
	return h;
}

/** A stub Ollama: one model whose digest and quant the test can change. */
function ollama(name: string, digest: string, quant: string, size = "8.2B") {
	return async (url: string): Promise<Response> => {
		if (url.endsWith("/api/tags"))
			return new Response(JSON.stringify({ models: [{ name, digest, size: 1 }] }));
		if (url.endsWith("/api/show"))
			return new Response(
				JSON.stringify({ details: { quantization_level: quant, parameter_size: size } }),
			);
		return new Response("nope", { status: 404 });
	};
}
const M = "stub-model:1b";
const NOW = () => new Date("2026-10-21T10:00:00Z");

describe("model ledger", () => {
	it("first sight pins and says so", async () => {
		const h = home();
		const r = await checkModel("ollama", M, {
			home: h,
			fetch: ollama(M, "aaa111bbb222", "Q4_K_M"),
			now: NOW,
		});
		expect(r.status).toBe("pinned");
		expect(r.lines.join(" ")).toContain("Q4_K_M");
		const pin = readLedger(h).pins[`ollama\n${M}`];
		expect(pin.digest).toBe("aaa111bbb222");
		expect(pin.quant).toBe("Q4_K_M");
		expect(pin.firstSeen).toBe("2026-10-21T10:00:00.000Z");
	});

	it("an unchanged model is silent", async () => {
		const h = home();
		const f = ollama(M, "aaa111bbb222", "Q4_K_M");
		await checkModel("ollama", M, { home: h, fetch: f });
		const r = await checkModel("ollama", M, { home: h, fetch: f });
		expect(r.status).toBe("unchanged");
		expect(r.lines).toEqual([]);
	});

	it("a changed digest warns plainly with the re-pin command and keeps the old pin", async () => {
		const h = home();
		await checkModel("ollama", M, { home: h, fetch: ollama(M, "aaa111bbb222", "Q4_K_M") });
		const r = await checkModel("ollama", M, {
			home: h,
			fetch: ollama(M, "ccc333ddd444", "Q4_K_M"),
		});
		expect(r.status).toBe("changed");
		const text = r.lines.join("\n");
		expect(text).toContain("digest changed");
		expect(text).toContain("aaa111bbb222".slice(0, 12));
		expect(text).toContain("8gent model-pin");
		expect(readLedger(h).pins[`ollama\n${M}`].digest).toBe("aaa111bbb222");
	});

	it("a changed quantisation warns and names both", async () => {
		const h = home();
		await checkModel("ollama", M, { home: h, fetch: ollama(M, "aaa111bbb222", "Q4_K_M") });
		const r = await checkModel("ollama", M, { home: h, fetch: ollama(M, "aaa111bbb222", "Q8_0") });
		expect(r.status).toBe("changed");
		expect(r.lines.join("\n")).toContain("quantisation changed: Q4_K_M to Q8_0");
	});

	it("re-pin accepts the live identity and the warning stops", async () => {
		const h = home();
		await checkModel("ollama", M, { home: h, fetch: ollama(M, "aaa111bbb222", "Q4_K_M") });
		const live = ollama(M, "ccc333ddd444", "Q8_0");
		expect((await checkModel("ollama", M, { home: h, fetch: live })).status).toBe("changed");
		const rp = await repinModel("ollama", M, { home: h, fetch: live });
		expect(rp.status).toBe("pinned");
		expect((await checkModel("ollama", M, { home: h, fetch: live })).status).toBe("unchanged");
	});

	it("a cloud provider records provider and model id only, no digest, no network", async () => {
		const h = home();
		let calls = 0;
		const f = async () => {
			calls++;
			return new Response("{}");
		};
		const r = await checkModel("openrouter", "vendor/some-model", { home: h, fetch: f });
		expect(r.status).toBe("cloud");
		expect(calls).toBe(0);
		const pin = readLedger(h).pins["openrouter\nvendor/some-model"];
		expect(pin.cloud).toBe(true);
		expect(pin.digest).toBeUndefined();
		expect(
			(await checkModel("openrouter", "vendor/some-model", { home: h, fetch: f })).lines,
		).toEqual([]);
	});

	it("an unreachable provider is a plain note, never a throw, and writes nothing", async () => {
		const h = home();
		const r = await checkModel("ollama", M, {
			home: h,
			fetch: async () => {
				throw new Error("ECONNREFUSED");
			},
		});
		expect(r.status).toBe("unreachable");
		expect(r.lines.join(" ")).toContain("could not be read");
		expect(fs.existsSync(ledgerPath(h))).toBe(false);
	});

	it("a corrupt ledger file is treated as empty, not a crash", async () => {
		const h = home();
		fs.mkdirSync(path.dirname(ledgerPath(h)), { recursive: true });
		fs.writeFileSync(ledgerPath(h), "{not json");
		const r = await checkModel("ollama", M, {
			home: h,
			fetch: ollama(M, "aaa111bbb222", "Q4_K_M"),
		});
		expect(r.status).toBe("pinned");
	});

	it("LM Studio: quantisation from its model info, no digest claimed", async () => {
		const h = home();
		const f = async (url: string) =>
			url.includes("/api/v0/models")
				? new Response(JSON.stringify({ data: [{ id: M, quantization: "Q6_K", arch: "x" }] }))
				: new Response("no", { status: 404 });
		expect((await checkModel("lmstudio", M, { home: h, fetch: f })).status).toBe("pinned");
		const pin = readLedger(h).pins[`lmstudio\n${M}`];
		expect(pin.quant).toBe("Q6_K");
		expect(pin.digest).toBeUndefined();
		const f2 = async (url: string) =>
			url.includes("/api/v0/models")
				? new Response(JSON.stringify({ data: [{ id: M, quantization: "Q4_0" }] }))
				: new Response("no", { status: 404 });
		expect((await checkModel("lmstudio", M, { home: h, fetch: f2 })).status).toBe("changed");
	});

	it("no prompt text is ever stored: only the declared fields", async () => {
		const h = home();
		await checkModel("ollama", M, { home: h, fetch: ollama(M, "aaa111bbb222", "Q4_K_M") });
		const keys = Object.keys(readLedger(h).pins[`ollama\n${M}`]).sort();
		expect(keys).toEqual(["digest", "firstSeen", "model", "provider", "quant", "size"]);
	});

	it("doctor lines list pinned models and are empty with no ledger", async () => {
		const h = home();
		expect(modelLedgerDoctorLines(h)).toEqual([]);
		await checkModel("ollama", M, { home: h, fetch: ollama(M, "aaa111bbb222", "Q4_K_M") });
		await checkModel("openrouter", "vendor/x", { home: h, fetch: ollama(M, "a", "b") });
		const lines = modelLedgerDoctorLines(h).join("\n");
		expect(lines).toContain(M);
		expect(lines).toContain("aaa111bbb222".slice(0, 12));
		expect(lines).toContain("vendor/x");
		expect(lines).toContain("cloud");
	});
});
