/**
 * post_message reaches the model through ToolExecutor (#3595): advertised
 * only with the helper installed, executed only through the approval gate.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _snapshotAllowedChats } from "../ai/post-message";
import { getPermissionManager } from "../permissions";
import {
	_resetTuiApprovalChannel,
	registerTuiApprovalHandler,
} from "../permissions/tui-approval-channel";
import { ToolExecutor } from "./tools";

const bins = mkdtempSync(join(tmpdir(), "post-message-bins-"));
const work = mkdtempSync(join(tmpdir(), "post-message-work-"));
const log = join(bins, "calls.log");
writeFileSync(join(bins, "tg-group"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\necho 777\n`);
chmodSync(join(bins, "tg-group"), 0o755);
const home = mkdtempSync(join(tmpdir(), "post-message-home-"));
mkdirSync(join(home, ".8gent"));
const settings = join(home, ".8gent", "settings.json");
const savedHome = process.env.HOME;
process.env.HOME = home;
process.env.EIGHT_FAKE_HOME = home;
const allow = (chats: string[]) =>
	writeFileSync(settings, JSON.stringify({ postMessage: { allowedChats: chats } }));
allow(["-1004417730052"]);
_snapshotAllowedChats();
const saved = process.env.EIGHT_TG_BIN_DIR;
afterAll(() => {
	process.env.HOME = savedHome;
	Reflect.deleteProperty(process.env, "EIGHT_FAKE_HOME");
	rmSync(home, { recursive: true, force: true });
	rmSync(bins, { recursive: true, force: true });
	rmSync(work, { recursive: true, force: true });
});
afterEach(() => {
	_snapshotAllowedChats(); // each test is a new process: nothing approved
	_resetTuiApprovalChannel();
	if (saved === undefined) Reflect.deleteProperty(process.env, "EIGHT_TG_BIN_DIR");
	else process.env.EIGHT_TG_BIN_DIR = saved;
});

/** A denied write either throws (path-guard in safePath) or returns the policy block text. */
async function denied(run: () => Promise<string>): Promise<boolean> {
	try {
		return /did NOT run|BLOCKED|DENIED/i.test(await run());
	} catch (e) {
		return String(e).includes("protected settings file");
	}
}

const names = (e: ToolExecutor) =>
	(e.getToolDefinitions() as Array<{ function: { name: string } }>).map((d) => d.function.name);

describe("post_message in ToolExecutor", () => {
	test("not advertised when tg-group is not installed", () => {
		process.env.EIGHT_TG_BIN_DIR = join(bins, "nope");
		expect(names(new ToolExecutor(work, "pm-test"))).not.toContain("post_message");
	});

	// POSIX only: the tg-group stub is a shell script, which Windows cannot run as a command.
	test.skipIf(process.platform === "win32")(
		"advertised when installed; an approved call runs the helper once",
		async () => {
			process.env.EIGHT_TG_BIN_DIR = bins;
			registerTuiApprovalHandler(async () => "approve");
			const exec = new ToolExecutor(work, "pm-test");
			expect(names(exec)).toContain("post_message");
			const out = await exec.execute("post_message", { chat: "-1004417730052", text: "hi" });
			expect(out).toContain("message_id 777");
			expect(await Bun.file(log).text()).toBe("text --chat -1004417730052 -- hi\n");
		},
	);

	test("a declined call never runs the helper", async () => {
		process.env.EIGHT_TG_BIN_DIR = bins;
		rmSync(log, { force: true });
		registerTuiApprovalHandler(async () => "deny");
		const out = await new ToolExecutor(work, "pm-test").execute("post_message", {
			chat: "-1004417730052",
			text: "hi",
		});
		expect(out).toContain("PERMISSION DENIED");
		expect(await Bun.file(log).exists()).toBe(false);
	});

	test("settings allowlist: an unlisted chat is refused and the helper never runs", async () => {
		process.env.EIGHT_TG_BIN_DIR = bins;
		rmSync(log, { force: true });
		registerTuiApprovalHandler(async () => "approve");
		const out = await new ToolExecutor(work, "pm-test").execute("post_message", {
			chat: "-5",
			text: "hi",
		});
		expect(out).toContain("not on postMessage.allowedChats");
		expect(await Bun.file(log).exists()).toBe(false);
	});

	// POSIX only: the tg-group stub is a shell script, which Windows cannot run as a command.
	test.skipIf(process.platform === "win32")(
		"an approved post is logged to ~/.8gent/post-message.log without the text",
		async () => {
			process.env.EIGHT_TG_BIN_DIR = bins;
			registerTuiApprovalHandler(async () => "approve");
			await new ToolExecutor(work, "pm-log").execute("post_message", {
				chat: "-1004417730052",
				text: "private words",
			});
			const line = readFileSync(join(home, ".8gent", "post-message.log"), "utf8");
			expect(line).toContain("-1004417730052");
			expect(line).not.toContain("private words");
		},
	);

	test("a settings edit during the session grants nothing (snapshot at start)", async () => {
		process.env.EIGHT_TG_BIN_DIR = bins;
		rmSync(log, { force: true });
		allow(["-1004417730052", "-777"]);
		registerTuiApprovalHandler(async () => "approve");
		const out = await new ToolExecutor(work, "pm-snap").execute("post_message", {
			chat: "-777",
			text: "hi",
		});
		expect(out).toContain("not on postMessage.allowedChats");
		expect(await Bun.file(log).exists()).toBe(false);
		allow(["-1004417730052"]);
	});

	test("write_file with a ~ path to settings.json is denied and the file is unchanged", async () => {
		const exec = new ToolExecutor(home, "pm-tilde");
		const before = readFileSync(settings, "utf8");
		for (const p of ["~/.8gent/settings.json"]) {
			expect(await denied(() => exec.execute("write_file", { path: p, content: "HACK" }))).toBe(
				true,
			);
		}
		expect(readFileSync(settings, "utf8")).toBe(before);
	});

	test("next launch: an edited settings file posts nothing without a person (Infinite, no card)", async () => {
		process.env.EIGHT_TG_BIN_DIR = bins;
		rmSync(log, { force: true });
		// the file was edited between launches to add a chat; the new process has approved nothing
		allow(["-1004417730052", "-888"]);
		_snapshotAllowedChats();
		const pm = getPermissionManager();
		pm.enableInfiniteMode();
		try {
			for (const chat of ["-888", "-1004417730052"]) {
				const out = await new ToolExecutor(work, "pm-next").execute("post_message", {
					chat,
					text: "hi",
				});
				expect(out).toContain("no person has approved chat");
			}
			expect(await Bun.file(log).exists()).toBe(false);
		} finally {
			pm.disableInfiniteMode();
			allow(["-1004417730052"]);
		}
	});

	test("write_file to ~/.8gent/settings.json is denied even with cwd = HOME", async () => {
		const exec = new ToolExecutor(home, "pm-write");
		const before = readFileSync(settings, "utf8");
		for (const p of [
			".8gent/settings.json",
			join(home, ".8gent", "settings.json"),
			".8gent/../.8gent/settings.json",
		]) {
			expect(
				await denied(() =>
					exec.execute("write_file", {
						path: p,
						content: '{"postMessage":{"allowedChats":["-5"]}}',
					}),
				),
			).toBe(true);
		}
		expect(readFileSync(settings, "utf8")).toBe(before);
	});

	test("edit_file on settings.json is denied", async () => {
		const exec = new ToolExecutor(home, "pm-edit");
		const before = readFileSync(settings, "utf8");
		expect(
			await denied(() =>
				exec.execute("edit_file", {
					path: ".8gent/settings.json",
					oldText: "allowedChats",
					newText: "x",
				}),
			),
		).toBe(true);
		expect(readFileSync(settings, "utf8")).toBe(before);
	});

	test("run_command that names ~/.8gent/settings.json is denied", async () => {
		const exec = new ToolExecutor(home, "pm-run");
		const before = readFileSync(settings, "utf8");
		for (const c of [
			"echo '{}' | tee .8gent/settings.json",
			`python3 -c "open('.8gent/settings.json','w').write('{}')"`,
			"cat ~/.8gent/settings.json",
			"sed -i '' s/a/b/ $HOME/.8gent/settings.json",
		]) {
			expect(await exec.runCommand(c)).toContain("PERMISSION DENIED");
		}
		expect(readFileSync(settings, "utf8")).toBe(before);
	});
});

// #4191: before an outward post, the turn task's countable rules are counted in the draft.
describe.skipIf(process.platform === "win32")("post_message pre-send check (#4191)", () => {
	const TASK =
		'Post a short summary with the post_message tool, input {"chat": "-1004417730052", "text": "<your 4 lines>"}. Use exactly 4 lines of plain text, include exactly 3 numbers, and do not use any word more than twice. Send it once.';
	// The texts msg-post-tool really posted on 13 Oct: run 150728 (PASS) and 151655 (2 numbers).
	const GOOD =
		"Run ops-cron-backup finished with a FAIL verdict.\nChecks passed 11 out of 12 total items.\nThe old_backups_pruned item did not clear.\nElapsed time was 487 seconds.";
	const BAD =
		"Run ops-cron-backup finished with a FAIL verdict\nChecks passed 11/12, old_backups_pruned did not clear\nThe run took 487 seconds to finish\nNo faults were logged on the host";
	const posts = () =>
		Bun.file(log).size ? readFileSync(log, "utf8").split("text --chat").length - 1 : 0;
	const ready = () => {
		process.env.EIGHT_TG_BIN_DIR = bins;
		registerTuiApprovalHandler(async () => "approve");
		const exec = new ToolExecutor(work, "pm-presend");
		exec.beginTurn(TASK);
		return exec;
	};

	test("a draft that keeps every rule posts once, no stop", async () => {
		const exec = ready();
		const before = posts();
		const out = await exec.execute("post_message", { chat: "-1004417730052", text: GOOD });
		expect(out).toContain("message_id 777");
		expect(posts()).toBe(before + 1);
		expect(exec.takePresendStop()).toBeNull();
	});

	test("first failure: nothing sent, the model gets the draft and the broken rule for one redraft", async () => {
		const exec = ready();
		const before = posts();
		const out = await exec.execute("post_message", { chat: "-1004417730052", text: BAD });
		expect(out).toStartWith("[BLOCKED] post_message pre-send check");
		expect(out).toContain('"exactly 3 numbers": 2 number(s), want exactly 3');
		expect(out).toContain(BAD);
		expect(posts()).toBe(before);
		expect(exec.takePresendStop()).toBeNull();
		// The redraft keeps the rules and posts.
		expect(await exec.execute("post_message", { chat: "-1004417730052", text: GOOD })).toContain(
			"message_id 777",
		);
		expect(posts()).toBe(before + 1);
	});

	test("second failure: nothing sent, typed formatting_rule_violation stop", async () => {
		const exec = ready();
		const before = posts();
		await exec.execute("post_message", { chat: "-1004417730052", text: BAD });
		const out = await exec.execute("post_message", { chat: "-1004417730052", text: BAD });
		expect(out).toContain("The turn is stopped. Do not retry.");
		expect(posts()).toBe(before);
		const stop = exec.takePresendStop();
		expect(stop).toMatchObject({
			kind: "formatting_rule_violation",
			constraint: "exactly 3 numbers",
			draft: BAD,
		});
		expect(exec.takePresendStop()).toBeNull();
	});

	test("a named source is read inside the workspace; a symlink to a file outside it is refused", async () => {
		const SRC_TASK = "Post the summary. Use only numbers from facts.txt.";
		const outside = mkdtempSync(join(tmpdir(), "presend-outside-"));
		writeFileSync(join(outside, "secret.txt"), "apples: 5");
		const ws = mkdtempSync(join(tmpdir(), "presend-ws-"));
		try {
			// Inside: the file is read, so an invented number is caught.
			writeFileSync(join(ws, "facts.txt"), "apples: 5");
			process.env.EIGHT_TG_BIN_DIR = bins;
			registerTuiApprovalHandler(async () => "approve");
			const inside = new ToolExecutor(ws, "pm-presend-src");
			inside.beginTurn(SRC_TASK);
			expect(
				await inside.execute("post_message", { chat: "-1004417730052", text: "7 apples" }),
			).toContain("not in facts.txt: 7");
			// A link to a file outside the workspace is never read: the rule stays unchecked.
			rmSync(join(ws, "facts.txt"));
			symlinkSync(join(outside, "secret.txt"), join(ws, "facts.txt"));
			const linked = new ToolExecutor(ws, "pm-presend-link");
			linked.beginTurn(SRC_TASK);
			const out = await linked.execute("post_message", {
				chat: "-1004417730052",
				text: "7 apples",
			});
			expect(out).not.toContain("pre-send check");
			expect(out).toContain("message_id 777");
		} finally {
			rmSync(outside, { recursive: true, force: true });
			rmSync(ws, { recursive: true, force: true });
		}
	});

	test("a new turn resets the redraft budget; a task with no rules checks nothing", async () => {
		const exec = ready();
		await exec.execute("post_message", { chat: "-1004417730052", text: BAD });
		exec.beginTurn(TASK);
		expect(await exec.execute("post_message", { chat: "-1004417730052", text: BAD })).toStartWith(
			"[BLOCKED] post_message pre-send check: the draft",
		);
		exec.beginTurn("Post the run summary to the group.");
		expect(await exec.execute("post_message", { chat: "-1004417730052", text: BAD })).toContain(
			"message_id 777",
		);
	});
});

// #4265: post_message attaches a video, photo, gif or document from inside the project.
describe.skipIf(process.platform === "win32")("post_message attachments (#4265)", () => {
	const CHAT = "-1004417730052";
	const media = mkdtempSync(join(tmpdir(), "pm-media-ws-"));
	writeFileSync(join(media, "film.mp4"), Buffer.from("fake mp4 bytes"));
	writeFileSync(join(media, "card.png"), Buffer.from("fake png bytes"));
	writeFileSync(join(media, "brief.pdf"), Buffer.from("%PDF-1.4 fake"));
	afterAll(() => rmSync(media, { recursive: true, force: true }));
	const calls = () => (Bun.file(log).size ? readFileSync(log, "utf8").trim().split("\n") : []);
	const exec = (approve = true) => {
		process.env.EIGHT_TG_BIN_DIR = bins;
		rmSync(log, { force: true });
		registerTuiApprovalHandler(async () => (approve ? "approve" : "deny"));
		return new ToolExecutor(media, "pm-attach");
	};

	test("a local mp4 goes to tg-group video with the text as caption", async () => {
		const out = await exec().execute("post_message", {
			chat: CHAT,
			text: "Brief film",
			attachment: { path: "film.mp4", kind: "video" },
		});
		expect(out).toBe(`Posted video film.mp4 to ${CHAT}, message_id 777.`);
		expect(calls()).toEqual([
			`video --chat ${CHAT} --file ${join(media, "film.mp4")} --caption Brief film`,
		]);
	});

	test("a png with no text goes to tg-group photo with no caption", async () => {
		const out = await exec().execute("post_message", {
			chat: CHAT,
			attachment: { path: "./card.png", kind: "photo" },
		});
		expect(out).toContain("Posted photo card.png");
		expect(calls()).toEqual([`photo --chat ${CHAT} --file ${join(media, "card.png")}`]);
	});

	test("a document, and an attachment given as a JSON string, both send", async () => {
		const e = exec();
		await e.execute("post_message", {
			chat: CHAT,
			text: "the brief",
			attachment: JSON.stringify({ path: "brief.pdf", kind: "document" }),
		});
		expect(calls()[0]).toStartWith(`document --chat ${CHAT} --file `);
	});

	test("the send log records kind and size, never the caption or the path", async () => {
		await exec().execute("post_message", {
			chat: CHAT,
			text: "secret caption words",
			attachment: { path: "film.mp4", kind: "video" },
		});
		const last = readFileSync(join(home, ".8gent", "post-message.log"), "utf8")
			.trim()
			.split("\n")
			.pop() as string;
		expect(JSON.parse(last).attachment).toEqual({ kind: "video", bytes: 14 });
		expect(last).not.toContain("secret caption");
		expect(last).not.toContain("film.mp4");
	});

	test("declined: the card names the file and nothing runs", async () => {
		let shown = "";
		process.env.EIGHT_TG_BIN_DIR = bins;
		rmSync(log, { force: true });
		registerTuiApprovalHandler(async (req) => {
			shown = `${req.command}`;
			return req.action === "Allow Telegram recipient" ? "approve" : "deny";
		});
		const out = await new ToolExecutor(media, "pm-attach").execute("post_message", {
			chat: CHAT,
			text: "cap",
			attachment: { path: "film.mp4", kind: "video" },
		});
		expect(out).toContain("PERMISSION DENIED");
		expect(shown).toContain("video film.mp4");
		expect(shown).toContain("caption: cap");
		expect(calls()).toEqual([]);
	});

	test("an unlisted chat is refused before any file is sent", async () => {
		const out = await exec().execute("post_message", {
			chat: "-5",
			attachment: { path: "film.mp4", kind: "video" },
		});
		expect(out).toContain("not on postMessage.allowedChats");
		expect(calls()).toEqual([]);
	});

	// Known-bad: none of these may reach tg-group, and none may ask the person.
	const outside = mkdtempSync(join(tmpdir(), "pm-media-outside-"));
	writeFileSync(join(outside, "leak.mp4"), "outside bytes");
	symlinkSync(join(outside, "leak.mp4"), join(media, "link.mp4"));
	writeFileSync(join(media, "empty.mp4"), "");
	writeFileSync(join(media, "notes.txt"), "plain notes");
	writeFileSync(
		join(media, "keys.txt"),
		"OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH\n",
	);
	writeFileSync(join(media, "bot.txt"), "token 123456789:AAFakeTokenFakeTokenFakeTokenFake_0123\n");
	// Sparse files: the size is real to stat, nothing is written to disk.
	const sparse = (name: string, bytes: number) => {
		writeFileSync(join(media, name), "");
		truncateSync(join(media, name), bytes);
	};
	sparse("huge.mp4", 50 * 1024 * 1024 + 1);
	sparse("big.png", 10 * 1024 * 1024 + 1);
	mkdirSync(join(media, "folder.mp4"));
	afterAll(() => rmSync(outside, { recursive: true, force: true }));

	const bad: Array<[string, unknown, RegExp]> = [
		[
			"a relative path outside the project",
			{ path: "../leak.mp4", kind: "video" },
			/\[BLOCKED\].*outside/,
		],
		[
			"an absolute path outside the project",
			{ path: join(outside, "leak.mp4"), kind: "video" },
			/\[BLOCKED\].*outside/,
		],
		[
			"a symlink that leads outside the project",
			{ path: "link.mp4", kind: "video" },
			/\[BLOCKED\].*symlink/,
		],
		["a ~ path into home", { path: "~/.8gent/settings.json", kind: "document" }, /\[BLOCKED\]/],
		["an https URL", { path: "https://example.com/a.mp4", kind: "video" }, /never a URL/],
		["a file: URL", { path: "file:///etc/passwd", kind: "document" }, /never a URL/],
		["a missing file", { path: "nope.mp4", kind: "video" }, /attachment not found: nope\.mp4/],
		["a directory", { path: "folder.mp4", kind: "video" }, /not a file/],
		["an empty file", { path: "empty.mp4", kind: "video" }, /is empty/],
		[
			"an oversized video (50 MB + 1 byte)",
			{ path: "huge.mp4", kind: "video" },
			/50\.0 MB; the cap for a video is 50 MB/,
		],
		[
			"an oversized photo (10 MB + 1 byte)",
			{ path: "big.png", kind: "photo" },
			/cap for a photo is 10 MB/,
		],
		["a photo that is not an image", { path: "notes.txt", kind: "photo" }, /must be \.png/],
		["an unknown kind", { path: "film.mp4", kind: "sticker" }, /kind must be/],
		["no path", { kind: "video" }, /needs \{path, kind\}/],
		["a document holding an API key", { path: "keys.txt", kind: "document" }, /holds a secret/],
		["a document holding a bot token", { path: "bot.txt", kind: "document" }, /holds a secret/],
	];
	for (const [name, attachment, want] of bad) {
		test(`refused: ${name}`, async () => {
			let asked = 0;
			process.env.EIGHT_TG_BIN_DIR = bins;
			rmSync(log, { force: true });
			registerTuiApprovalHandler(async () => {
				asked++;
				return "approve";
			});
			let out: string;
			try {
				out = await new ToolExecutor(media, "pm-attach-bad").execute("post_message", {
					chat: CHAT,
					text: "cap",
					attachment,
				});
			} catch (e) {
				out = String(e);
			}
			expect(out).toMatch(want);
			expect(asked).toBe(0);
			expect(calls()).toEqual([]);
		});
	}

	test("refused: a voice note and an attachment together", async () => {
		const out = await exec().execute("post_message", {
			chat: CHAT,
			text: "cap",
			voice: "Rishi",
			attachment: { path: "film.mp4", kind: "video" },
		});
		expect(out).toContain("not both");
		expect(calls()).toEqual([]);
	});

	test("refused: a caption over 1024 characters", async () => {
		const out = await exec().execute("post_message", {
			chat: CHAT,
			text: "x".repeat(1025),
			attachment: { path: "film.mp4", kind: "video" },
		});
		expect(out).toContain("caption is 1025 characters; the cap is 1024");
		expect(calls()).toEqual([]);
	});
});
