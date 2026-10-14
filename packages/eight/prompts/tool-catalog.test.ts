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
import { DeckSpecSchema } from "../../tools/video-deck.js";
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
 * +17 in #4165 so render_video_deck sits in a category and discover_tools can load it on a deferred session;
 * +28 in #4236 so the scratch note says .tmp/ is git-ignored and must not be deleted;
 * +7 in #3593 so use_skill sits in core and the model can load a skill on every session;
 * +33 in #4274 so make_docx, make_xlsx and make_pptx sit in the creative category beside make_pdf).
 */
const POSIX_CAP = 2288;
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
			expect(text).toContain("Write deck.json");
			expect(text).toContain('{"slides":[{"title"');
			expect(text).toContain("`8gent deck render deck.json out.mp4`");
		}
	});

	it("opens with never write a script; by hand is one magick/ffmpeg per call (#4245)", () => {
		expect(SLIDES_TO_VIDEO_NOTE.startsWith("**Slides to video: never write a script.")).toBe(true);
		expect(SLIDES_TO_VIDEO_NOTE).toContain("By hand: one magick/ffmpeg per call");
		// The steer comes before the recipe, and the renderer before the by-hand path.
		const order = ["never write a script", "8gent deck render", "By hand"].map((s) =>
			SLIDES_TO_VIDEO_NOTE.indexOf(s),
		);
		expect(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1]))).toBe(true);
		for (const text of [TOOL_CATALOG_SEGMENT, buildToolCatalogSegment({ concise: true })]) {
			expect(text).toContain("never write a script");
			expect(text).not.toContain("not ffmpeg by hand");
		}
	});

	it("the example deck.json is a valid render_video_deck spec", () => {
		const json = SLIDES_TO_VIDEO_NOTE.slice(
			SLIDES_TO_VIDEO_NOTE.indexOf("{"),
			SLIDES_TO_VIDEO_NOTE.lastIndexOf("}") + 1,
		);
		expect(DeckSpecSchema.safeParse(JSON.parse(json)).success).toBe(true);
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

describe("render_video_deck catalog line carries its spec shape (#4172)", () => {
	/** The one line the local text-tool prompt shows per tool: `name(params) - description`. */
	async function catalogLines(): Promise<string[]> {
		const { ToolExecutor } = await import("../tools.js");
		const { toolDefsToSpecs } = await import("../../ai/text-tool-endpoint.js");
		const { buildToolSystemPrompt } = await import("../../ai/text-tools.js");
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "catalog-line-")));
		try {
			const defs = new ToolExecutor(dir).getToolDefinitions() as Parameters<
				typeof toolDefsToSpecs
			>[0];
			return buildToolSystemPrompt(toolDefsToSpecs(defs)).split("\n");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	it("names slides and narration on the line the model reads, not only in the native schema", async () => {
		const line = (await catalogLines()).find((l) => l.startsWith("render_video_deck("));
		expect(line).toBeDefined();
		for (const word of ["spec:", "size", "slides", "title", "bullets", "narration", "out"]) {
			expect(line).toContain(word);
		}
		// Whole, not cut at the 140-character description cap.
		expect(line).not.toContain("…");
	});

	it("speak's line keeps its input shape (text, voice, out)", async () => {
		const line = (await catalogLines()).find((l) => l.startsWith("speak("));
		expect(line).toStartWith("speak(text: string, voice?: string, out?: string) - ");
	});

	it("the native path's description opens with the same shape", async () => {
		const { agentTools } = await import("../../ai/tools.js");
		const first = (agentTools.render_video_deck as { description?: string }).description?.split(
			/(?<=\.)\s/,
		)[0];
		expect(first).toContain("slides");
		expect(first).toContain("narration");
	});

	it("edit_file's line opens with in-place replacement within the 140-character cap (#4198)", async () => {
		const line = (await catalogLines()).find((l) => l.startsWith("edit_file("));
		expect(line).toBeDefined();
		const desc = (line as string).split(" - ").slice(1).join(" - ");
		const head = desc.slice(0, 140);
		for (const word of ["oldText", "in place", "whole line"]) {
			expect(head).toContain(word);
		}
		// The first sentence fits the cap, so the line is not cut with an ellipsis.
		expect(line).not.toContain("…");
	});

	it("edit_file's native description and parameters teach in-place replacement (#4198)", async () => {
		const { agentTools } = await import("../../ai/tools.js");
		const first = (agentTools.edit_file as { description?: string }).description?.split(
			/(?<=\.)\s/,
		)[0] as string;
		expect(first.length).toBeLessThanOrEqual(140);
		for (const word of ["oldText", "in place", "whole line"]) {
			expect(first.slice(0, 140)).toContain(word);
		}
	});

	/** The slide fields the renderer accepts, which a model must see as real schema fields. */
	const SLIDE_FIELDS = ["title", "text", "bullets", "narration", "seconds", "image"];
	type Obj = { properties?: Record<string, Obj>; items?: Obj; type?: string };

	it("the native tool list's spec parameter is a real nested schema, not a bare object", async () => {
		const { ToolExecutor } = await import("../tools.js");
		const { toolDefsToSpecs } = await import("../../ai/text-tool-endpoint.js");
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "deck-schema-")));
		try {
			const defs = new ToolExecutor(dir).getToolDefinitions() as Parameters<
				typeof toolDefsToSpecs
			>[0];
			// Headless Ollama declares name and parameters only; parameters go out as-is.
			const spec = toolDefsToSpecs(defs).find((t) => t.name === "render_video_deck");
			const specParam = (spec?.parameters as Obj).properties?.spec;
			expect(specParam?.type).toBe("object");
			expect(Object.keys(specParam?.properties ?? {})).toEqual(
				expect.arrayContaining(["slides", "size", "voice"]),
			);
			const slide = specParam?.properties?.slides?.items;
			expect(Object.keys(slide?.properties ?? {})).toEqual(expect.arrayContaining(SLIDE_FIELDS));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("the AI SDK tool's spec input schema carries the same fields", async () => {
		const { asSchema } = await import("ai");
		const { agentTools } = await import("../../ai/tools.js");
		const input = (agentTools.render_video_deck as { inputSchema: Parameters<typeof asSchema>[0] })
			.inputSchema;
		const json = (await asSchema(input).jsonSchema) as Obj;
		const specParam = json.properties?.spec;
		expect(Object.keys(specParam?.properties ?? {})).toEqual(
			expect.arrayContaining(["slides", "size", "voice"]),
		);
		const slide = specParam?.properties?.slides?.items;
		expect(Object.keys(slide?.properties ?? {})).toEqual(expect.arrayContaining(SLIDE_FIELDS));
	});
});

describe("every tool's first sentence carries its input shape within 140 characters (retro 13 Oct)", () => {
	/** The description cap the text-tool catalog applies (DESC_CAP in packages/ai/text-tools.ts). */
	const CAP = 140;
	type Spec = { name: string; description: string; parameters: Record<string, unknown> };

	/** The description exactly as the text-tool catalog line shows it to the model. */
	async function shownDescription(spec: Spec): Promise<string> {
		const { buildToolSystemPrompt } = await import("../../ai/text-tools.js");
		const line = buildToolSystemPrompt([spec])
			.split("\n")
			.find((l) => l.startsWith(`${spec.name}(`)) as string;
		const at = line.indexOf(") - ");
		return at === -1 ? "" : line.slice(at + 4);
	}

	/** Each failing tool with the reasons, so the assertion message names them all. */
	async function audit(specs: Spec[]): Promise<string[]> {
		const failures: string[] = [];
		for (const spec of specs) {
			const reasons: string[] = [];
			const flat = spec.description.replace(/\s+/g, " ").trim();
			const first = flat.split(/(?<=\.)\s/)[0] ?? flat;
			if (first.length > CAP) reasons.push(`first sentence is ${first.length} chars`);
			const shown = await shownDescription(spec);
			if (shown.endsWith("…")) reasons.push("cut mid-word by the catalog renderer");
			const head = shown.slice(0, CAP);
			const required = Array.isArray(spec.parameters.required)
				? (spec.parameters.required as string[])
				: [];
			const missing = required.filter((p) => !new RegExp(`\\b${p}\\b`).test(head));
			if (missing.length > 0) reasons.push(`missing required ${missing.join(", ")}`);
			if (reasons.length > 0) failures.push(`${spec.name}: ${reasons.join("; ")} | "${first}"`);
		}
		return failures;
	}

	it("packages/eight/tools.ts: every tool definition passes, conditional ones included", async () => {
		const { MCP_LEAN_TOOL_DEFS, POWERSHELL_TOOL_DEF, ToolExecutor } = await import("../tools.js");
		const { POST_MESSAGE_TOOL_DEF } = await import("../../ai/post-message.js");
		const { toolDefsToSpecs } = await import("../../ai/text-tool-endpoint.js");
		type Defs = Parameters<typeof toolDefsToSpecs>[0];
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "catalog-all-")));
		try {
			const base = new ToolExecutor(dir).getToolDefinitions() as Defs;
			// Tools advertised only on some hosts (lean MCP, Windows, a tg-group helper) are audited too.
			const have = new Set(base.map((d) => d.function?.name));
			const extra = [...MCP_LEAN_TOOL_DEFS, POWERSHELL_TOOL_DEF, POST_MESSAGE_TOOL_DEF].filter(
				(d) => !have.has(d.function.name),
			) as Defs;
			const specs = toolDefsToSpecs([...base, ...extra]) as Spec[];
			expect(specs.length).toBeGreaterThan(40);
			const failures = await audit(specs);
			expect(failures, `\n${failures.join("\n")}\n`).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("packages/ai/tools.ts: every AI SDK tool passes", async () => {
		const { asSchema } = await import("ai");
		const { agentTools } = await import("../../ai/tools.js");
		const specs: Spec[] = [];
		for (const [name, def] of Object.entries(agentTools)) {
			const t = def as { description?: string; inputSchema: Parameters<typeof asSchema>[0] };
			const parameters = (await asSchema(t.inputSchema).jsonSchema) as Record<string, unknown>;
			specs.push({ name, description: t.description ?? "", parameters });
		}
		expect(specs.length).toBeGreaterThan(40);
		const failures = await audit(specs);
		expect(failures, `\n${failures.join("\n")}\n`).toEqual([]);
	});
});
