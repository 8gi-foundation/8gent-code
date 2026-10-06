import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolated DB, set before any vessel module opens it.
const dataDir = mkdtempSync(join(tmpdir(), "linkedin-vessel-test-"));
process.env.EIGHT_DATA_DIR = dataDir;
for (const k of ["LINKEDIN_JSESSIONID", "TELEGRAM_BOT_TOKEN", "CONTROL_PLANE_URL"]) {
	delete process.env[k];
}

const { handleRequest } = await import("../src/index");
const { setQueue } = await import("../src/mcp-server");
const { ReviewQueue, PREVIEW_CHARS, listPending } = await import("../src/queue");
const { getDb } = await import("../src/campaign-db");
const { dailyCap } = await import("../src/rate-limiter");
const { resetRequestWindow, tokenMatches } = await import("../src/policy");

const MCP = "m".repeat(40);
const APPROVER = "a".repeat(40);
const BASE = "http://vessel.test";
const CONV = "urn:li:fs_conversation:2-abc123==";

// Tripwire: any real LinkedIn request from the code under test is recorded.
// Only the fake executors may "send", so this list must stay empty.
const linkedinCalls: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
	const url = typeof input === "string" ? input : input.url;
	if (url.includes("linkedin.com")) {
		linkedinCalls.push(url);
		return new Response("{}", { status: 200 });
	}
	return realFetch(input, init);
}) as typeof fetch;
process.env.LINKEDIN_SESSION_COOKIE = "test-cookie-not-real";

let executed: Array<{ type: string; payload: Record<string, string> }> = [];
let notified: string[] = [];
let failNext = false;

function freshQueue(): void {
	const fake = (type: string) => async (payload: Record<string, string>) => {
		if (failNext) {
			failNext = false;
			return { success: false, error: "LinkedIn API POST 500: /messaging/conversations" };
		}
		executed.push({ type, payload });
		return { success: true };
	};
	setQueue(
		new ReviewQueue(
			"test",
			{ connection_requests: fake("connection_requests"), messages: fake("messages") },
			async (item) => {
				notified.push(item.id);
			},
		),
	);
}

function req(
	path: string,
	opts: { method?: string; token?: string; body?: unknown; raw?: string } = {},
) {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (opts.token) headers.authorization = `Bearer ${opts.token}`;
	return handleRequest(
		new Request(`${BASE}${path}`, {
			method: opts.method ?? (opts.body !== undefined || opts.raw !== undefined ? "POST" : "GET"),
			headers,
			body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
		}),
	);
}

function call(name: string, args: Record<string, unknown>, token = MCP) {
	return req("/mcp", {
		token,
		body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
	});
}

async function queueMessage(
	body = "Hello there, this is a fairly long message body for testing purposes.",
) {
	const res = await call("linkedin_send_message", { conversationUrn: CONV, body });
	const json: any = await res.json();
	const id = /id ([0-9a-f-]{36})/.exec(json.result.content[0].text)?.[1];
	return { json, id };
}

beforeEach(() => {
	process.env.LINKEDIN_VESSEL_MCP_TOKEN = MCP;
	process.env.LINKEDIN_VESSEL_APPROVER_TOKEN = APPROVER;
	for (const k of ["LINKEDIN_VESSEL_KILL", "LINKEDIN_CAP_MESSAGES", "LINKEDIN_VESSEL_REQ_PER_MIN"])
		delete process.env[k];
	resetRequestWindow();
	executed = [];
	notified = [];
	linkedinCalls.length = 0;
	failNext = false;
	listPending(); // ensures the queue tables exist
	const db = getDb();
	db.exec("DELETE FROM action_queue; DELETE FROM rate_limits;");
	freshQueue();
});

afterAll(() => {
	globalThis.fetch = realFetch;
	delete process.env.LINKEDIN_SESSION_COOKIE;
	rmSync(dataDir, { recursive: true, force: true });
});

describe("auth", () => {
	test("health is public and does not list tools", async () => {
		const res = await req("/health");
		expect(res.status).toBe(200);
		const body: any = await res.json();
		expect(body.tools).toBeUndefined();
		expect(body.paused).toBe(false);
	});

	test("/mcp fails closed when no token is configured", async () => {
		delete process.env.LINKEDIN_VESSEL_MCP_TOKEN;
		const res = await req("/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
		expect(res.status).toBe(503);
	});

	test("/mcp fails closed when the token is too short", async () => {
		process.env.LINKEDIN_VESSEL_MCP_TOKEN = "short";
		const res = await req("/mcp", {
			token: "short",
			body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
		});
		expect(res.status).toBe(503);
	});

	test("/mcp rejects a missing or wrong bearer token", async () => {
		const none = await req("/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
		expect(none.status).toBe(401);
		expect(none.headers.get("www-authenticate")).toContain("Bearer");
		const wrong = await req("/mcp", {
			token: "x".repeat(40),
			body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
		});
		expect(wrong.status).toBe(401);
	});

	test("unauthenticated tools/call never reaches a tool", async () => {
		const res = await call(
			"linkedin_send_message",
			{ conversationUrn: CONV, body: "hi" },
			"nope".repeat(10),
		);
		expect(res.status).toBe(401);
		expect(notified).toHaveLength(0);
	});

	test("/mcp accepts the right token", async () => {
		const res = await req("/mcp", {
			token: MCP,
			body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
		});
		expect(res.status).toBe(200);
		const body: any = await res.json();
		expect(body.result.tools.length).toBeGreaterThan(0);
	});

	test("/manifest needs the MCP token", async () => {
		expect((await req("/manifest")).status).toBe(401);
		expect((await req("/manifest", { token: MCP })).status).toBe(200);
	});

	test("roles are separate: MCP token cannot approve, approver token cannot call tools", async () => {
		expect((await req("/queue", { token: MCP })).status).toBe(401);
		expect((await req("/activity", { token: MCP })).status).toBe(401);
		const { id } = await queueMessage();
		expect((await req(`/queue/${id}/approve`, { method: "POST", token: MCP })).status).toBe(401);
		expect(executed).toHaveLength(0);
		const res = await req("/mcp", {
			token: APPROVER,
			body: { jsonrpc: "2.0", id: 1, method: "tools/list" },
		});
		expect(res.status).toBe(401);
	});

	test("approver routes refuse to run when both tokens are equal", async () => {
		process.env.LINKEDIN_VESSEL_APPROVER_TOKEN = MCP;
		expect((await req("/queue", { token: MCP })).status).toBe(503);
	});

	test("malformed JSON is a 400, not a crash", async () => {
		const res = await req("/mcp", { token: MCP, raw: "{not json" });
		expect(res.status).toBe(400);
	});

	test("request rate limit returns 429", async () => {
		process.env.LINKEDIN_VESSEL_REQ_PER_MIN = "2";
		await req("/manifest", { token: MCP });
		await req("/manifest", { token: MCP });
		const third = await req("/manifest", { token: MCP });
		expect(third.status).toBe(429);
	});

	test("tokenMatches handles different lengths", () => {
		expect(tokenMatches("abc", "abcd")).toBe(false);
		expect(tokenMatches(MCP, MCP)).toBe(true);
	});
});

describe("review queue", () => {
	test("send_message queues, notifies, and sends nothing", async () => {
		const { json, id } = await queueMessage();
		expect(json.result.isError).toBeUndefined();
		expect(id).toBeDefined();
		expect(notified).toEqual([id as string]);
		expect(executed).toHaveLength(0);
		expect(linkedinCalls).toHaveLength(0);

		const pending: any = await (await req("/queue", { token: APPROVER })).json();
		expect(pending.pending).toHaveLength(1);
		expect(pending.pending[0].payload.body).toContain("fairly long message");
	});

	test("send_connection queues too, and validates input", async () => {
		const bad = await call("linkedin_send_connection", { profileUrn: "not-a-urn", note: "hi" });
		expect(((await bad.json()) as any).result.isError).toBe(true);
		const long = await call("linkedin_send_connection", {
			profileUrn: "urn:li:fsd_profile:ABC",
			note: "x".repeat(301),
		});
		expect(((await long.json()) as any).result.isError).toBe(true);
		const ok = await call("linkedin_send_connection", {
			profileUrn: "urn:li:fsd_profile:ABC",
			note: "Hi Sam",
		});
		expect(((await ok.json()) as any).result.content[0].text).toContain("Queued for approval");
		expect(executed).toHaveLength(0);
		expect(linkedinCalls).toHaveLength(0);
	});

	test("approve runs the action once and clears the stored text", async () => {
		const { id } = await queueMessage();
		const res = await req(`/queue/${id}/approve`, { method: "POST", token: APPROVER });
		expect(res.status).toBe(200);
		expect(executed).toEqual([
			{ type: "messages", payload: { conversationUrn: CONV, body: expect.any(String) } },
		]);

		const row: any = getDb()
			.prepare("SELECT status, payload FROM action_queue WHERE id = ?")
			.get(id as string);
		expect(row.status).toBe("executed");
		expect(row.payload).toBeNull();

		const again = await req(`/queue/${id}/approve`, { method: "POST", token: APPROVER });
		expect(again.status).toBe(409);
		expect(executed).toHaveLength(1);
	});

	test("reject sends nothing", async () => {
		const { id } = await queueMessage();
		const res = await req(`/queue/${id}/reject`, { method: "POST", token: APPROVER });
		expect(res.status).toBe(200);
		expect(executed).toHaveLength(0);
		expect((await req(`/queue/${id}/approve`, { method: "POST", token: APPROVER })).status).toBe(
			409,
		);
	});

	test("unknown id is a 404", async () => {
		const res = await req(`/queue/${crypto.randomUUID()}/approve`, {
			method: "POST",
			token: APPROVER,
		});
		expect(res.status).toBe(404);
	});

	test("a failed send is recorded as failed and not retried", async () => {
		const { id } = await queueMessage();
		failNext = true;
		const res = await req(`/queue/${id}/approve`, { method: "POST", token: APPROVER });
		expect(res.status).toBe(502);
		const row: any = getDb()
			.prepare("SELECT status FROM action_queue WHERE id = ?")
			.get(id as string);
		expect(row.status).toBe("failed");
	});

	test("spacing: a second send too soon stays pending with Retry-After", async () => {
		const a = await queueMessage("first message body here");
		const b = await queueMessage("second message body here");
		expect((await req(`/queue/${a.id}/approve`, { method: "POST", token: APPROVER })).status).toBe(
			200,
		);
		const res = await req(`/queue/${b.id}/approve`, { method: "POST", token: APPROVER });
		expect(res.status).toBe(429);
		expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
		expect(executed).toHaveLength(1);
		const row: any = getDb()
			.prepare("SELECT status FROM action_queue WHERE id = ?")
			.get(b.id as string);
		expect(row.status).toBe("pending");
	});

	test("daily cap counts queued items and refuses beyond it", async () => {
		process.env.LINKEDIN_CAP_MESSAGES = "1";
		const first = await queueMessage();
		expect(first.id).toBeDefined();
		const second = await queueMessage();
		expect(second.json.result.isError).toBe(true);
		expect(second.json.result.content[0].text).toContain("Daily cap");
	});

	test("env can lower a cap but never raise it", () => {
		process.env.LINKEDIN_CAP_MESSAGES = "999";
		expect(dailyCap("messages")).toBe(50);
		process.env.LINKEDIN_CAP_MESSAGES = "5";
		expect(dailyCap("messages")).toBe(5);
	});

	test("pending items expire after 24h and cannot be approved", async () => {
		const { id } = await queueMessage();
		const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
		getDb()
			.prepare("UPDATE action_queue SET created_at = ? WHERE id = ?")
			.run(old, id as string);
		const res = await req(`/queue/${id}/approve`, { method: "POST", token: APPROVER });
		expect(res.status).toBe(409);
		expect(executed).toHaveLength(0);
	});
});

describe("kill switch", () => {
	test("stops tool calls and approvals", async () => {
		const { id } = await queueMessage();
		process.env.LINKEDIN_VESSEL_KILL = "1";
		const res = await call("linkedin_get_stats", {});
		expect(((await res.json()) as any).result.isError).toBe(true);
		expect((await req(`/queue/${id}/approve`, { method: "POST", token: APPROVER })).status).toBe(
			503,
		);
		expect(executed).toHaveLength(0);
		expect(((await (await req("/health")).json()) as any).paused).toBe(true);
	});
});

describe("activity log", () => {
	test("holds previews only and is append-only", async () => {
		const body = "SECRET-TAIL ".repeat(3) + "this part must never be stored in the log at all";
		const { id } = await queueMessage(body);
		await req(`/queue/${id}/approve`, { method: "POST", token: APPROVER });

		const log: any = await (await req("/activity", { token: APPROVER })).json();
		const mine = log.activity.filter((r: any) => r.queue_id === id);
		expect(mine.map((r: any) => r.event).sort()).toEqual(["approved", "executed", "queued"]);
		const dump = JSON.stringify(log);
		expect(dump).not.toContain("never be stored");
		for (const r of log.activity) {
			if (r.preview) expect(r.preview.length).toBeLessThanOrEqual(PREVIEW_CHARS + 3);
		}

		expect(() => getDb().exec("UPDATE activity_log SET event = 'x'")).toThrow(/append-only/);
		expect(() => getDb().exec("DELETE FROM activity_log")).toThrow(/append-only/);
	});
});
