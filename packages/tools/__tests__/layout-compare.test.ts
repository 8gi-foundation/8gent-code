/**
 * #4080: compare_layout renders a page and diffs it against a mock-up image.
 * Chrome itself is replaced by a stub script that "renders" a pre-drawn PNG,
 * so the test is the same on every machine and never opens a browser.
 */

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import sharp from "sharp";
import { fakeExecutable } from "../../../tests/fake-exe";
import { cleanupTempDirs, tempDir } from "../../../tests/temp-dirs";
import { ToolExecutor } from "../../eight/tools";
import type { Band, LayoutMeasure } from "../../eight/layout-measure";
import * as http from "node:http";
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import { MAX_HTML_BYTES, RENDER_CSP, chromeArgs, compareLayout, describeDiff, findChrome, noScreenshotMessage, pairBands, prepareSafeCopy, renderHtml, renderSafe } from "../layout-compare";
import { measureLayout } from "../../eight/layout-measure";

afterAll(cleanupTempDirs);

const W = 1280;
const H = 900;
type Box = { x: number; y: number; w: number; h: number };

/**
 * A stand-in Chrome: "renders" by copying a pre-drawn PNG to the --screenshot=
 * path it is given, and creates the --user-data-dir= it is handed, as Chrome would.
 */
function fakeChromeSource(renderPng: string): string {
	return [
		'const fs = require("node:fs");',
		"let out = null;",
		"for (const a of process.argv.slice(2)) {",
		'  if (a.startsWith("--screenshot=")) out = a.slice("--screenshot=".length);',
		'  if (a.startsWith("--user-data-dir=")) fs.mkdirSync(a.slice("--user-data-dir=".length), { recursive: true });',
		"}",
		`if (out) fs.copyFileSync(${JSON.stringify(renderPng)}, out);`,
		"",
	].join("\n");
}

async function draw(dir: string, name: string, boxes: Box[]): Promise<string> {
	const px = Buffer.alloc(W * H * 3, 255);
	for (const b of boxes)
		for (let y = b.y; y < b.y + b.h; y++)
			for (let x = b.x; x < b.x + b.w; x++) px.set([0, 0, 0], (y * W + x) * 3);
	const file = path.join(dir, name);
	await sharp(px, { raw: { width: W, height: H, channels: 3 } }).png().toFile(file);
	return file;
}

const band = (y: number, h: number, x: number, w: number, spans = 1): Band => ({
	y,
	h,
	x,
	w,
	spans: Array.from({ length: spans }, (_, i) => ({ x: x + i * 10, w: Math.floor(w / spans) })),
});
const measure = (bands: Band[]): LayoutMeasure => ({
	width: W,
	height: H,
	column: { left: 240, right: 1040, width: 800 },
	centered: true,
	bands,
});

describe("pairBands", () => {
	test("pairs in order and leaves the missing and the extra unpaired", () => {
		const ref = [band(40, 30, 240, 180), band(100, 100, 240, 800), band(400, 50, 240, 800)];
		const got = [band(40, 30, 240, 180), band(300, 10, 600, 20), band(405, 50, 240, 800)];
		const { pairs, extra } = pairBands(ref, got);
		expect(pairs.map((p) => p.got?.y ?? null)).toEqual([40, null, 405]);
		expect(extra.map((b) => b.y)).toEqual([300]);
	});
});

describe("describeDiff", () => {
	test("names the offset and the direction to fix it", () => {
		const ref = measure([band(40, 30, 240, 180), band(437, 28, 439, 402)]);
		const got = measure([band(40, 30, 240, 180), band(497, 28, 400, 402)]);
		const text = describeDiff(ref, got, 0.91234);
		expect(text).toContain("Pixel similarity 0.912");
		expect(text).toContain("ref y=437");
		expect(text).toContain("y +60 (move up 60px)");
		expect(text).toContain("x -39 (move right 39px)");
		expect(text).not.toContain("ref y=40 ");
		expect(text).toContain("1 of 2 bands are off");
		expect(text).not.toMatch(/—/);
	});

	test("says so when every band is within 2px", () => {
		const ref = measure([band(40, 30, 240, 180)]);
		const got = measure([band(41, 30, 241, 181)]);
		expect(describeDiff(ref, got, 1)).toContain("within 2px");
	});
});

describe("compareLayout with a stub browser", () => {
	// A real executable on every OS (tests/fake-exe.ts): Windows cannot spawn a shell script.
	function stubChrome(dir: string, renderPng: string): string {
		return fakeExecutable(dir, "fake-chrome", fakeChromeSource(renderPng));
	}

	test("reports a block that sits 60px too low, and a similarity under 1", async () => {
		const dir = tempDir("layout-compare-");
		const ref = await draw(dir, "mock.png", [
			{ x: 240, y: 40, w: 180, h: 30 },
			{ x: 240, y: 440, w: 800, h: 50 },
		]);
		const render = await draw(dir, "render.png", [
			{ x: 240, y: 40, w: 180, h: 30 },
			{ x: 240, y: 500, w: 800, h: 50 },
		]);
		fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
		const prev = process.env.EIGHT_CHROME_BIN;
		process.env.EIGHT_CHROME_BIN = stubChrome(dir, render);
		try {
			const text = await compareLayout(path.join(dir, "index.html"), ref);
			expect(text).toContain("ref y=440");
			expect(text).toContain("y +60 (move up 60px)");
			expect(text).toMatch(/Pixel similarity 0\.\d{3}/);
			const same = await compareLayout(path.join(dir, "index.html"), render);
			expect(same).toContain("within 2px");
			expect(same).toContain("Pixel similarity 1.000");
		} finally {
			if (prev === undefined) process.env.EIGHT_CHROME_BIN = undefined as never;
			if (prev === undefined) delete process.env.EIGHT_CHROME_BIN;
			else process.env.EIGHT_CHROME_BIN = prev;
		}
	});

	test("a browser that exits without a screenshot says its exit code and what it printed", async () => {
		const dir = tempDir("layout-compare-");
		fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
		const bin = fakeExecutable(
			dir,
			"fake-chrome-dies",
			'process.stderr.write("noise line\\nERROR: Failed to create a ProcessSingleton\\n"); process.exit(21);',
		);
		const err = await renderHtml(bin, path.join(dir, "index.html"), path.join(dir, "out.png"), 200, 100, path.join(dir, "profile")).then(
			() => null,
			(e: Error) => e,
		);
		expect(err?.message).toContain("the browser produced no screenshot (exit code 21)");
		expect(err?.message).toContain("ERROR: Failed to create a ProcessSingleton");
	});

	test("the no-screenshot message keeps only the last stderr lines, and says when there were none", () => {
		const many = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
		const msg = noScreenshotMessage(1, null, many);
		expect(msg).toContain("line 39");
		expect(msg).not.toContain("line 27\n");
		expect(noScreenshotMessage(null, "SIGKILL", "")).toBe(
			"the browser produced no screenshot (signal SIGKILL); Chrome wrote nothing to stderr",
		);
	});

	test("a missing page or image is a sentence, not a throw", async () => {
		const dir = tempDir("layout-compare-");
		expect(await compareLayout(path.join(dir, "nope.html"), path.join(dir, "nope.png"))).toContain("does not exist");
	});

	test("EIGHT_CHROME_BIN wins when it exists", () => {
		const dir = tempDir("layout-compare-");
		const bin = path.join(dir, "chrome");
		fs.writeFileSync(bin, "");
		expect(findChrome({ EIGHT_CHROME_BIN: bin })).toBe(bin);
	});
});

function snapshot(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (d: string) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const f = path.join(d, e.name);
			if (e.isDirectory()) walk(f);
			else out[path.relative(dir, f)] = fs.readFileSync(f).toString("base64") + ":" + fs.statSync(f).mtimeMs;
		}
	};
	walk(dir);
	return out;
}

describe("compare_layout is read-only (#4081)", () => {
	test("the workspace is byte-identical after a render, and the temp dir is gone", async () => {
		const ws = tempDir("layout-compare-ro-");
		const ref = await draw(ws, "mock.png", [{ x: 240, y: 40, w: 180, h: 30 }]);
		fs.writeFileSync(path.join(ws, "index.html"), '<html><body><img src="mock.png"></body></html>');
		const bins = tempDir("layout-compare-bin-");
		const render = await draw(bins, "render.png", [{ x: 240, y: 70, w: 180, h: 30 }]);
		const bin = fakeExecutable(bins, "fake-chrome", fakeChromeSource(render));
		const before = snapshot(ws);
		const tmpBefore = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("8gent-compare-"));
		const prev = process.env.EIGHT_CHROME_BIN;
		process.env.EIGHT_CHROME_BIN = bin;
		try {
			const text = await compareLayout(path.join(ws, "index.html"), ref, ws);
			expect(text).toContain("y +30");
		} finally {
			if (prev === undefined) delete process.env.EIGHT_CHROME_BIN;
			else process.env.EIGHT_CHROME_BIN = prev;
		}
		expect(snapshot(ws)).toEqual(before);
		expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("8gent-compare-"))).toEqual(tmpBefore);
	});

	test("it is not denied in architect and review modes, and plan mode lets it through", async () => {
		const { ModeManager } = await import("../../eight/modes");
		const mm = new ModeManager(path.join(tempDir("layout-compare-modes-"), "none.yaml"));
		for (const mode of ["architect", "review"]) {
			const denied = mm.getMode(mode)?.deniedTools ?? [];
			expect(denied).not.toContain("compare_layout");
			expect(denied).toContain("write_file");
		}
		const src = fs.readFileSync(path.join(import.meta.dir, "../../permissions/permission-mode.ts"), "utf8");
		expect(src).toContain('"compare_layout"');
	});
});

describe("compare_layout is a declared tool", () => {
	test("it is offered and gated as a read", () => {
		const root = tempDir("layout-compare-tool-");
		const executor = new ToolExecutor(root);
		const names = executor.getToolDefinitions().map((d) => (d as { function: { name: string } }).function.name);
		expect(names).toContain("compare_layout");
	});
});

describe("findChrome refuses what the model could have planted (#4081)", () => {
	test("a relative path, a directory and a binary inside the workspace are all refused", () => {
		const ws = tempDir("layout-compare-ws-");
		const inside = path.join(ws, "chrome");
		fs.writeFileSync(inside, "");
		const outsideDir = tempDir("layout-compare-out-");
		const outside = path.join(outsideDir, "chrome");
		fs.writeFileSync(outside, "");
		const none = { PATH: "" };
		if (process.platform === "linux") return; // PATH candidates are probed on linux only
		const hit = (bin: string) => findChrome({ ...none, EIGHT_CHROME_BIN: bin }, ws);
		expect(hit("chrome")).not.toBe("chrome");
		expect(hit(ws)).not.toBe(ws);
		expect(hit(inside)).not.toBe(inside);
		expect(hit(outside)).toBe(outside);
	});

	test("a symlink that resolves into the workspace is refused", () => {
		const ws = tempDir("layout-compare-ws-");
		const real = path.join(ws, "chrome");
		fs.writeFileSync(real, "");
		const link = path.join(tempDir("layout-compare-out-"), "chrome");
		fs.symlinkSync(real, link);
		expect(findChrome({ PATH: "", EIGHT_CHROME_BIN: link }, ws)).not.toBe(link);
	});

	test("a PATH entry inside the workspace is refused on linux", () => {
		if (process.platform !== "linux") return;
		const ws = tempDir("layout-compare-ws-");
		fs.writeFileSync(path.join(ws, "chromium"), "");
		expect(findChrome({ PATH: ws }, ws)).toBeNull();
	});
});

describe("chromeArgs lock-down flags (#4081)", () => {
	test("every offline and no-script flag is in argv", () => {
		const argv = chromeArgs("/p/page.html", "/o.png", 800, 600, "/prof", {});
		for (const f of [
			"--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
			"--disable-background-networking",
			"--disable-component-update",
			"--disable-sync",
			"--no-first-run",
			"--disable-default-apps",
			"--disable-domain-reliability",
			"--dns-prefetch-disable",
			"--host-resolver-rules=MAP * ~NOTFOUND",
			"--proxy-server=http://127.0.0.1:9",
			"--proxy-bypass-list=<-loopback>",
		])
			expect(argv).toContain(f);
		expect(argv).not.toContain("--no-sandbox");
		expect(argv.some((a) => a.includes("EXCLUDE"))).toBe(false);
		// Script is blocked by the page's CSP, not a blink setting: that setting also disables
		// Chrome's own --screenshot command page, and the render produced nothing (#4124).
		expect(argv.some((a) => a.startsWith("--blink-settings"))).toBe(false);
		expect(RENDER_CSP).toContain("default-src 'none'");
		expect(RENDER_CSP).not.toContain("script-src");
		expect(chromeArgs("/p", "/o", 1, 1, "/x", { EIGHT_CHROME_NO_SANDBOX: "1" })).toContain("--no-sandbox");
	});
});

describe("prepareSafeCopy (#4081)", () => {
	function page(html: string, files: Record<string, string> = {}): { dir: string; file: string; out: string } {
		const dir = tempDir("layout-compare-page-");
		const site = path.join(dir, "site");
		fs.mkdirSync(site);
		for (const [name, body] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(site, name)), { recursive: true });
			fs.writeFileSync(path.join(site, name), body);
		}
		const file = path.join(site, "index.html");
		fs.writeFileSync(file, html);
		const out = path.join(dir, "out");
		fs.mkdirSync(out);
		return { dir, file, out };
	}

	test("injects the CSP first in head, drops <base> and meta refresh", () => {
		const p = page('<html><head><base href="file:///etc/"><meta http-equiv="refresh" content="0;url=file:///etc/passwd"></head><body>x</body></html>');
		const copy = fs.readFileSync(prepareSafeCopy(p.file, p.out), "utf8");
		expect(copy).toContain(RENDER_CSP);
		expect(copy.indexOf("Content-Security-Policy")).toBeLessThan(copy.indexOf("<body"));
		expect(copy).not.toMatch(/<base/i);
		expect(copy).not.toMatch(/refresh/i);
	});

	test("inlines images from the page's folder, not ones that escape it", () => {
		const secret = tempDir("layout-compare-secret-");
		fs.writeFileSync(path.join(secret, "s.png"), "SECRET");
		const p = page(
			`<img src="a.png"><img src="../escape.png">` +
				`<img src="${path.join(secret, "s.png")}"><img src="file://${path.join(secret, "s.png")}">` +
				`<img src="http://127.0.0.1:1/p.png"><div style="background:url('a.png')"></div>`,
			{ "a.png": "PNGDATA" },
		);
		fs.writeFileSync(path.join(p.dir, "escape.png"), "SECRET");
		const copy = fs.readFileSync(prepareSafeCopy(p.file, p.out), "utf8");
		const b64 = Buffer.from("PNGDATA").toString("base64");
		expect(copy.split(`data:image/png;base64,${b64}`).length - 1).toBe(2);
		expect(copy).not.toContain(Buffer.from("SECRET").toString("base64"));
		expect(copy).toContain("http://127.0.0.1:1/p.png"); // left alone, the CSP blocks it
	});

	test("the CSP is the first thing in the document, whatever the page does before <head>", () => {
		const shapes = [
			'<script src="file:///etc/x.js"></script><html><head></head><body></body></html>',
			'<!-- <head> --><script>1</script><html><head></head></html>',
			'<!DOCTYPE html><script>1</script><head></head>',
			"\uFEFF<!doctype html><script>1</script>",
		];
		for (const shape of shapes) {
			const p = page(shape);
			const copy = fs.readFileSync(prepareSafeCopy(p.file, p.out), "utf8");
			const meta = copy.indexOf("Content-Security-Policy");
			expect(meta).toBeGreaterThan(-1);
			expect(copy.slice(0, meta).replace(/^\uFEFF/, "").replace(/<!doctype[^>]*>/i, "")).toBe("<meta http-equiv=\"");
			expect(copy.slice(0, meta)).not.toMatch(/script|<!--/i);
		}
	});

	test("a meta refresh is disarmed even when its value is entity-encoded or holds a quoted > (#4124)", () => {
		for (const tag of [
			'<meta http-equiv="&#114;efresh" content="0;url=file:///etc/passwd">',
			'<meta content="0;url=file:///x?>" http-equiv="refresh">',
			"<META HTTP-EQUIV='Refresh' CONTENT='0;url=sibling.html'>",
		]) {
			const p = page(`<html><head>${tag}</head><body>x</body></html>`);
			const copy = fs.readFileSync(prepareSafeCopy(p.file, p.out), "utf8");
			// Only the injected CSP meta keeps a live http-equiv, and it comes first.
			expect(copy.match(/(?<![-\w])http-equiv\b/gi)).toHaveLength(1);
			expect(copy.startsWith('\uFEFF<meta http-equiv="Content-Security-Policy"')).toBe(true);
		}
	});

	test("the copy is UTF-8 with exactly one BOM before the CSP meta, and no ESC survives (#4124)", () => {
		for (const shape of [
			'<meta charset="iso-2022-jp"><meta http\x1b(B-equiv="refresh" content="0;url=file:///etc/passwd">x',
			"\uFEFF\uFEFF<!doctype html><p>x</p>",
			"<p>no bom</p>",
		]) {
			const p = page(shape);
			const out = prepareSafeCopy(p.file, p.out);
			const bytes = fs.readFileSync(out);
			expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
			const copy = bytes.toString("utf8");
			expect(copy.match(/\uFEFF/g)).toHaveLength(1);
			expect(copy.replace(/^\uFEFF(<!doctype[^>]*>)?/i, "").startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true);
			expect(copy).not.toContain("\x1b");
		}
	});

	test("a page over the size cap is refused", () => {
		const p = page("x".repeat(MAX_HTML_BYTES + 1));
		expect(() => prepareSafeCopy(p.file, p.out)).toThrow(/limit/);
	});
});

const OUTSIDE_BLOCK = '<div style="width:600px;height:300px;background:#000"></div>';
/** Share of near-black pixels inside `r` of a PNG. */
async function darkFraction(file: string, r: { x: number; y: number; w: number; h: number }): Promise<number> {
	const { data, info } = await sharp(file).flatten({ background: "#ffffff" }).raw().toBuffer({ resolveWithObject: true });
	let dark = 0;
	let total = 0;
	for (let y = r.y; y < Math.min(r.y + r.h, info.height); y++) {
		for (let x = r.x; x < Math.min(r.x + r.w, info.width); x++) {
			const i = (y * info.width + x) * info.channels;
			total++;
			if (data[i] < 64 && data[i + 1] < 64 && data[i + 2] < 64) dark++;
		}
	}
	return total ? dark / total : 0;
}
const chrome = findChrome();
const requireChrome = process.env.EIGHT_REQUIRE_CHROME === "1";
if (requireChrome) {
	test("CI has a Chrome that can start (EIGHT_REQUIRE_CHROME=1)", () => {
		expect(chrome).not.toBeNull();
	});
}
describe.skipIf(!chrome)("real Chrome stays offline and inside the page (#4081)", () => {
	const shapes: Record<string, (port: number, outsideUrl: string) => string> = {
		"plain page": (port, o) =>
			`<html><body style="margin:0"><img src="http://127.0.0.1:${port}/a.png"><script>fetch("http://127.0.0.1:${port}/f")</script><iframe src="${o}" style="border:0;width:700px;height:400px"></iframe></body></html>`,
		"script before <head>": (port, o) =>
			`<script>fetch("http://127.0.0.1:${port}/s");document.write('<iframe src="${o}" style="width:700px;height:400px">')</script><html><head></head><body style="margin:0"><iframe src="${o}" style="border:0;width:700px;height:400px"></iframe></body></html>`,
		"fake <head> in a comment": (port, o) =>
			`<!-- <head> --><script src="http://127.0.0.1:${port}/x.js"></script><html><head></head><body style="margin:0"><iframe src="${o}" style="border:0;width:700px;height:400px"></iframe></body></html>`,
	};
	for (const [name, build] of Object.entries(shapes)) {
		test(`${name}: no connection to a local listener, no outside iframe`, async () => {
			let connections = 0;
			const server = http.createServer((_req, res) => {
				connections++;
				res.end("x");
			});
			server.on("connection", () => {
				connections++;
			});
			await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
			const port = (server.address() as { port: number }).port;
			const outside = tempDir("layout-compare-outside-");
			fs.writeFileSync(path.join(outside, "big.html"), `<body style="margin:0">${OUTSIDE_BLOCK}</body>`);
			const dir = tempDir("layout-compare-real-");
			const site = path.join(dir, "site");
			fs.mkdirSync(site);
			const file = path.join(site, "index.html");
			const outsideUrl = `file://${path.join(outside, "big.html")}`;
			fs.writeFileSync(file, build(port, outsideUrl));
			const work = path.join(dir, "work");
			fs.mkdirSync(work);
			try {
				const probe = path.join(site, "probe.html");
				fs.writeFileSync(probe, "<body>probe</body>");
				try {
					await renderSafe(chrome as string, probe, path.join(work, "probe.png"), 200, 100, work);
				} catch (e) {
					if (requireChrome) throw e;
					console.warn("Chrome cannot start here; skipping the live offline test");
					return;
				}
				await renderSafe(chrome as string, file, path.join(work, "r.png"), 800, 600, work);
				await new Promise((r) => setTimeout(r, 300));
				expect(connections).toBe(0);
				// Positive control: the same page with the outside iframe swapped for a box that holds
				// the outside block inline. The detector must see it, so the checks below cannot pass
				// vacuously, and it tells us where the block would land.
				const iframeTag = `<iframe src="${outsideUrl}" style="border:0;width:700px;height:400px"></iframe>`;
				const html = build(port, outsideUrl);
				expect(html).toContain(iframeTag);
				const controlFile = path.join(site, "control.html");
				fs.writeFileSync(
					controlFile,
					html.split(iframeTag).join(`<div style="display:inline-block;width:700px;height:400px;padding:8px;box-sizing:border-box">${OUTSIDE_BLOCK}</div>`),
				);
				await renderSafe(chrome as string, controlFile, path.join(work, "control.png"), 800, 600, work);
				const control = await measureLayout(path.join(work, "control.png"));
				const block = control?.bands.find((b) => b.h >= 300 && b.spans.some((sp) => sp.w >= 600));
				expect(block).toBeDefined();
				const span = (block as Band).spans.find((sp) => sp.w >= 600) as { x: number; w: number };
				const region = { x: span.x, y: (block as Band).y, w: span.w, h: (block as Band).h };
				expect(await darkFraction(path.join(work, "control.png"), region)).toBeGreaterThan(0.9);
				// The real render: only Chrome's own placeholders (blocked frame, broken image; at most
				// 42 px) may show, and nothing dark where the outside block would have landed.
				const got = await measureLayout(path.join(work, "r.png"));
				for (const b of got?.bands ?? []) {
					expect(b.h).toBeLessThanOrEqual(50);
					for (const sp of b.spans) expect(sp.w).toBeLessThanOrEqual(50);
				}
				expect(await darkFraction(path.join(work, "r.png"), region)).toBeLessThan(0.02);
			} finally {
				server.close();
			}
		}, 60_000);
	}
});

describe.skipIf(!chrome)("real Chrome runs no page script: the CSP alone stops it (#4124)", () => {
	// Each shape tries to paint the outside block with script. Rendered raw (no CSP; the network
	// locks are irrelevant, nothing loads from the network) the block must appear, which proves
	// the shape's script really runs in this Chrome. Rendered through renderSafe it must not.
	const PAINT =
		"var d=document.createElement('div');d.style.cssText='width:600px;height:300px;background:#000;margin:20px';(document.body||document.documentElement).appendChild(d)";
	const FRAME = 'style="border:0;width:700px;height:400px"';
	const shapes: Record<string, (sibling: string) => string> = {
		"script before <head>": () => `<script>${PAINT}</script><html><head></head><body style="margin:0"></body></html>`,
		"script in the body": () => `<html><head></head><body style="margin:0"><script>${PAINT}</script></body></html>`,
		// Padded so the broken-image icon is not the top-left pixel measureLayout reads as background.
		"img onerror": () => `<html><body style="margin:0;padding:60px"><img src="x" onerror="${PAINT}"></body></html>`,
		"svg script": () => `<html><body style="margin:0"><svg width="10" height="10"><script>${PAINT}</script></svg></body></html>`,
		"iframe srcdoc script": () => `<html><body style="margin:0"><iframe ${FRAME} srcdoc="<script>${PAINT}</script>"></iframe></body></html>`,
		"iframe javascript: src": () =>
			`<html><body style="margin:0"><iframe ${FRAME} src="javascript:'<div style=width:600px;height:300px;background:#000;margin:20px></div>'"></iframe></body></html>`,
		"entity-encoded meta refresh to an unsanitised sibling": (sibling) =>
			`<html><head><meta http-equiv="&#114;efresh" content="0;url=${sibling}"></head><body style="margin:0">x</body></html>`,
		"meta refresh with a quoted > to an unsanitised sibling": (sibling) =>
			`<html><head><meta content="0;url=${sibling}?>" http-equiv="refresh"></head><body style="margin:0">x</body></html>`,
		// Written as UTF-8 bytes; in ISO-2022-JP "ESC ( B" prints nothing, so Chrome reads http-equiv.
		"iso-2022-jp charset with an escape-split http-equiv refresh to an unsanitised sibling": (sibling) =>
			`<html><head><meta charset="iso-2022-jp"><meta http\x1b(B-equiv="refresh" content="0;url=${sibling}"></head><body style="margin:0">x</body></html>`,
	};
	for (const [name, build] of Object.entries(shapes)) {
		test(`${name}: paints with script when raw, paints nothing through renderSafe`, async () => {
			const dir = tempDir("layout-compare-script-");
			const site = path.join(dir, "site");
			fs.mkdirSync(site);
			const sibling = path.join(site, "sibling.html");
			fs.writeFileSync(sibling, `<html><body style="margin:0"><script>${PAINT}</script></body></html>`);
			const file = path.join(site, "index.html");
			fs.writeFileSync(file, build(pathToFileURL(sibling).href));
			const work = path.join(dir, "work");
			fs.mkdirSync(work);
			const probe = path.join(site, "probe.html");
			fs.writeFileSync(probe, "<body>probe</body>");
			try {
				await renderSafe(chrome as string, probe, path.join(work, "probe.png"), 200, 100, work);
			} catch (e) {
				if (requireChrome) throw e;
				console.warn("Chrome cannot start here; skipping the live script test");
				return;
			}
			const whole = { x: 0, y: 0, w: 800, h: 600 };
			await renderHtml(chrome as string, file, path.join(work, "raw.png"), 800, 600, path.join(work, "raw-profile"));
			expect(await darkFraction(path.join(work, "raw.png"), whole)).toBeGreaterThan(0.3);
			await renderSafe(chrome as string, file, path.join(work, "safe.png"), 800, 600, work);
			const got = await measureLayout(path.join(work, "safe.png"));
			for (const b of got?.bands ?? []) {
				expect(b.h).toBeLessThanOrEqual(50);
				for (const sp of b.spans) expect(sp.w).toBeLessThanOrEqual(50);
			}
			expect(await darkFraction(path.join(work, "safe.png"), whole)).toBeLessThan(0.02);
		}, 60_000);
	}
});
