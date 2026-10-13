/**
 * Tool catalog segment tests (closes #1082 acceptance criterion:
 * "Unit test for shape of segment").
 *
 * Keeps the prompt honest: every registered category must surface in the
 * segment the model sees, and toggles must work without dropping content
 * essential to tool awareness.
 */

import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { curlToLoopback } from "../../permissions/s1-curl-loopback.js";
import { sanitizeShellCommand } from "../../permissions/shell-sanitizer.js";
import { scrub } from "../secret-scanner.js";
import { TOOL_CATEGORIES } from "../tool-registry.js";
import {
	LOCAL_LOGIN_NOTE,
	LOCAL_SERVER_CURL_SHORT,
	REVIEW_FOCUS_NOTE,
	SLIDES_TO_VIDEO_NOTE,
	TOOL_CATALOG_SEGMENT,
	TOOL_PATTERNS_SEGMENT,
	buildToolCatalogSegment,
	environmentNote,
} from "./system-prompt.js";

/**
 * Size cap for the concise catalog the local TUI sends on every request.
 * Raising it is a deliberate decision (it costs every local turn), not a
 * fix for a failing test. Smallest value that fits today: 2220 (#3920, with the one-line OS and shell note;
 * +17 in #4165 so render_video_deck sits in a category and discover_tools can load it on a deferred session).
 */
const POSIX_CAP = 2220;
// The Windows environment line names the shell and is longer than the POSIX one; the budget
// for everything else stays fixed, so a Windows host gets exactly the difference.
const CONCISE_CATALOG_MAX_BYTES =
	POSIX_CAP +
	Buffer.byteLength(environmentNote()) -
	Buffer.byteLength(environmentNote({ platform: "linux" }));

describe("buildToolCatalogSegment", () => {
	it("has a clear header", () => {
		expect(TOOL_CATALOG_SEGMENT).toContain("## TOOLS YOU HAVE");
	});

	it("names every registered category in the default segment", () => {
		for (const category of Object.keys(TOOL_CATEGORIES)) {
			expect(TOOL_CATALOG_SEGMENT).toContain(category);
		}
	});

	it("names every registered tool in the default segment", () => {
		for (const tools of Object.values(TOOL_CATEGORIES)) {
			for (const tool of tools) {
				expect(TOOL_CATALOG_SEGMENT).toContain(tool);
			}
		}
	});

	it("tells the model web_search exists and is callable", () => {
		expect(TOOL_CATALOG_SEGMENT).toContain("web_search");
		// The model should never claim no internet access.
		expect(TOOL_CATALOG_SEGMENT.toLowerCase()).toContain("web");
	});

	it("concise mode drops rich descriptions but keeps all tool names", () => {
		const concise = buildToolCatalogSegment({ concise: true });
		// Still mentions every tool
		for (const tools of Object.values(TOOL_CATEGORIES)) {
			for (const tool of tools) {
				expect(concise).toContain(tool);
			}
		}
		// Concise version is meaningfully shorter than the default
		expect(concise.length).toBeLessThan(TOOL_CATALOG_SEGMENT.length);
	});

	it("deferred mode mentions discover_tools", () => {
		const deferred = buildToolCatalogSegment({ deferred: true });
		expect(deferred).toContain("discover_tools");
	});

	it("non-deferred mode does NOT tell the model to call discover_tools", () => {
		expect(TOOL_CATALOG_SEGMENT).not.toContain("discover_tools");
	});

	it("fits in a reasonable token budget (< 4KB default, within CONCISE_CATALOG_MAX_BYTES concise)", () => {
		expect(TOOL_CATALOG_SEGMENT.length).toBeLessThan(4096);
		const concise = buildToolCatalogSegment({ concise: true });
		expect(Buffer.byteLength(concise)).toBeLessThanOrEqual(CONCISE_CATALOG_MAX_BYTES);
	});

	it("tells the local model to keep scratch files inside the project (#3865)", () => {
		for (const text of [TOOL_CATALOG_SEGMENT, buildToolCatalogSegment({ concise: true })]) {
			expect(text).toContain(".tmp/");
			expect(text).toContain("never /tmp");
		}
	});
});

describe("slides-to-video join guidance (#3862)", () => {
	it("tells the model to cover every slide when joining", () => {
		expect(TOOL_CATALOG_SEGMENT).toContain("Slides to video");
		expect(TOOL_CATALOG_SEGMENT).toContain("segment count equals slide count");
		expect(TOOL_CATALOG_SEGMENT).toContain("trailing newline");
	});

	it("shows the shell recipe: write deck.json, then `8gent deck render deck.json` (pilot media-brief-video, 12 Oct 2026)", () => {
		for (const text of [TOOL_CATALOG_SEGMENT, buildToolCatalogSegment({ concise: true })]) {
			expect(text).toContain("write deck.json");
			expect(text).toContain('{"slides":[{"title"');
			expect(text).toContain("`8gent deck render deck.json out.mp4`");
			expect(text).toContain("not ffmpeg by hand");
		}
	});

	it("is present on the concise path the local TUI uses, within its budget", () => {
		const concise = buildToolCatalogSegment({ concise: true });
		expect(concise).toContain("segment count equals slide count");
		expect(concise).toContain("trailing newline");
		expect(Buffer.byteLength(concise)).toBeLessThanOrEqual(CONCISE_CATALOG_MAX_BYTES);
	});

	it("appears exactly once in each catalog variant", () => {
		for (const seg of [TOOL_CATALOG_SEGMENT, buildToolCatalogSegment({ concise: true })]) {
			expect(seg.split(SLIDES_TO_VIDEO_NOTE).length - 1).toBe(1);
		}
	});
});

describe("review focus guidance (#3920)", () => {
	it("is in both catalog variants exactly once, within the concise budget", () => {
		for (const seg of [TOOL_CATALOG_SEGMENT, buildToolCatalogSegment({ concise: true })]) {
			expect(seg.split(REVIEW_FOCUS_NOTE).length - 1).toBe(1);
		}
		expect(Buffer.byteLength(buildToolCatalogSegment({ concise: true }))).toBeLessThanOrEqual(
			CONCISE_CATALOG_MAX_BYTES,
		);
		expect(REVIEW_FOCUS_NOTE).toContain("cite only lines that must change");
		expect(REVIEW_FOCUS_NOTE).toContain("security-relevant");
	});
});

describe("TOOL_PATTERNS_SEGMENT local server guidance (#3941)", () => {
	it("tells the model to use plain loopback curl, files under .tmp/, no -L, and a second request on a 302", () => {
		expect(TOOL_PATTERNS_SEGMENT).toContain("one plain curl per call");
		expect(TOOL_PATTERNS_SEGMENT).toContain("under .tmp/");
		expect(TOOL_PATTERNS_SEGMENT).toContain("Do not pass -L");
		expect(TOOL_PATTERNS_SEGMENT).toContain("second loopback request");
		expect(TOOL_PATTERNS_SEGMENT).toContain("read that file with read_file next");
		expect(TOOL_PATTERNS_SEGMENT).toContain("never repeat the same command");
	});

	it("the compact short form is under 300 chars, has no em dash, and keeps the core rules", () => {
		expect(LOCAL_SERVER_CURL_SHORT.length).toBeLessThanOrEqual(300);
		expect(LOCAL_SERVER_CURL_SHORT).not.toContain("\u2014");
		for (const rule of [
			"one plain curl per call",
			"under .tmp/",
			"never /tmp",
			"Do not pass -L",
			"Location header",
		])
			expect(LOCAL_SERVER_CURL_SHORT).toContain(rule);
	});

	it("the login note (#4072) is short, names the redaction marker and the file recipe, and sits with the curl rules", () => {
		expect(LOCAL_LOGIN_NOTE.length).toBeLessThanOrEqual(300);
		expect(LOCAL_LOGIN_NOTE).not.toContain("—");
		for (const rule of [
			"[REDACTED:",
			"sed -n 's/^Password: */password=/w .tmp/login' FILE",
			"-d @.tmp/login",
			"Never print, read_file or retype",
		])
			expect(LOCAL_LOGIN_NOTE).toContain(rule);
		// Generic: no fixture file name, no loopback address.
		expect(LOCAL_LOGIN_NOTE).not.toMatch(/TASK\.txt|127\.0\.0\.1|localhost/);
		const local = TOOL_PATTERNS_SEGMENT.indexOf("### Local servers");
		const next = TOOL_PATTERNS_SEGMENT.indexOf("### ", local + 1);
		expect(TOOL_PATTERNS_SEGMENT.slice(local, next)).toContain(LOCAL_LOGIN_NOTE);
	});

	it("the note's recipe keeps the value out of the transcript: sed prints nothing, the file still scrubs, both commands pass the gates (8SO, #4091)", () => {
		const sed = /\((sed -n '[^']*' FILE),/.exec(LOCAL_LOGIN_NOTE)?.[1];
		const curl = /\((curl [^)]+ URL)\)/.exec(LOCAL_LOGIN_NOTE)?.[1];
		expect(sed).toBeDefined();
		expect(curl).toBeDefined();
		const ws = realpathSync(mkdtempSync(join(tmpdir(), "login-note-")));
		try {
			writeFileSync(
				join(ws, "TASK.txt"),
				"Local dashboard\n\nAddress:  http://127.0.0.1:1/\nUsername: pilot-x\nPassword: yGfoi4qmTmGEvy\n\nThe toggle is off.\n",
			);
			mkdirSync(join(ws, ".tmp"));
			const sedCmd = (sed as string).replace("FILE", "TASK.txt");
			const run = Bun.spawnSync(["sh", "-c", sedCmd], { cwd: ws });
			expect(run.exitCode).toBe(0);
			// Nothing on stdout or stderr: the value never enters the tool result.
			expect(run.stdout.toString()).toBe("");
			expect(run.stderr.toString()).toBe("");
			// The file holds the one line, relabelled as the form field; curl -d @file strips the newline.
			const body = readFileSync(join(ws, ".tmp/login"), "utf8");
			expect(body).toBe("password=yGfoi4qmTmGEvy\n");
			// A read_file of that file still scrubs: the label is what the redactor matches on.
			const scrubbed = scrub(body);
			expect(scrubbed.scrubbed).toBe("password=[REDACTED:secret_assignment]\n");
			expect(scrubbed.rules).toEqual(["secret_assignment"]);
			// Both commands run as written: the sanitizer and System One's loopback lane accept them.
			expect(sanitizeShellCommand(sedCmd)).toEqual({ safe: true });
			const curlCmd = (curl as string)
				.replace("NAME", "pilot-x")
				.replace("URL", "http://127.0.0.1:5173/login");
			expect(sanitizeShellCommand(curlCmd)).toEqual({ safe: true });
			const keys = [
				"http_proxy",
				"https_proxy",
				"all_proxy",
				"HTTP_PROXY",
				"HTTPS_PROXY",
				"ALL_PROXY",
				"HOME",
				"CURL_HOME",
				"XDG_CONFIG_HOME",
			];
			const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
			for (const k of keys) Reflect.deleteProperty(process.env, k);
			process.env.HOME = ws;
			try {
				expect(curlToLoopback(curlCmd, ws).ok).toBe(true);
			} finally {
				for (const k of keys) {
					if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
					else process.env[k] = saved[k];
				}
			}
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});
});
