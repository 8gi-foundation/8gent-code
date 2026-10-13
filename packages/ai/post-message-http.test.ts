/**
 * post_message direct send (#3838): the bot key comes from the env file the
 * person names in settings (postMessage.botEnvFile) and goes straight to the
 * Bot API. Driven through ToolExecutor against a local stub server. The key
 * must never show up in what the model sends or sees, in the turn journal, in
 * the send log or in the gate audit log.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY = "987654321:ZZstubKeyNeverLeavesTheProcess_0042";
const CHAT = "-1004417730052";

// Everything this suite writes lives under one temp root, set before the
// gate module loads (its audit path is fixed at import).
const root = mkdtempSync(join(tmpdir(), "post-message-http-"));
const home = join(root, "home");
const work = join(root, "work");
const data = join(root, "data");
const turns = join(root, "turns");
for (const d of [home, work, data, turns, join(home, ".8gent"), join(home, ".config", "bot")])
	mkdirSync(d, { recursive: true });
const envFile = join(home, ".config", "bot", "bot.env");
writeFileSync(envFile, `# posting key\nexport TG_KEY="${KEY}"\nOTHER=1\n`);
writeFileSync(
	join(home, ".8gent", "settings.json"),
	JSON.stringify({
		postMessage: {
			allowedChats: [CHAT],
			botEnvFile: "~/.config/bot/bot.env",
			botTokenVar: "TG_KEY",
		},
	}),
);

type Hit = { path: string; body: { chat_id?: string; text?: string } };
const hits: Hit[] = [];
let reply: (path: string) => Response = () =>
	Response.json({ ok: true, result: { message_id: 4242 } });
const stub = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(req) {
		const path = new URL(req.url).pathname;
		hits.push({ path, body: await req.json().catch(() => ({})) });
		return reply(path);
	},
});

const saved = {
	HOME: process.env.HOME,
	EIGHT_FAKE_HOME: process.env.EIGHT_FAKE_HOME,
	EIGHT_DATA_DIR: process.env.EIGHT_DATA_DIR,
	EIGHT_TG_BIN_DIR: process.env.EIGHT_TG_BIN_DIR,
	EIGHT_TG_API_BASE: process.env.EIGHT_TG_API_BASE,
};
process.env.HOME = home;
process.env.EIGHT_FAKE_HOME = home;
process.env.EIGHT_DATA_DIR = data;
process.env.EIGHT_TG_BIN_DIR = join(root, "no-helpers"); // no tg-group: direct send only
process.env.EIGHT_TG_API_BASE = `http://127.0.0.1:${stub.port}`;

const { _snapshotAllowedChats, checkApiBase } = await import("./post-message");
const { _resetTuiApprovalChannel, registerTuiApprovalHandler } = await import(
	"../permissions/tui-approval-channel"
);
const { ToolExecutor } = await import("../eight/tools");
const { TurnJournal } = await import("../eight/turn-journal");
_snapshotAllowedChats();

// Console output is a log too: capture it for the whole suite.
const consoleOut: string[] = [];
const original = { log: console.log, warn: console.warn, error: console.error };
for (const k of ["log", "warn", "error"] as const)
	console[k] = (...a: unknown[]) => {
		consoleOut.push(a.map(String).join(" "));
	};

afterEach(() => {
	_snapshotAllowedChats();
	_resetTuiApprovalChannel();
	hits.length = 0;
	reply = () => Response.json({ ok: true, result: { message_id: 4242 } });
});
afterAll(() => {
	Object.assign(console, original);
	stub.stop(true);
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) Reflect.deleteProperty(process.env, k);
		else process.env[k] = v;
	}
	rmSync(root, { recursive: true, force: true });
});

const approve = () => registerTuiApprovalHandler(async () => "approve");

/** Every file under a directory, concatenated. */
function readTree(dir: string): string {
	let out = "";
	for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
		if (e.isFile()) out += readFileSync(join(e.parentPath, e.name), "utf8");
	}
	return out;
}

describe("post_message direct send (#3838)", () => {
	test("offered with no helper installed, and the model-facing schema holds no key or key path", () => {
		const defs = JSON.stringify(new ToolExecutor(work, "http-defs").getToolDefinitions());
		expect(defs).toContain('"post_message"');
		expect(defs).toContain("text_file");
		expect(defs).not.toContain(KEY);
		expect(defs).not.toContain(envFile);
	});

	test("happy path: posts to the stub, returns its message id; key in no args, result or log", async () => {
		approve();
		const args = { chat: CHAT, text: "caption for the practice chat" };
		const exec = new ToolExecutor(work, "http-happy");
		const started = Date.now();
		const out = await exec.execute("post_message", args);

		expect(out).toBe(`Posted message to ${CHAT}, message_id 4242.`);
		expect(hits).toEqual([
			{
				path: `/bot${KEY}/sendMessage`,
				body: { chat_id: CHAT, text: "caption for the practice chat" },
			},
		]);

		// The session record of this turn, as the loop writes it.
		const journal = new TurnJournal("http-happy", turns);
		await journal.write({
			sessionId: "http-happy",
			turnIndex: 0,
			startedAt: new Date(started).toISOString(),
			finishedAt: new Date().toISOString(),
			input: { role: "user", content: "post the caption" },
			systemPromptHash: "x",
			systemPromptLength: 0,
			toolCalls: [
				{
					id: "c1",
					name: "post_message",
					args,
					resultPreview: TurnJournal.clampToolPreview(out),
					durationMs: Date.now() - started,
					cached: false,
					redacted: false,
				},
			],
			modelOutput: { content: "sent", tokens: { in: 0, out: 0, total: 0 } },
			latencyMs: 0,
			status: "ok",
		});

		expect(JSON.stringify(args)).not.toContain(KEY);
		expect(out).not.toContain(KEY);
		expect(readTree(turns)).toContain("message_id 4242");
		expect(readTree(turns)).not.toContain(KEY);
		const sendLog = readFileSync(join(home, ".8gent", "post-message.log"), "utf8");
		expect(sendLog).toContain(CHAT);
		expect(sendLog).not.toContain(KEY);
		expect(sendLog).not.toContain("caption for the practice chat");
		expect(readTree(data)).not.toContain(KEY); // ToolG8 audit log
		expect(consoleOut.join("\n")).not.toContain(KEY);
	});

	test("text_file: a drafted file in the project is posted without any shell", async () => {
		approve();
		writeFileSync(join(work, "tg-msg.txt"), "line one\nline two\n");
		const out = await new ToolExecutor(work, "http-file").execute("post_message", {
			chat: CHAT,
			text_file: "tg-msg.txt",
		});
		expect(out).toContain("message_id 4242");
		expect(hits.map((h) => h.body.text)).toEqual(["line one\nline two"]);
	});

	test("text that holds the key is refused before anything is sent", async () => {
		approve();
		writeFileSync(join(work, "leak.txt"), `here is the key ${KEY}`);
		const exec = new ToolExecutor(work, "http-leak");
		for (const args of [
			{ chat: CHAT, text_file: "leak.txt" },
			{ chat: CHAT, text: `key: ${KEY}` },
		]) {
			const out = await exec.execute("post_message", args);
			expect(out).toContain("holds a bot key");
			expect(out).not.toContain(KEY);
		}
		expect(hits).toEqual([]);
	});

	test("text_file cannot read the env file or anything outside the project", async () => {
		approve();
		const exec = new ToolExecutor(work, "http-escape");
		for (const p of [envFile, "~/.config/bot/bot.env", "../home/.config/bot/bot.env"]) {
			let out: string;
			try {
				out = await exec.execute("post_message", { chat: CHAT, text_file: p });
			} catch (e) {
				out = String(e);
			}
			expect(out).not.toContain("Posted");
			expect(out).not.toContain(KEY);
		}
		expect(hits).toEqual([]);
	});

	test("an API error that echoes the request path comes back with the key redacted", async () => {
		approve();
		reply = (path) =>
			Response.json({ ok: false, description: `Unauthorized for ${path}` }, { status: 401 });
		const out = await new ToolExecutor(work, "http-401").execute("post_message", {
			chat: CHAT,
			text: "hi",
		});
		expect(out).toContain("[ERROR] post_message failed");
		expect(out).toContain("401");
		expect(out).not.toContain(KEY);
		expect(out).not.toContain(KEY.split(":")[1]);
	});

	test("a redirect is not followed, so the key never reaches a second host", async () => {
		approve();
		// Points back at the stub, so a followed redirect would show up as a second hit.
		reply = (path) =>
			path === "/elsewhere"
				? Response.json({ ok: true, result: { message_id: 1 } })
				: new Response(null, {
						status: 307,
						headers: { location: `http://127.0.0.1:${stub.port}/elsewhere` },
					});
		const out = await new ToolExecutor(work, "http-302").execute("post_message", {
			chat: CHAT,
			text: "hi",
		});
		expect(out).toContain("[ERROR] post_message failed");
		expect(out).not.toContain(KEY);
		expect(hits).toHaveLength(1);
	});

	test("a key of any shape: text holding it is refused, an error echoing it is redacted", async () => {
		// Not bot-token shaped, so only the key-aware guards can catch it.
		const plain = "plainSecretValueNotTokenShaped77";
		writeFileSync(envFile, `TG_KEY=${plain}\n`);
		try {
			approve();
			const exec = new ToolExecutor(work, "http-plain");
			const refused = await exec.execute("post_message", { chat: CHAT, text: `see ${plain}` });
			expect(refused).toContain("holds a bot key");
			expect(hits).toEqual([]);
			reply = (path) => Response.json({ ok: false, description: `bad ${path}` }, { status: 401 });
			const out = await exec.execute("post_message", { chat: CHAT, text: "hi" });
			expect(hits.map((h) => h.path)).toEqual([`/bot${plain}/sendMessage`]);
			expect(out).toContain("401");
			expect(out).not.toContain(plain);
		} finally {
			writeFileSync(envFile, `# posting key\nexport TG_KEY="${KEY}"\nOTHER=1\n`);
		}
	});

	test("file tools cannot open the configured bot env file, even from HOME", async () => {
		approve();
		symlinkSync(envFile, join(work, "innocent.txt"));
		try {
			const fromHome = new ToolExecutor(home, "http-guard-home");
			const attempts: Array<[InstanceType<typeof ToolExecutor>, string, Record<string, unknown>]> =
				[
					[fromHome, "read_file", { path: ".config/bot/bot.env" }],
					[fromHome, "read_file", { path: envFile }],
					[fromHome, "post_message", { chat: CHAT, text_file: ".config/bot/bot.env" }],
					[
						new ToolExecutor(work, "http-guard-link"),
						"post_message",
						{ chat: CHAT, text_file: "innocent.txt" },
					],
				];
			for (const [exec, tool, args] of attempts) {
				let out: string;
				try {
					out = await exec.execute(tool, args);
				} catch (e) {
					out = String(e);
				}
				expect(out).toMatch(/protected credential file|BLOCKED|DENIED/);
				expect(out).not.toContain(KEY);
			}
			expect(hits).toEqual([]);
		} finally {
			rmSync(join(work, "innocent.txt"), { force: true });
		}
	});

	test("an API error echoing the percent-encoded key is redacted too", async () => {
		approve();
		reply = () =>
			Response.json(
				{
					ok: false,
					description: `bad ${encodeURIComponent(KEY)} and ${encodeURIComponent(KEY).toLowerCase()}`,
				},
				{ status: 400 },
			);
		const out = await new ToolExecutor(work, "http-pct").execute("post_message", {
			chat: CHAT,
			text: "hi",
		});
		expect(out).toContain("400");
		expect(out).not.toContain(encodeURIComponent(KEY));
		expect(out).not.toContain(encodeURIComponent(KEY).toLowerCase());
		expect(out).not.toContain(KEY.split(":")[1]);
	});

	test("EIGHT_TG_API_BASE: credentials always refused, plain http only under the test runner", () => {
		expect(checkApiBase("https://api.telegram.org/", false)).toEqual({
			base: "https://api.telegram.org",
		});
		expect(checkApiBase("http://127.0.0.1:9", true).base).toBe("http://127.0.0.1:9");
		expect(checkApiBase("http://127.0.0.1:9", false).error).toContain("https");
		expect(checkApiBase("ftp://example.com", true).error).toContain("https");
		for (const t of [true, false]) {
			const r = checkApiBase("https://user:pw@example.com", t);
			expect(r.base).toBeUndefined();
			expect(r.error).not.toContain("pw");
		}
	});

	test("a refused API base sends nothing: credentials in the URL, or http outside the test runner", async () => {
		approve();
		const saveBase = process.env.EIGHT_TG_API_BASE;
		const saveEnv = { NODE_ENV: process.env.NODE_ENV, BUN_TEST: process.env.BUN_TEST };
		try {
			process.env.EIGHT_TG_API_BASE = `http://u:p@127.0.0.1:${stub.port}`;
			const a = await new ToolExecutor(work, "http-base-a").execute("post_message", {
				chat: CHAT,
				text: "hi",
			});
			expect(a).toContain("must not carry credentials");
			process.env.EIGHT_TG_API_BASE = saveBase;
			(process.env as Record<string, string | undefined>).NODE_ENV = "production";
			Reflect.deleteProperty(process.env, "BUN_TEST");
			const b = await new ToolExecutor(work, "http-base-b").execute("post_message", {
				chat: CHAT,
				text: "hi",
			});
			expect(b).toContain("must be https");
			expect(hits).toEqual([]);
		} finally {
			process.env.EIGHT_TG_API_BASE = saveBase;
			for (const [k, v] of Object.entries(saveEnv)) {
				if (v === undefined) Reflect.deleteProperty(process.env, k);
				else process.env[k] = v;
			}
		}
	});

	test("any secret the scanner knows is refused before the card, from text or a drafted file", async () => {
		let asked = 0;
		registerTuiApprovalHandler(async () => {
			asked++;
			return "approve";
		});
		// Built at run time so no scanner flags this source file.
		const fake = ["sk-", "a".repeat(24), "T3BlbkFJ", "b".repeat(24)].join("");
		writeFileSync(join(work, "draft.txt"), `release notes\nOPENAI_API_KEY=${fake}\n`);
		const exec = new ToolExecutor(work, "http-scan");
		for (const args of [
			{ chat: CHAT, text_file: "draft.txt" },
			{ chat: CHAT, text: `use ${fake}` },
		]) {
			const out = await exec.execute("post_message", args);
			expect(out).toContain("holds a secret");
			expect(out).not.toContain(fake);
		}
		expect(asked).toBe(0);
		expect(hits).toEqual([]);
	});

	test("a botTokenVar that is not a plain upper-case name disables direct send", () => {
		const settings = join(home, ".8gent", "settings.json");
		const good = readFileSync(settings, "utf8");
		try {
			for (const bad of ["tg_key", "TG-KEY", "TG_KEY;rm", ""]) {
				writeFileSync(
					settings,
					JSON.stringify({
						postMessage: { allowedChats: [CHAT], botEnvFile: envFile, botTokenVar: bad },
					}),
				);
				_snapshotAllowedChats();
				const defs = JSON.stringify(new ToolExecutor(work, "http-var").getToolDefinitions());
				expect(defs).not.toContain('"post_message"');
			}
		} finally {
			writeFileSync(settings, good);
			_snapshotAllowedChats();
		}
	});

	test("a declined card sends nothing", async () => {
		registerTuiApprovalHandler(async () => "deny");
		const out = await new ToolExecutor(work, "http-deny").execute("post_message", {
			chat: CHAT,
			text: "hi",
		});
		expect(out).toContain("PERMISSION DENIED");
		expect(hits).toEqual([]);
	});
});
