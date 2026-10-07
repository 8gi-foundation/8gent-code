/**
 * SSETransport follows HTTP redirects only within the configured origin.
 * Two local Bun.serve servers on 127.0.0.1 random ports; no outside network.
 */

import { afterAll, beforeEach, expect, test } from "bun:test";
import { MAX_REDIRECTS, SSETransport, sameOriginFetch } from "./transport";

type Hit = { path: string; method: string; body: string; apiKey: string | null };

const hitsA: Hit[] = [];
const hitsB: Hit[] = [];

async function record(req: Request, into: Hit[]): Promise<Hit> {
	const hit = {
		path: new URL(req.url).pathname,
		method: req.method,
		body: await req.text(),
		apiKey: req.headers.get("x-api-key"),
	};
	into.push(hit);
	return hit;
}

function rpcResult(hit: Hit): Response {
	const id = hit.body ? JSON.parse(hit.body).id : 0;
	return Response.json({ jsonrpc: "2.0", id, result: { path: hit.path, method: hit.method } });
}

const b = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(req) {
		return rpcResult(await record(req, hitsB));
	},
});

const a = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(req): Promise<Response> {
		const hit = await record(req, hitsA);
		const p = hit.path;
		if (p === "/cross-307")
			return new Response(null, { status: 307, headers: { location: `${b.url.origin}/target` } });
		if (p === "/same-307")
			return new Response(null, { status: 307, headers: { location: "/target" } });
		if (p === "/same-302")
			return new Response(null, { status: 302, headers: { location: `${a.url.origin}/target` } });
		if (p === "/same-303")
			return new Response(null, { status: 303, headers: { location: "target" } });
		const chain = p.match(/^\/chain\/(\d+)$/);
		if (chain) {
			const n = Number(chain[1]);
			const loc = n > 1 ? `/chain/${n - 1}` : "/target";
			return new Response(null, { status: 308, headers: { location: loc } });
		}
		return rpcResult(hit);
	},
});

afterAll(() => {
	a.stop(true);
	b.stop(true);
});

beforeEach(() => {
	hitsA.length = 0;
	hitsB.length = 0;
});

const headers = { "X-API-Key": "test-key" };

test("a 307 to another origin throws and the other server receives nothing", async () => {
	const t = new SSETransport(`${a.url.origin}/cross-307`, headers);
	await expect(t.send("tools/list", {})).rejects.toThrow(/different origin/);
	expect(hitsB.length).toBe(0);
});

test("notify does not follow a redirect to another origin", async () => {
	new SSETransport(`${a.url.origin}/cross-307`, headers).notify("notifications/initialized", {});
	await Bun.sleep(100);
	expect(hitsA.length).toBe(1);
	expect(hitsB.length).toBe(0);
});

test("a same-origin 307 resolves and the target receives the POST with its body", async () => {
	const t = new SSETransport(`${a.url.origin}/same-307`, headers);
	const result = (await t.send("tools/list", { cursor: "c1" })) as { path: string; method: string };
	expect(result).toEqual({ path: "/target", method: "POST" });
	const target = hitsA.find((h) => h.path === "/target");
	expect(target?.method).toBe("POST");
	expect(JSON.parse(target?.body ?? "{}")).toMatchObject({
		method: "tools/list",
		params: { cursor: "c1" },
	});
	expect(target?.apiKey).toBe("test-key");
	expect(hitsB.length).toBe(0);
});

test("a same-origin 302 after a POST is followed as a bodiless GET", async () => {
	const res = await sameOriginFetch(`${a.url.origin}/same-302`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }),
	});
	expect(res.status).toBe(200);
	const target = hitsA.find((h) => h.path === "/target");
	expect(target?.method).toBe("GET");
	expect(target?.body).toBe("");
	expect(target?.apiKey).toBe("test-key");
});

test("a same-origin 303 with a relative Location becomes a GET", async () => {
	const res = await sameOriginFetch(`${a.url.origin}/same-303`, { method: "POST", body: "{}" });
	expect(res.status).toBe(200);
	expect(hitsA.at(-1)).toMatchObject({ path: "/target", method: "GET", body: "" });
});

test(`exactly ${MAX_REDIRECTS} same-origin hops resolve`, async () => {
	const t = new SSETransport(`${a.url.origin}/chain/${MAX_REDIRECTS}`, headers);
	await expect(t.send("ping")).resolves.toEqual({ path: "/target", method: "POST" });
});

test(`more than ${MAX_REDIRECTS} hops throws`, async () => {
	const t = new SSETransport(`${a.url.origin}/chain/${MAX_REDIRECTS + 1}`, headers);
	await expect(t.send("ping")).rejects.toThrow(/more than 5 times/);
	expect(hitsA.some((h) => h.path === "/target")).toBe(false);
});
