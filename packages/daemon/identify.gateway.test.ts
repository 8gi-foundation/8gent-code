/** #4829: the daemon's identity proof, over a real gateway. */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPool } from "./agent-pool";
import { startGateway } from "./gateway";
import { daemonProof } from "./origin-guard";

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

/** Send one frame on a fresh socket, return the first reply. */
async function ask(
	cfg: { authToken: string | null; operatorToken?: string | null },
	frame: object,
) {
	const server = startGateway({ port: 0, pool, ...cfg });
	servers.push(server);
	const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
	const reply = new Promise<Record<string, unknown>>((resolve) => {
		ws.onmessage = (e) => resolve(JSON.parse(String(e.data)));
	});
	await new Promise<void>((r) => {
		ws.onopen = () => r();
	});
	ws.send(JSON.stringify(frame));
	const out = await reply;
	ws.close();
	return out;
}

describe("identify", () => {
	it("answers HMAC(operator token, nonce), and the secret itself is not in the reply", async () => {
		const r = await ask({ authToken: null, operatorToken: OP }, { type: "identify", nonce: NONCE });
		expect(r).toEqual({ type: "identify:ok", proof: daemonProof(OP, NONCE) });
		expect(JSON.stringify(r)).not.toContain(OP);
		expect(daemonProof(OP, NONCE)).not.toBe(daemonProof(OP, "cd".repeat(16)));
		expect(daemonProof(OP, NONCE)).not.toBe(daemonProof("3".repeat(64), NONCE));
	});

	it("answers before auth when a gateway token is set, keyed by that token", async () => {
		const r = await ask({ authToken: AUTH, operatorToken: OP }, { type: "identify", nonce: NONCE });
		expect(r).toEqual({ type: "identify:ok", proof: daemonProof(AUTH, NONCE) });
	});

	it("says it has no secret rather than proving with an empty one", async () => {
		const r = await ask({ authToken: null }, { type: "identify", nonce: NONCE });
		expect(r).toEqual({ type: "error", message: "this daemon has no identity secret" });
	});

	it("refuses a short, long, non-hex or missing nonce", async () => {
		for (const nonce of ["ab", "g".repeat(32), "a".repeat(129), undefined, 5]) {
			const r = await ask({ authToken: null, operatorToken: OP }, { type: "identify", nonce });
			expect(r.type).toBe("error");
		}
	});
});
