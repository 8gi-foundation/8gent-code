/** #4829: the daemon's identity proof, over a real gateway. */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPool } from "./agent-pool";
import { startGateway } from "./gateway";
import { daemonProof, dialTarget, identifyTargetOk } from "./origin-guard";

const NONCE = "ab".repeat(16);
const OP = "1".repeat(64);
const AUTH = "2".repeat(64);
const pool = { size: 0 } as unknown as AgentPool;
let dir: string;
const saved = { data: process.env.EIGHT_DATA_DIR, host: process.env.DAEMON_HOSTNAME };
const servers: Array<ReturnType<typeof Bun.serve>> = [];

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "identify-"));
	process.env.EIGHT_DATA_DIR = dir;
	process.env.DAEMON_HOSTNAME = "127.0.0.1";
});
afterAll(() => {
	for (const s of servers) s.stop(true);
	for (const [k, v] of [
		["EIGHT_DATA_DIR", saved.data],
		["DAEMON_HOSTNAME", saved.host],
	] as const) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(dir, { recursive: true, force: true });
});

/** Send one frame on a fresh socket (built from the gateway's real port), return the first reply. */
async function ask(
	cfg: { authToken: string | null; operatorToken?: string | null },
	frame: (port: number) => object,
) {
	const server = startGateway({ port: 0, pool, ...cfg });
	servers.push(server);
	const port = server.port as number;
	const ws = new WebSocket(`ws://127.0.0.1:${port}`);
	const reply = new Promise<Record<string, unknown>>((resolve) => {
		ws.onmessage = (e) => resolve(JSON.parse(String(e.data)));
	});
	await new Promise<void>((r) => {
		ws.onopen = () => r();
	});
	ws.send(JSON.stringify(frame(port)));
	const out = await reply;
	ws.close();
	return { out, port };
}
const hello = (port: number, over: Record<string, unknown> = {}) => ({
	type: "identify",
	nonce: NONCE,
	target: `127.0.0.1:${port}`,
	...over,
});

describe("identify", () => {
	it("answers HMAC(operator token, target, nonce), and the secret itself is not in the reply", async () => {
		const { out, port } = await ask({ authToken: null, operatorToken: OP }, (p) => hello(p));
		const target = `127.0.0.1:${port}`;
		expect(out).toEqual({ type: "identify:ok", proof: daemonProof(OP, NONCE, target) });
		expect(JSON.stringify(out)).not.toContain(OP);
		expect(daemonProof(OP, NONCE, target)).not.toBe(daemonProof(OP, "cd".repeat(16), target));
		expect(daemonProof(OP, NONCE, target)).not.toBe(daemonProof("3".repeat(64), NONCE, target));
		// The target is part of the proof: the same nonce for another address proves nothing here.
		expect(daemonProof(OP, NONCE, target)).not.toBe(daemonProof(OP, NONCE, "127.0.0.1:1"));
	});

	it("answers before auth when a gateway token is set, keyed by that token", async () => {
		const { out, port } = await ask({ authToken: AUTH, operatorToken: OP }, (p) => hello(p));
		expect(out).toEqual({
			type: "identify:ok",
			proof: daemonProof(AUTH, NONCE, `127.0.0.1:${port}`),
		});
	});

	it("a gateway bound to 127.0.0.1 proves for 127.0.0.1 only: not localhost, not [::1] on the same port", async () => {
		for (const host of ["localhost", "[::1]", "127.0.0.2"]) {
			const { out } = await ask({ authToken: null, operatorToken: OP }, (p) =>
				hello(p, { target: `${host}:${p}` }),
			);
			expect(out).toEqual({ type: "error", message: "identify target is not this daemon" });
		}
	});

	it("refuses a challenge dialled for another port, another host, or no target: a relay gets nothing", async () => {
		for (const over of [
			{ target: "127.0.0.1:1" },
			{ target: "127.0.0.1:18789" },
			{ target: "evil.example:80" },
			{ target: "evil.example" },
			{ target: undefined },
			{ target: 5 },
			{ target: "x".repeat(400) },
		]) {
			const { out } = await ask({ authToken: null, operatorToken: OP }, (p) => hello(p, over));
			expect(out).toEqual({ type: "error", message: "identify target is not this daemon" });
		}
	});

	it("says it has no secret rather than proving with an empty one", async () => {
		const { out } = await ask({ authToken: null }, (p) => hello(p));
		expect(out).toEqual({ type: "error", message: "this daemon has no identity secret" });
	});

	it("refuses a short, long, non-hex or missing nonce", async () => {
		for (const nonce of ["ab", "g".repeat(32), "a".repeat(129), undefined, 5]) {
			const { out } = await ask({ authToken: null, operatorToken: OP }, (p) => hello(p, { nonce }));
			expect(out.type).toBe("error");
		}
	});
});

describe("identifyTargetOk and dialTarget", () => {
	it("accepts the bound address exactly, and only on the daemon's own port", () => {
		expect(identifyTargetOk("127.0.0.1:5", 5, "127.0.0.1", true)).toBe(true);
		expect(identifyTargetOk("127.0.0.1:6", 5, "127.0.0.1", true)).toBe(false);
		expect(identifyTargetOk("127.0.0.1", 5, "127.0.0.1", true)).toBe(false);
		expect(identifyTargetOk("127.0.0.1:5/../x", 5, "127.0.0.1", true)).toBe(false);
	});

	it("refuses every other loopback alias: a squatter on [::1] or localhost cannot ride on 127.0.0.1", () => {
		for (const t of ["localhost:5", "[::1]:5", "127.0.0.2:5", "LOCALHOST:5"]) {
			expect(identifyTargetOk(t, 5, "127.0.0.1", true)).toBe(false);
		}
		// A daemon bound to ::1 is reached at [::1], and only there.
		expect(identifyTargetOk("[::1]:5", 5, "::1", true)).toBe(true);
		expect(identifyTargetOk("127.0.0.1:5", 5, "::1", true)).toBe(false);
		// localhost is a name: a daemon bound to it is dialled at 127.0.0.1.
		expect(identifyTargetOk("127.0.0.1:5", 5, "localhost", true)).toBe(true);
		expect(identifyTargetOk("localhost:5", 5, "localhost", true)).toBe(false);
	});

	it("a wildcard bind is reached at 127.0.0.1 only (both loopbacks for the dual-stack ::)", () => {
		expect(identifyTargetOk("127.0.0.1:5", 5, "0.0.0.0", true)).toBe(true);
		expect(identifyTargetOk("[::1]:5", 5, "0.0.0.0", true)).toBe(false);
		expect(identifyTargetOk("10.0.0.7:5", 5, "0.0.0.0", true)).toBe(false);
		expect(identifyTargetOk("[::1]:5", 5, "::", true)).toBe(true);
		expect(identifyTargetOk("127.0.0.1:5", 5, "::", true)).toBe(true);
	});

	it("a loopback target from a peer that is not on loopback is refused", () => {
		expect(identifyTargetOk("127.0.0.1:5", 5, "127.0.0.1", false)).toBe(false);
		expect(identifyTargetOk("127.0.0.1:5", 5, "0.0.0.0", false)).toBe(false);
		expect(identifyTargetOk("[::1]:5", 5, "::", false)).toBe(false);
		// A bound non-loopback address is the one thing a remote peer may have dialled.
		expect(identifyTargetOk("10.0.0.7:5", 5, "10.0.0.7", false)).toBe(true);
		expect(identifyTargetOk("10.0.0.8:5", 5, "10.0.0.7", false)).toBe(false);
	});

	it("names what a client dialled, default ports filled in", () => {
		expect(dialTarget("ws://127.0.0.1:18790")).toBe("127.0.0.1:18790");
		expect(dialTarget("ws://LOCALHOST")).toBe("localhost:80");
		expect(dialTarget("wss://example.test/x?t=1#y")).toBe("example.test:443");
		expect(dialTarget("ws://[::1]:9")).toBe("[::1]:9");
	});
});
