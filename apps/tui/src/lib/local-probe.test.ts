import { expect, test } from "bun:test";
import { type ProbeFetch, probeLocalEndpoints } from "./local-probe.js";

const json = (body: unknown) => ({ ok: true, json: async () => body });

test("answers at each url's index; a refused or non-ok endpoint is null", async () => {
	const fake: ProbeFetch = async (u) => {
		if (u.includes("1234")) return json({ data: [{ id: "m" }] });
		if (u.includes("11434")) return { ok: false, json: async () => ({}) };
		throw new Error("ECONNREFUSED");
	};
	const out = await probeLocalEndpoints(
		["http://localhost:1234/v1/models", "http://localhost:11434/api/tags", "http://localhost:9/x"],
		{ fetch: fake },
	);
	expect(out).toEqual([{ data: [{ id: "m" }] }, null, null]);
});

test("a server that never answers costs one bound, not a hang", async () => {
	const hang: ProbeFetch = (_u, { signal }) =>
		new Promise((_r, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
	const t0 = Date.now();
	const out = await probeLocalEndpoints(["http://a/", "http://b/", "http://c/"], {
		fetch: hang,
		timeoutMs: 150,
	});
	expect(out).toEqual([null, null, null]);
	// All three run at once: about one bound in total.
	expect(Date.now() - t0).toBeLessThan(1500);
});

test("asks the real endpoint in this process", async () => {
	const server = Bun.serve({ port: 0, fetch: () => Response.json({ models: [{ name: "q:1b" }] }) });
	try {
		const out = await probeLocalEndpoints([`http://127.0.0.1:${server.port}/api/tags`]);
		expect(out).toEqual([{ models: [{ name: "q:1b" }] }]);
	} finally {
		server.stop(true);
	}
});
