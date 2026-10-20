/**
 * /telegram setup (#4594) against a stub Bot API. The key must never appear in
 * anything the flow returns or logs, existing settings must survive, and the
 * resulting settings must post to the stub chat after approval.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY = "987654321:ZZstubKeyNeverLeavesTheProcess_0042";
const root = mkdtempSync(join(tmpdir(), "tg-setup-"));
const home = join(root, "home");
mkdirSync(join(home, ".8gent"), { recursive: true });
process.env.HOME = home;
const settingsPath = join(home, ".8gent", "settings.json");
const envPath = join(home, ".8gent", "secrets", "telegram-bot.env");

const calls: string[] = [];
let updates: unknown = [];
const server = Bun.serve({
	port: 0,
	async fetch(req) {
		const u = new URL(req.url);
		calls.push(u.pathname.replace(KEY, "<key>"));
		const m = u.pathname.match(/^\/bot([^/]+)\/(\w+)$/);
		if (!m || m[1] !== KEY)
			return Response.json(
				{ ok: false, description: `Unauthorized ${m?.[1] ?? ""}` },
				{ status: 401 },
			);
		if (m[2] === "getMe") return Response.json({ ok: true, result: { username: "stub_bot" } });
		if (m[2] === "getUpdates") return Response.json({ ok: true, result: updates });
		if (m[2] === "sendMessage") {
			const b = (await req.json()) as { chat_id: string };
			return Response.json({ ok: true, result: { message_id: 7, chat: { id: b.chat_id } } });
		}
		return Response.json({ ok: false }, { status: 404 });
	},
});
process.env.EIGHT_TG_API_BASE = `http://127.0.0.1:${server.port}`;
process.env.BUN_TEST = "1";

const { apiBase } = await import("../../../../packages/ai/post-message.js");
const { runTelegramSetup, mergeSettings, redact, cleanLabel, ensureEnvFile } = await import(
	"./telegram-setup.js"
);

afterAll(() => {
	server.stop(true);
	rmSync(root, { recursive: true, force: true });
});

const setKey = (k: string) => writeFileSync(envPath, `# k\nTELEGRAM_BOT_TOKEN=${k}\n`);
const everything = (s: string) => s + calls.join("\n") + readFileSync(settingsPath, "utf8");

describe("telegram setup", () => {
	beforeAll(() => {
		writeFileSync(
			settingsPath,
			JSON.stringify({ theme: "amber", postMessage: { allowedChats: ["111"], other: true } }),
		);
	});

	test("missing key file is created private with a placeholder and instructions", async () => {
		const out = await runTelegramSetup([]);
		expect(out).toContain("@BotFather");
		expect(out).toContain("~/.8gent/secrets/telegram-bot.env");
		expect(out).toContain("Do not paste the key here");
		expect(statSync(envPath).mode & 0o777).toBe(0o600);
		expect(statSync(join(home, ".8gent", "secrets")).mode & 0o777).toBe(0o700);
		expect(readFileSync(envPath, "utf8")).toContain("TELEGRAM_BOT_TOKEN=\n");
		expect(calls.length).toBe(0);
	});

	test("a bad key gives a plain error with the key redacted", async () => {
		setKey("123456:BadKeyBadKeyBadKeyBadKey_1");
		const out = await runTelegramSetup([]);
		expect(out).toContain("did not accept that key");
		expect(out).not.toContain("BadKeyBadKey");
	});

	test("good key shows the bot name and lists chats once, without long polling", async () => {
		setKey(KEY);
		updates = [
			{
				update_id: 1,
				message: { chat: { id: 222, type: "private", first_name: "Ada", last_name: "L" } },
			},
			{ update_id: 2, message: { chat: { id: -100333, type: "supergroup", title: "Crew" } } },
			{
				update_id: 3,
				message: { chat: { id: 222, type: "private", first_name: "Ada", last_name: "L" } },
			},
		];
		calls.length = 0;
		const out = await runTelegramSetup([]);
		expect(out).toContain("@stub_bot");
		expect(out).toContain("222  Ada L (private)");
		expect(out).toContain("-100333  Crew (supergroup)");
		expect(calls.filter((c) => c.endsWith("getUpdates")).length).toBe(1);
		expect(out).not.toContain(KEY);
	});

	test("no chats yet tells the person to message the bot", async () => {
		updates = [];
		expect(await runTelegramSetup([])).toContain("No chats yet");
	});

	test("picking a chat merges settings, keeps other keys and existing chats", async () => {
		updates = [
			{ update_id: 2, message: { chat: { id: -100333, type: "supergroup", title: "Crew" } } },
		];
		const out = await runTelegramSetup(["-100333"]);
		expect(out).toContain("Restart 8gent");
		expect(out).toContain("asks you to approve");
		const s = JSON.parse(readFileSync(settingsPath, "utf8"));
		expect(s.theme).toBe("amber");
		expect(s.postMessage.other).toBe(true);
		expect(s.postMessage.allowedChats).toEqual(["111", "-100333"]);
		expect(s.postMessage.botEnvFile).toBe("~/.8gent/secrets/telegram-bot.env");
		expect(s.postMessage.botTokenVar).toBe("TELEGRAM_BOT_TOKEN");
		// running again never duplicates or removes
		await runTelegramSetup(["-100333"]);
		expect(JSON.parse(readFileSync(settingsPath, "utf8")).postMessage.allowedChats).toEqual([
			"111",
			"-100333",
		]);
	});

	test("unseen or malformed chat ids are refused and nothing is written", async () => {
		const before = readFileSync(settingsPath, "utf8");
		expect(await runTelegramSetup(["999"])).toContain("not one @stub_bot has seen");
		expect(await runTelegramSetup(["abc"])).toContain("not a chat id");
		expect(readFileSync(settingsPath, "utf8")).toBe(before);
	});

	test("invalid settings.json is never clobbered", () => {
		const before = readFileSync(settingsPath, "utf8");
		writeFileSync(settingsPath, "{ not json");
		expect(mergeSettings(["1"], "~/x.env", "TELEGRAM_BOT_TOKEN").ok).toBe(false);
		expect(readFileSync(settingsPath, "utf8")).toBe("{ not json");
		writeFileSync(settingsPath, before);
	});

	test("the key never appears in any returned frame, stub path log or settings", async () => {
		updates = [
			{ update_id: 2, message: { chat: { id: 222, type: "private", first_name: "Ada" } } },
		];
		const frames = [
			await runTelegramSetup([]),
			await runTelegramSetup(["222"]),
			await runTelegramSetup(["999"]),
		];
		for (const f of frames) expect(everything(f)).not.toContain(KEY);
		expect(redact(`oops ${KEY} and bot${KEY}`, KEY)).not.toContain("ZZstub");
	});

	test("the written settings post to the stub chat after approval", async () => {
		const { postMessage, _snapshotAllowedChats, postMessageDeps } = await import(
			"../../../../packages/ai/post-message.js"
		);
		_snapshotAllowedChats();
		const deps = postMessageDeps("tg-setup-test");
		expect(deps.allowedChats()).toContain("222");
		expect(deps.direct).toBeDefined();
		deps.gate = () => ({ allowed: true });
		// Not approved yet: nothing posts, whatever the file says.
		deps.infinite = () => true;
		expect(await postMessage({ chat: "222", text: "hi" }, deps)).toContain("[BLOCKED]");
		expect(calls.some((c) => c.endsWith("sendMessage"))).toBe(false);
		deps.approved.add("222"); // what the approval card does in a real session
		const r = await postMessage({ chat: "222", text: "hello from setup" }, deps);
		expect(String(r)).not.toContain(KEY);
		expect(calls.some((c) => c.endsWith("sendMessage"))).toBe(true);
	});
});

describe("hardening (8SO F2-F5)", () => {
	test("a pasted key or long input is never echoed", async () => {
		setKey(KEY);
		for (const arg of [KEY, `bot${KEY}`, "x".repeat(60)]) {
			const out = await runTelegramSetup([arg]);
			expect(out).toContain("not a chat id");
			expect(out).not.toContain("ZZstub");
			expect(out).not.toContain("xxxxxxxx");
		}
		expect(await runTelegramSetup(["12ab"])).toContain('"12ab" is not a chat id');
	});

	test("chat names are stripped of control and bidi characters and capped", async () => {
		expect(cleanLabel("\x1b]0;x\x07Family\nOK")).toBe("]0;x Family OK");
		expect(cleanLabel("a\u202eb\u0085c\u007fd")).toBe("a b c d");
		expect(cleanLabel("z".repeat(100)).length).toBeLessThanOrEqual(40);
		updates = [
			{
				update_id: 1,
				message: { chat: { id: 555, type: "group", title: "\x1b]0;x\x07Family\nOK" } },
			},
		];
		const out = await runTelegramSetup([]);
		expect(out).toContain("555  ]0;x Family OK (group)");
		expect(out).not.toContain("\x1b");
		expect(out).not.toContain("\x07");
	});

	test("a getUpdates reply that is not a list is a plain error", async () => {
		updates = "oops";
		expect(await runTelegramSetup([])).toContain("unexpected reply");
	});

	test("a symlinked key file or directory is refused", () => {
		const t = mkdtempSync(join(root, "link-"));
		writeFileSync(join(t, "real.env"), "TELEGRAM_BOT_TOKEN=\n");
		symlinkSync(join(t, "real.env"), join(t, "link.env"));
		expect(ensureEnvFile(join(t, "link.env")).error).toContain("symlink");
		symlinkSync(t, join(root, "dirlink"));
		expect(ensureEnvFile(join(root, "dirlink", "x.env")).error).toContain("symlink");
	});

	test("looser modes are tightened and reported", () => {
		const t = mkdtempSync(join(root, "loose-"));
		const f = join(t, "k.env");
		writeFileSync(f, "TELEGRAM_BOT_TOKEN=\n");
		chmodSync(f, 0o644);
		chmodSync(t, 0o755);
		const r = ensureEnvFile(f);
		expect(r.notes.length).toBe(2);
		expect(statSync(f).mode & 0o777).toBe(0o600);
		expect(statSync(t).mode & 0o777).toBe(0o700);
	});
});

describe("hardening round 2 (F8 and LOW)", () => {
	test("redact covers the bare secret half and chat labels are redacted", async () => {
		expect(redact("leak ZZstubKeyNeverLeavesTheProcess_0042 here", KEY)).not.toContain("ZZstub");
		setKey(KEY);
		updates = [
			{
				update_id: 1,
				message: { chat: { id: 777, type: "group", title: "ZZstubKeyNeverLeavesTheProcess_0042" } },
			},
		];
		const out = await runTelegramSetup([]);
		expect(out).not.toContain("ZZstub");
		expect(out).toContain("777  [redacted-token]");
	});

	test("a cwd .env that sets EIGHT_TG_API_BASE and NODE_ENV cannot redirect the key", () => {
		const cwd = mkdtempSync(join(root, "hostile-"));
		writeFileSync(
			join(cwd, ".env"),
			"NODE_ENV=test\nEIGHT_TG_API_BASE=http://127.0.0.1:9\nEIGHT_TG_API_BASE=http://127.0.0.1:9\n",
		);
		const script = `import { apiBase } from ${JSON.stringify(join(import.meta.dir, "../../../../packages/ai/post-message.ts"))}; process.stdout.write(JSON.stringify(apiBase()));`;
		const r = spawnSync(process.execPath, ["-e", script], {
			cwd,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: home,
				TMPDIR: process.env.TMPDIR ?? "/tmp",
				EIGHT_TG_API_BASE: "http://127.0.0.1:9",
			},
			encoding: "utf8",
		});
		expect(JSON.parse(r.stdout)).toEqual({ base: "https://api.telegram.org" });
	});

	test("outside test mode the override is ignored even from the real environment", () => {
		expect(apiBase({}).base).toBe("https://api.telegram.org");
		expect(apiBase({ NODE_ENV: "test" }).base).toBe(process.env.EIGHT_TG_API_BASE);
	});
});
