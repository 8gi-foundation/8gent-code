import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { requireToken } from "../origin-guard";

const stubPool = {
	size: 0,
	getStatus: () => ({}),
	createSession: () => {},
	chat: async () => "",
	destroySession: () => {},
	getActiveSessions: () => [],
};

async function startWith(env: string | undefined, port: number, authToken: string | null) {
	const prev = process.env.DAEMON_HOSTNAME;
	if (env === undefined) delete process.env.DAEMON_HOSTNAME;
	else process.env.DAEMON_HOSTNAME = env;
	try {
		const { startGateway } = await import("../gateway");
		// biome-ignore lint/suspicious/noExplicitAny: stub pool
		return startGateway({ port, authToken, pool: stubPool as any });
	} finally {
		if (prev === undefined) delete process.env.DAEMON_HOSTNAME;
		else process.env.DAEMON_HOSTNAME = prev;
	}
}

function firstReply(url: string, frame: object): Promise<{ type: string; [k: string]: unknown }> {
	const ws = new WebSocket(url);
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("no frame")), 5000);
		ws.onopen = () => ws.send(JSON.stringify(frame));
		ws.onmessage = (e) => {
			clearTimeout(t);
			ws.close();
			resolve(JSON.parse(String(e.data)));
		};
		ws.onerror = () => reject(new Error("socket error"));
	});
}

describe("requireToken", () => {
	const req = (h: Record<string, string> = {}, q = "") =>
		new Request(`http://127.0.0.1/computer${q}`, { headers: h });
	it("passes when no token is configured", () => {
		expect(requireToken(req(), null)).toBeNull();
	});
	it("401 without, 401 wrong, pass with header or query", () => {
		expect(requireToken(req(), "s3cret")?.status).toBe(401);
		expect(requireToken(req({ authorization: "Bearer nope" }), "s3cret")?.status).toBe(401);
		expect(requireToken(req({ authorization: "Bearer s3cret" }), "s3cret")).toBeNull();
		expect(requireToken(req({}, "?token=s3cret"), "s3cret")).toBeNull();
	});
});

describe("default bind", () => {
	const port = 19600 + Math.floor(Math.random() * 100);
	let server: { stop: () => void; hostname?: string } | null = null;
	afterAll(() => server?.stop());
	it("is loopback with no token, and still serves", async () => {
		server = await startWith(undefined, port, null);
		expect(server.hostname).toBe("127.0.0.1");
		const res = await fetch(`http://127.0.0.1:${port}/health`);
		expect(res.status).toBe(200);
		const reply = await firstReply(`ws://127.0.0.1:${port}`, {
			type: "session:create",
			channel: "browser",
		});
		expect(reply.type).toBe("session:created");
	});
});

describe("non-loopback bind", () => {
	it("refuses to start without a token", async () => {
		await expect(startWith("0.0.0.0", 19750, null)).rejects.toThrow(/without a token/);
	});

	describe("with a token", () => {
		const port = 19700 + Math.floor(Math.random() * 40);
		let server: { stop: () => void } | null = null;
		beforeAll(async () => {
			server = await startWith("0.0.0.0", port, "s3cret");
		});
		afterAll(() => server?.stop());

		it("rejects a frame without the token and accepts one after auth", async () => {
			const denied = await firstReply(`ws://127.0.0.1:${port}`, {
				type: "session:create",
				channel: "browser",
			});
			expect(denied.type).toBe("error");
			const ok = await firstReply(`ws://127.0.0.1:${port}`, { type: "auth", token: "s3cret" });
			expect(ok.type).toBe("auth:ok");
		});

		it("rejects /computer, /dispatch and /harness/run without the token", async () => {
			for (const [path, method] of [
				["/computer", "GET"],
				["/dispatch", "GET"],
				["/harness/run", "POST"],
			] as const) {
				const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
				expect(res.status).toBe(401);
			}
			const withToken = await fetch(`http://127.0.0.1:${port}/harnesses`, {
				headers: { authorization: "Bearer s3cret" },
			});
			expect(withToken.status).toBe(200);
		});
	});
});
