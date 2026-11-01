/**
 * #4829 (epic #4792, slice 1): the TUI attaches to a running local daemon on its
 * own. These tests cover the decision (opt-out, typed-turn guard) and the probe,
 * and run the probe against the real daemon gateway's /health, the path that ships.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPool } from "../../../../packages/daemon/agent-pool";
import { startGateway } from "../../../../packages/daemon/gateway";
import {
	PROBE_BUDGET_MS,
	autoAttachAllowed,
	autoAttachMode,
	daemonHealthUrl,
	hasTypedTurn,
	probeDaemon,
} from "./daemon-autoattach";

describe("autoAttachMode", () => {
	it("is off unless EIGHT_TUI_DAEMON opts in", () => {
		expect(autoAttachMode({})).toBe("off");
		for (const v of ["auto", "AUTO", "on", "1", "true", "yes", " auto "]) {
			expect(autoAttachMode({ EIGHT_TUI_DAEMON: v })).toBe("auto");
		}
		for (const v of ["off", "0", "false", "no", "nonsense", ""]) {
			expect(autoAttachMode({ EIGHT_TUI_DAEMON: v })).toBe("off");
		}
	});
});

describe("auto-attach never leaves this machine (8SO, #4830)", () => {
	const on = { EIGHT_TUI_DAEMON: "auto" };
	it("allows the default and loopback urls only", () => {
		expect(autoAttachAllowed(on)).toBe(true);
		for (const u of [
			"ws://127.0.0.1:18790",
			"ws://localhost:1",
			"ws://[::1]:18789",
			"wss://127.0.0.1:2",
		]) {
			expect(autoAttachAllowed({ ...on, EIGHT_DAEMON_URL: u })).toBe(true);
		}
	});
	it("refuses a remote host, a lookalike, credentials in the url, a non-socket url and garbage", () => {
		for (const u of [
			"ws://example.com:18789",
			"ws://192.168.1.5:18789",
			"ws://127.0.0.1.evil.example:18789",
			"ws://evil.example/127.0.0.1",
			"ws://user:pw@127.0.0.1:18789",
			"http://127.0.0.1:18789",
			"ws://0.0.0.0:18789",
			"not a url",
		]) {
			expect(autoAttachAllowed({ ...on, EIGHT_DAEMON_URL: u })).toBe(false);
		}
	});
	it("is off when not opted in, even for loopback", () => {
		expect(autoAttachAllowed({})).toBe(false);
		expect(autoAttachAllowed({ EIGHT_TUI_DAEMON: "off" })).toBe(false);
	});
});

describe("daemonHealthUrl", () => {
	it("maps the daemon socket url to its /health url", () => {
		expect(daemonHealthUrl({})).toBe("http://127.0.0.1:18789/health");
		expect(daemonHealthUrl({ EIGHT_DAEMON_URL: "ws://127.0.0.1:18790" })).toBe(
			"http://127.0.0.1:18790/health",
		);
		expect(daemonHealthUrl({ EIGHT_DAEMON_URL: "wss://example.test/ws?token=x#y" })).toBe(
			"https://example.test/health",
		);
	});
});

describe("hasTypedTurn", () => {
	it("is true only for a message the person sent this run", () => {
		expect(hasTypedTurn([])).toBe(false);
		expect(hasTypedTurn([{ id: "restored-0", role: "user" }])).toBe(false);
		expect(hasTypedTurn([{ id: "system-1", role: "system" }])).toBe(false);
		expect(hasTypedTurn([{ id: "user-170", role: "user" }])).toBe(true);
		expect(hasTypedTurn([{ id: "voice-user-170", role: "user" }])).toBe(true);
	});
});

const ok =
	(body: unknown, status = 200) =>
	async () =>
		new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

describe("probeDaemon (stubbed fetch)", () => {
	const url = "http://127.0.0.1:18789/health";
	it("is true for the daemon's own /health shape", async () => {
		expect(await probeDaemon(url, { fetch: ok({ status: "ok", sessions: 1, uptime: 5 }) })).toBe(
			true,
		);
	});
	it("is false for a refused connection, a bad status, a non-JSON body or another service", async () => {
		const refused = async () => {
			throw new Error("ECONNREFUSED");
		};
		expect(await probeDaemon(url, { fetch: refused })).toBe(false);
		expect(
			await probeDaemon(url, { fetch: ok({ status: "ok", sessions: 1, uptime: 5 }, 503) }),
		).toBe(false);
		expect(await probeDaemon(url, { fetch: ok("<html>hello</html>") })).toBe(false);
		expect(await probeDaemon(url, { fetch: ok({ status: "ok" }) })).toBe(false);
		expect(await probeDaemon(url, { fetch: ok({ status: "down", sessions: 1, uptime: 5 }) })).toBe(
			false,
		);
	});
	it("gives up after the budget even when fetch ignores the abort signal", async () => {
		const hang = () => new Promise<Response>(() => {});
		const t0 = Date.now();
		expect(await probeDaemon(url, { fetch: hang, timeoutMs: 80 })).toBe(false);
		expect(Date.now() - t0).toBeLessThan(500);
	});
	it("keeps a budget under a second so the first screen never waits on it", () => {
		expect(PROBE_BUDGET_MS).toBeLessThanOrEqual(1000);
	});
});

describe("probeDaemon against the real gateway", () => {
	let server: ReturnType<typeof Bun.serve>;
	let dataDir: string;
	const saved = { data: process.env.EIGHT_DATA_DIR, host: process.env.DAEMON_HOSTNAME };
	const pool = { size: 0 } as unknown as AgentPool;

	beforeAll(() => {
		dataDir = mkdtempSync(join(tmpdir(), "tui-autoattach-"));
		process.env.EIGHT_DATA_DIR = dataDir;
		process.env.DAEMON_HOSTNAME = "127.0.0.1";
		server = startGateway({ port: 0, authToken: null, pool });
	});
	afterAll(() => {
		server.stop(true);
		for (const [k, v] of [
			["EIGHT_DATA_DIR", saved.data],
			["DAEMON_HOSTNAME", saved.host],
		] as const) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(dataDir, { recursive: true, force: true });
	});

	it("finds a running daemon, and finds nothing once it is stopped", async () => {
		const wsUrl = `ws://127.0.0.1:${server.port}`;
		expect(await probeDaemon(daemonHealthUrl({ EIGHT_DAEMON_URL: wsUrl }))).toBe(true);
		const port = server.port;
		server.stop(true);
		expect(await probeDaemon(daemonHealthUrl({ EIGHT_DAEMON_URL: `ws://127.0.0.1:${port}` }))).toBe(
			false,
		);
		server = startGateway({ port: 0, authToken: null, pool });
	});
});
