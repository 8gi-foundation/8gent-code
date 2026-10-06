/**
 * post_message reaches the model through ToolExecutor (#3595): advertised
 * only with the helper installed, executed only through the approval gate.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _snapshotAllowedChats } from "../ai/post-message";
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

	test("advertised when installed; an approved call runs the helper once", async () => {
		process.env.EIGHT_TG_BIN_DIR = bins;
		registerTuiApprovalHandler(async () => "approve");
		const exec = new ToolExecutor(work, "pm-test");
		expect(names(exec)).toContain("post_message");
		const out = await exec.execute("post_message", { chat: "-1004417730052", text: "hi" });
		expect(out).toContain("message_id 777");
		expect(await Bun.file(log).text()).toBe("text --chat -1004417730052 -- hi\n");
	});

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

	test("an approved post is logged to ~/.8gent/post-message.log without the text", async () => {
		process.env.EIGHT_TG_BIN_DIR = bins;
		registerTuiApprovalHandler(async () => "approve");
		await new ToolExecutor(work, "pm-log").execute("post_message", {
			chat: "-1004417730052",
			text: "private words",
		});
		const line = readFileSync(join(home, ".8gent", "post-message.log"), "utf8");
		expect(line).toContain("-1004417730052");
		expect(line).not.toContain("private words");
	});

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
