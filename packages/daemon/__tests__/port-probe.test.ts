import { afterEach, describe, expect, it } from "bun:test";
import { createServer } from "node:net";
import { formatUptime, portVerdict, probePort } from "../port-probe";

const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => {
	for (const s of servers.splice(0)) s.stop(true);
});

function serve(handler: (req: Request) => Response) {
	const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handler });
	servers.push(s);
	return s.port as number;
}

async function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const srv = createServer().listen(0, "127.0.0.1", () => {
			const port = (srv.address() as { port: number }).port;
			srv.close(() => resolve(port));
		});
	});
}

const noHolder = () => null;

describe("probePort", () => {
	it("recognises a running 8gent daemon from its /health body", async () => {
		const port = serve(() => Response.json({ status: "ok", sessions: 3, uptime: 7384.2 }));
		expect(await probePort(port)).toEqual({ kind: "daemon", uptimeSeconds: 7384.2, sessions: 3 });
	});

	it("does not mistake another HTTP server for the daemon", async () => {
		const port = serve(() => Response.json({ status: "ok" }));
		expect((await probePort(port, { holder: noHolder })).kind).toBe("other");
		const port2 = serve(() => new Response("nope", { status: 404 }));
		expect((await probePort(port2, { holder: noHolder })).kind).toBe("other");
	});

	it("reports a listener that never speaks HTTP as taken", async () => {
		const srv = createServer(() => {}).listen(0, "127.0.0.1");
		await new Promise((r) => srv.once("listening", r));
		const port = (srv.address() as { port: number }).port;
		try {
			expect((await probePort(port, { timeoutMs: 200, holder: noHolder })).kind).toBe("other");
		} finally {
			srv.close();
		}
	});

	it("reports a free port as free", async () => {
		expect(await probePort(await freePort(), { timeoutMs: 500 })).toEqual({ kind: "free" });
	});
});

describe("portVerdict", () => {
	it("is a success when a daemon already answers", () => {
		const v = portVerdict(18789, { kind: "daemon", uptimeSeconds: 7384, sessions: 1 });
		expect(v).toEqual({
			message: "8gent is already running on 127.0.0.1:18789 (uptime 2h 3m). Nothing to do.",
			code: 0,
		});
	});

	it("fails and names the holder when something else has the port", () => {
		const v = portVerdict(18789, { kind: "other", holder: "node (pid 42)" });
		expect(v?.code).toBe(1);
		expect(v?.message).toContain("node (pid 42) is using port 18789");
		expect(portVerdict(18789, { kind: "other", holder: null })?.message).toContain(
			"Something else is using port 18789",
		);
	});

	it("lets a free port start the daemon", () => {
		expect(portVerdict(18789, { kind: "free" })).toBeNull();
	});
});

describe("formatUptime", () => {
	it("picks the two largest units", () => {
		expect(formatUptime(5)).toBe("5s");
		expect(formatUptime(125)).toBe("2m");
		expect(formatUptime(7384)).toBe("2h 3m");
		expect(formatUptime(200000)).toBe("2d 7h");
	});
});
