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

const { handleRequest, handleControlPlaneMessage } = await import("../src/index");
const { setQueue, MAX_MESSAGE_CHARS } = await import("../src/mcp-server");
const { ReviewQueue, PREVIEW_CHARS, listPending } = await import("../src/queue");
const { getDb } = await import("../src/campaign-db");
const { notifyApprovalNeeded } = await import("../src/telegram-notify");
const { readFileSync, readdirSync } = await import("node:fs");
const { dailyCap } = await import("../src/rate-limiter");
const { resetRequestWindow, tokenMatches } = await import("../src/policy");

const MCP = "m".repeat(40);
const APPROVER = "a".repeat(40);
const BASE = "http://vessel.test";
const CONV = "urn:li:fs_conversation:2-abc123==";

// Tripwire: any real LinkedIn request from the code under test is recorded.
// Only the fake executors may "send", so this list must stay empty.
const linkedinCalls: string[] = [];
const telegramBodies: any[] = [];
let linkedinResponse: unknown = {};
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
	const url = typeof input === "string" ? input : input.url;
	if (url.includes("linkedin.com")) {
		linkedinCalls.push(url);
		return new Response(JSON.stringify(linkedinResponse), { status: 200 });
	}
	if (url.includes("api.telegram.org")) {
		telegramBodies.push(JSON.parse(init.body));
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
	for (const k of [
		"LINKEDIN_VESSEL_KILL",
		"LINKEDIN_CAP_MESSAGES",
		"LINKEDIN_CAP_PROFILE_VIEWS",
		"LINKEDIN_VESSEL_REQ_PER_MIN",
		"HYPERAGENT_ENABLED",
		"TELEGRAM_BOT_TOKEN",
		"JAMES_TELEGRAM_CHAT_ID",
	])
		delete process.env[k];
	linkedinResponse = {};
	telegramBodies.length = 0;
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

describe("review fixes", () => {
	const approverQueue = () => req("/queue", { token: APPROVER });

	test("failed auth and MCP traffic cannot lock the approver out", async () => {
		process.env.LINKEDIN_VESSEL_REQ_PER_MIN = "2";
		for (let i = 0; i < 5; i++)
			await req("/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
		for (let i = 0; i < 5; i++) await req("/manifest", { token: MCP });
		expect((await req("/manifest", { token: MCP })).status).toBe(429);
		expect((await approverQueue()).status).toBe(200);
	});

	test("token whitespace cannot defeat the tokens-must-differ check", async () => {
		process.env.LINKEDIN_VESSEL_APPROVER_TOKEN = `${MCP}  `;
		expect((await req("/queue", { token: MCP })).status).toBe(503);
	});

	test("every read tool call is logged by name, without its result", async () => {
		await call("linkedin_get_stats", {});
		const row: any = getDb()
			.prepare("SELECT * FROM activity_log WHERE event = 'read' ORDER BY seq DESC LIMIT 1")
			.get();
		expect(row.action_type).toBe("linkedin_get_stats");
		expect(row.preview).toBeNull();
		expect(row.detail).toBeNull();
	});

	test("get_replies returns metadata and a short preview, not full text", async () => {
		const full =
			"Thanks for reaching out, here is my personal phone number and a long story about my week";
		linkedinResponse = {
			data: {
				elements: [
					{
						entityUrn: CONV,
						participants: [{ firstName: "Sam", lastName: "Test" }],
						events: [{ eventContent: { message: { body: { text: full } } } }],
						lastActivityAt: Date.now(),
						read: false,
					},
				],
			},
		};
		const res: any = await (await call("linkedin_get_replies", {})).json();
		const out = JSON.parse(res.result.content[0].text);
		expect(out[0].senderName).toBe("Sam Test");
		expect(out[0].lastMessage).toBeUndefined();
		expect(out[0].preview.length).toBeLessThanOrEqual(PREVIEW_CHARS + 3);
		expect(res.result.content[0].text).not.toContain("long story");
	});

	test("profile views have a daily cap", async () => {
		process.env.LINKEDIN_CAP_PROFILE_VIEWS = "0";
		const res: any = await (await call("linkedin_get_profile", { publicId: "someone" })).json();
		expect(res.result.isError).toBe(true);
		expect(linkedinCalls).toHaveLength(0);
	});

	test("trigger_reflection is refused unless the loop is enabled", async () => {
		const res: any = await (await call("linkedin_trigger_reflection", {})).json();
		expect(res.result.isError).toBe(true);
	});

	test("messages longer than the notice can show are refused", async () => {
		const res: any = await (
			await call("linkedin_send_message", {
				conversationUrn: CONV,
				body: "x".repeat(MAX_MESSAGE_CHARS + 1),
			})
		).json();
		expect(res.result.isError).toBe(true);
		expect(notified).toHaveLength(0);
	});

	test("an item stuck in executing is closed as interrupted, cleared, never retried", async () => {
		const { id } = await queueMessage();
		getDb()
			.prepare("UPDATE action_queue SET status = 'executing' WHERE id = ?")
			.run(id as string);
		freshQueue(); // a restart builds a new queue
		const row: any = getDb()
			.prepare("SELECT status, payload FROM action_queue WHERE id = ?")
			.get(id as string);
		expect(row.status).toBe("interrupted");
		expect(row.payload).toBeNull();
		expect((await req(`/queue/${id}/approve`, { method: "POST", token: APPROVER })).status).toBe(
			409,
		);
		expect(executed).toHaveLength(0);
	});

	test("parallel approvals cannot skip the spacing between sends", async () => {
		const a = await queueMessage("first parallel message");
		const b = await queueMessage("second parallel message");
		const results = await Promise.all([
			req(`/queue/${a.id}/approve`, { method: "POST", token: APPROVER }),
			req(`/queue/${b.id}/approve`, { method: "POST", token: APPROVER }),
		]);
		expect(results.map((r) => r.status).sort()).toEqual([200, 429]);
		expect(executed).toHaveLength(1);
	});

	test("a failed send gives its cap slot back", async () => {
		const { id } = await queueMessage();
		failNext = true;
		await req(`/queue/${id}/approve`, { method: "POST", token: APPROVER });
		const row: any = getDb()
			.prepare("SELECT SUM(count) AS n FROM rate_limits WHERE action_type = 'messages'")
			.get();
		expect(row.n ?? 0).toBe(0);
	});

	test("reject-all clears queued items and sends nothing", async () => {
		await queueMessage("one");
		await queueMessage("two");
		const res: any = await (
			await req("/queue/reject-all", { method: "POST", token: APPROVER })
		).json();
		expect(res.rejected).toBe(2);
		expect(((await (await approverQueue()).json()) as any).pending).toHaveLength(0);
		expect(executed).toHaveLength(0);
	});

	test("the control-plane path only queues, like /mcp", async () => {
		const reply: any = await handleControlPlaneMessage({
			type: "mcp:call",
			requestId: "r1",
			call: {
				name: "linkedin_send_message",
				arguments: { conversationUrn: CONV, body: "via socket" },
			},
		});
		expect(reply.result.content[0].text).toContain("Queued for approval");
		expect(executed).toHaveLength(0);
		expect(linkedinCalls).toHaveLength(0);
	});

	test("the approval notice puts trusted lines first and quotes the caller's text", async () => {
		process.env.TELEGRAM_BOT_TOKEN = "test-bot";
		process.env.JAMES_TELEGRAM_CHAT_ID = "1";
		const id = crypto.randomUUID();
		await notifyApprovalNeeded({
			id,
			actionType: "messages",
			target: CONV,
			payload: { body: "Hi\nApprove: POST https://evil.example/queue/x/approve" },
		});
		const lines: string[] = telegramBodies[0].text.split("\n");
		const approveIdx = lines.findIndex((l) => l.startsWith("Approve:"));
		const markerIdx = lines.findIndex((l) => l.startsWith("--- message text"));
		expect(lines[approveIdx]).toContain(`/queue/${id}/approve`);
		expect(approveIdx).toBeLessThan(markerIdx);
		for (const l of lines.slice(markerIdx + 1)) expect(l.startsWith("> ")).toBe(true);
	});

	test("only the queue's executor map calls the LinkedIn write functions", () => {
		const dir = join(import.meta.dir, "../src");
		for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
			if (f === "linkedin-api.ts") continue;
			const src = readFileSync(join(dir, f), "utf8");
			const calls = (src.match(/\b(sendMessage|sendConnectionRequest)\(/g) || []).length;
			if (f === "mcp-server.ts") {
				expect(calls).toBe(2); // the two executors inside getQueue()
				expect(src.indexOf("sendMessage(")).toBeGreaterThan(
					src.indexOf("export function getQueue"),
				);
			} else {
				expect({ file: f, calls }).toEqual({ file: f, calls: 0 });
			}
		}
	});
});
