/** #4530: the headless slash dispatcher the gateway runs before the model. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILT_IN_SLASH_COMMANDS } from "../../apps/tui/src/lib/slash-commands";
import { DJ, setDjSpawn, setDjTools } from "../music/dj";
import { KNOWN_CHANNELS } from "./agent-pool";
import { matchBed, runSlash } from "./slash";

const ctx = {
	sessionId: "s_1",
	channel: "browser",
	model: "m-1",
	runtime: "ollama",
	messageCount: 3,
	busy: false,
};
let beds: string;
const savedBeds = process.env.EIGHT_BEDS_DIR;
const spawned: { cmd: string; args: string[] }[] = [];

beforeAll(() => {
	beds = mkdtempSync(join(tmpdir(), "beds-"));
	writeFileSync(join(beds, "VibeCoding - Salvador James & 8GI.mp3"), "x");
	writeFileSync(join(beds, "notes.txt"), "x");
	process.env.EIGHT_BEDS_DIR = beds;
	setDjTools({ mpv: "/usr/bin/mpv", ytdlp: "/usr/bin/yt-dlp" });
	setDjSpawn(((cmd: string, args: string[]) => {
		spawned.push({ cmd, args });
		const { EventEmitter } = require("node:events");
		const c = new EventEmitter();
		c.stdout = new EventEmitter();
		c.kill = () => true;
		c.unref = () => {};
		c.pid = 91000;
		setTimeout(() => c.emit("close", 1), 0); // yt-dlp finds nothing
		return c;
	}) as never);
});

afterAll(() => {
	new DJ().stop(); // module-level player state must not leak into other test files
	setDjSpawn();
	setDjTools();
	if (savedBeds === undefined) Reflect.deleteProperty(process.env, "EIGHT_BEDS_DIR");
	else process.env.EIGHT_BEDS_DIR = savedBeds;
	rmSync(beds, { recursive: true, force: true });
});

describe("runSlash", () => {
	test("a plain prompt is not handled", async () => {
		expect((await runSlash("hello", ctx)).handled).toBe(false);
		expect((await runSlash("say /help", ctx)).handled).toBe(false);
	});

	test("an unknown name is refused here, never forwarded to the model", async () => {
		expect(await runSlash("/nosuchcommand x", ctx)).toEqual({
			handled: true,
			text: "Unknown command /nosuchcommand. Type /help.",
		});
		expect((await runSlash("/", ctx)).handled).toBe(true);
		expect((await runSlash("/Users/me/file", ctx)).handled).toBe(true);
	});

	test("an unknown slash is refused from every channel in the protocol enum", async () => {
		for (const channel of KNOWN_CHANNELS) {
			const r = await runSlash("/nosuchcommand", { ...ctx, channel });
			expect(r.handled).toBe(true);
			expect(r.text).toContain("Unknown command");
		}
	});

	test("/dj play with an absolute path outside the beds folder is refused, nothing spawns", async () => {
		for (const bad of [
			"/etc/hosts",
			"/nonexistent/probe.mp3",
			"~/x.mp3",
			"../x.mp3",
			"file:///etc/hosts",
		]) {
			spawned.length = 0;
			const r = await runSlash(`/dj play ${bad}`, ctx);
			expect(r.text).toStartWith("Refused");
			expect(spawned).toEqual([]);
		}
	});

	test("a symlink in the beds folder that points outside is refused", async () => {
		const out = mkdtempSync(join(tmpdir(), "outside-"));
		writeFileSync(join(out, "secret.mp3"), "x");
		symlinkSync(join(out, "secret.mp3"), join(beds, "linkedsecret.mp3"));
		spawned.length = 0;
		const r = await runSlash("/dj play linkedsecret", ctx);
		expect(r.text).toContain("Refused");
		expect(spawned).toEqual([]);
		rmSync(join(beds, "linkedsecret.mp3"));
		rmSync(out, { recursive: true, force: true });
	});

	test("help lists every registry name, the same list the TUI has", async () => {
		const r = await runSlash("/help", ctx);
		expect(r.handled).toBe(true);
		for (const c of BUILT_IN_SLASH_COMMANDS) expect(r.text).toContain(`/${c.name} `);
	});

	test("a TUI-only name answers not available in the browser chat", async () => {
		const r = await runSlash("/theme dark", ctx);
		expect(r).toEqual({
			handled: true,
			text: expect.stringContaining("not available in the browser chat"),
		});
	});

	test("/mode never changes a permission mode from a channel: it is terminal only", async () => {
		for (const channel of KNOWN_CHANNELS) {
			const r = await runSlash("/mode infinite", { ...ctx, channel });
			expect(r.handled).toBe(true);
			expect(r.text).toContain("It runs in the 8gent terminal.");
		}
	});

	test("status, model, provider, session read the context", async () => {
		expect((await runSlash("/status", ctx)).text).toContain("3 messages");
		expect((await runSlash("/model", ctx)).text).toContain("m-1");
		expect((await runSlash("/provider", ctx)).text).toContain("ollama");
		expect((await runSlash("/session", ctx)).text).toContain("s_1");
	});

	test("cron and goal and subgoal answer without the model", async () => {
		expect((await runSlash("/cron", ctx)).handled).toBe(true);
		expect((await runSlash("/goal ship it", ctx)).handled).toBe(true);
		expect((await runSlash("/subgoal x", ctx)).handled).toBe(true);
	});

	test("/dj status is idle with nothing playing", async () => {
		expect((await runSlash("/dj status", ctx)).text).toContain("idle");
	});

	test("/dj play <bed name> plays the local file and says bed", async () => {
		spawned.length = 0;
		const r = await runSlash("/dj play vibecoding salvador", ctx);
		expect(r.text).toStartWith("[bed]");
		const mpv = spawned.find((s) => s.cmd === "/usr/bin/mpv");
		expect(mpv?.args).toContain(join(beds, "VibeCoding - Salvador James & 8GI.mp3"));
		expect(spawned.some((s) => s.cmd === "/usr/bin/yt-dlp")).toBe(false);
	});

	test("/dj play with no bed match searches YouTube and says so", async () => {
		spawned.length = 0;
		const r = await runSlash("/dj play fela kuti no agreement", ctx);
		expect(r.text).toStartWith("[youtube]");
		expect(spawned.find((s) => s.cmd === "/usr/bin/yt-dlp")?.args).toContain(
			"ytsearch1:fela kuti no agreement",
		);
	});

	test("an alias resolves to its command", async () => {
		expect((await runSlash("/s", ctx)).text).toContain("Session s_1");
	});
});

describe("matchBed", () => {
	test("matches case-insensitively on every word, skips non-audio files", () => {
		expect(matchBed("VIBECODING")).toBe(join(beds, "VibeCoding - Salvador James & 8GI.mp3"));
		expect(matchBed("notes")).toBeNull();
		expect(matchBed("")).toBeNull();
	});
});
