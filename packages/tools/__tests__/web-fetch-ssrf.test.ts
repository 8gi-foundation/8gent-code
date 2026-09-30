/**
 * #3233: web_fetch must not reach loopback, private, link-local or metadata
 * addresses, directly, through a redirect, or through DNS that changes its
 * answer between the check and the connection.
 *
 * Only `webFetch` is imported so this file loads on main, where every refusal
 * test below fails because main fetches anything and follows redirects.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { webFetch } from "../web";

type Call = { url: string; init: RequestInit & { tls?: { serverName?: string } } };

const PUBLIC_V4 = "93.184.216.34";
const html = (body: string) =>
	new Response(`<html><head><title>ok</title></head><body><p>${body}</p></body></html>`, {
		status: 200,
		headers: { "content-type": "text/html" },
	});
const redirect = (to: string, status = 302) =>
	new Response(null, { status, headers: { location: to } });

function recorder(respond: (url: string, n: number) => Response) {
	const calls: Call[] = [];
	const fetchImpl = async (url: string, init: RequestInit) => {
		calls.push({ url, init: init as Call["init"] });
		return respond(url, calls.length);
	};
	return { calls, fetchImpl };
}

let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response("DAEMON-SECRET-TOKEN", { headers: { "content-type": "text/plain" } }),
	});
});
afterAll(() => server.stop(true));

describe("webFetch refuses non-public destinations (#3233)", () => {
	test("loopback daemon port is refused and never read", async () => {
		const p = webFetch(`http://127.0.0.1:${server.port}/health`);
		await expect(p).rejects.toThrow(/loopback/);
	});

	test("decimal and short IPv4 spellings of loopback are refused", async () => {
		await expect(webFetch(`http://2130706433:${server.port}/`)).rejects.toThrow(/loopback/);
		await expect(webFetch(`http://127.1:${server.port}/`)).rejects.toThrow(/loopback/);
		await expect(webFetch(`http://0x7f.0.0.1:${server.port}/`)).rejects.toThrow(/loopback/);
	});

	test("IPv4-mapped IPv6 loopback is refused", async () => {
		await expect(webFetch(`http://[::ffff:127.0.0.1]:${server.port}/`)).rejects.toThrow(/loopback/);
	});

	test("localhost by name is refused", async () => {
		await expect(webFetch(`http://localhost:${server.port}/`)).rejects.toThrow(/Refused/);
		await expect(webFetch(`http://api.localhost:${server.port}/`)).rejects.toThrow(/Refused/);
	});

	test("cloud metadata, LAN and IPv6 metadata are refused before any connection", async () => {
		const { calls, fetchImpl } = recorder(() => html("should never be read"));
		const net = { fetchImpl };
		for (const url of [
			"http://169.254.169.254/latest/meta-data/",
			"http://[::ffff:a9fe:a9fe]/latest/meta-data/",
			"http://[fd00:ec2::254]/latest/meta-data/",
			"http://192.168.1.1/",
			"http://10.0.0.1/",
			"http://100.100.100.200/",
			"http://metadata.google.internal/computeMetadata/v1/",
		]) {
			await expect(webFetch(url, { net })).rejects.toThrow(/Refused/);
		}
		expect(calls).toHaveLength(0);
	});

	test("a public URL that redirects to loopback is refused at the redirect", async () => {
		const { calls, fetchImpl } = recorder(() => redirect(`http://127.0.0.1:${server.port}/health`));
		const resolve = async () => [{ address: PUBLIC_V4, family: 4 as const }];
		await expect(
			webFetch("https://docs.example/start", { net: { resolve, fetchImpl } }),
		).rejects.toThrow(/loopback/);
		expect(calls).toHaveLength(1);
	});

	test("a redirect to a name that resolves to metadata is refused", async () => {
		const { calls, fetchImpl } = recorder(() =>
			redirect("http://evil-rebind.example/latest/meta-data/"),
		);
		const resolve = async (h: string) =>
			h === "evil-rebind.example"
				? [{ address: "169.254.169.254", family: 4 as const }]
				: [{ address: PUBLIC_V4, family: 4 as const }];
		await expect(
			webFetch("https://docs.example/", { net: { resolve, fetchImpl } }),
		).rejects.toThrow(/169\.254\.169\.254/);
		expect(calls).toHaveLength(1);
	});

	test("redirect chains are capped at 5 hops", async () => {
		const { calls, fetchImpl } = recorder((_u, n) => redirect(`https://hop${n}.example/`, 301));
		const resolve = async () => [{ address: PUBLIC_V4, family: 4 as const }];
		await expect(
			webFetch("https://hop0.example/", { net: { resolve, fetchImpl } }),
		).rejects.toThrow(/more than 5 redirects/);
		expect(calls).toHaveLength(6);
	});
});

describe("DNS rebinding shapes (#3233)", () => {
	test("a mixed answer (public + loopback) refuses the host", async () => {
		const { calls, fetchImpl } = recorder(() => html("x"));
		const resolve = async () => [
			{ address: PUBLIC_V4, family: 4 as const },
			{ address: "127.0.0.1", family: 4 as const },
		];
		await expect(
			webFetch("http://rebind.example/", { net: { resolve, fetchImpl } }),
		).rejects.toThrow(/127\.0\.0\.1/);
		expect(calls).toHaveLength(0);
	});

	test("a mixed answer with an IPv6 loopback refuses the host", async () => {
		const { fetchImpl } = recorder(() => html("x"));
		const resolve = async () => [
			{ address: PUBLIC_V4, family: 4 as const },
			{ address: "::1", family: 6 as const },
		];
		await expect(
			webFetch("http://rebind.example/", { net: { resolve, fetchImpl } }),
		).rejects.toThrow(/::1/);
	});

	test("the connection goes to the checked address, not a second lookup", async () => {
		// First answer is public, every later answer is loopback: a rebinding
		// server. The request must go to the first (checked) address.
		let lookups = 0;
		const resolve = async () => {
			lookups++;
			return lookups === 1
				? [{ address: PUBLIC_V4, family: 4 as const }]
				: [{ address: "127.0.0.1", family: 4 as const }];
		};
		const { calls, fetchImpl } = recorder(() => html("public page"));
		const result = await webFetch("https://rebind.example/page?q=1", {
			net: { resolve, fetchImpl },
			extractMain: false,
		});
		expect(lookups).toBe(1);
		expect(calls).toHaveLength(1);
		expect(new URL(calls[0].url).hostname).toBe(PUBLIC_V4);
		expect(new URL(calls[0].url).pathname).toBe("/page");
		expect((calls[0].init.headers as Record<string, string>).Host).toBe("rebind.example");
		expect(calls[0].init.tls?.serverName).toBe("rebind.example");
		expect(calls[0].init.redirect).toBe("manual");
		expect(result.url).toBe("https://rebind.example/page?q=1");
		expect(result.content).toContain("public page");
	});

	test("a rebinding answer on the second hop is caught at that hop", async () => {
		let lookups = 0;
		const resolve = async () => {
			lookups++;
			return lookups === 1
				? [{ address: PUBLIC_V4, family: 4 as const }]
				: [{ address: "10.0.0.5", family: 4 as const }];
		};
		const { calls, fetchImpl } = recorder(() => redirect("/next"));
		await expect(
			webFetch("https://rebind.example/", { net: { resolve, fetchImpl } }),
		).rejects.toThrow(/private network/);
		expect(calls).toHaveLength(1);
	});
});

describe("public fetches still work (#3233)", () => {
	test("a public page is fetched and a public redirect is followed", async () => {
		const { calls, fetchImpl } = recorder((_u, n) =>
			n === 1 ? redirect("https://docs.example/v2/guide") : html("the guide"),
		);
		const resolve = async () => [
			{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 as const },
		];
		const result = await webFetch("docs.example/guide", {
			net: { resolve, fetchImpl },
			extractMain: false,
		});
		expect(calls).toHaveLength(2);
		expect(calls[1].url).toBe("https://[2606:2800:220:1:248:1893:25c8:1946]/v2/guide");
		expect(result.url).toBe("https://docs.example/v2/guide");
		expect(result.content).toContain("the guide");
	});
});
