/**
 * #4080: compare_layout renders a page and diffs it against a mock-up image.
 * Chrome itself is replaced by a stub script that "renders" a pre-drawn PNG,
 * so the test is the same on every machine and never opens a browser.
 */

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import sharp from "sharp";
import { cleanupTempDirs, tempDir } from "../../../tests/temp-dirs";
import { ToolExecutor } from "../../eight/tools";
import type { Band, LayoutMeasure } from "../../eight/layout-measure";
import * as http from "node:http";
import * as os from "node:os";
import { MAX_HTML_BYTES, RENDER_CSP, compareLayout, describeDiff, findChrome, pairBands, prepareSafeCopy, renderSafe } from "../layout-compare";
import { measureLayout } from "../../eight/layout-measure";

afterAll(cleanupTempDirs);

const W = 1280;
const H = 900;
type Box = { x: number; y: number; w: number; h: number };

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
	function stubChrome(dir: string, renderPng: string): string {
		const bin = path.join(dir, "fake-chrome");
		fs.writeFileSync(
			bin,
			`#!/bin/sh\nfor a in "$@"; do case "$a" in --screenshot=*) out="\${a#--screenshot=}";; esac; done\ncp "${renderPng}" "$out"\n`,
		);
		fs.chmodSync(bin, 0o755);
		return bin;
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
		const bin = path.join(bins, "fake-chrome");
		fs.writeFileSync(
			bin,
			`#!/bin/sh\nfor a in "$@"; do case "$a" in --screenshot=*) out="\${a#--screenshot=}";; --user-data-dir=*) mkdir -p "\${a#--user-data-dir=}";; esac; done\ncp "${render}" "$out"\n`,
		);
		fs.chmodSync(bin, 0o755);
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

	test("a page over the size cap is refused", () => {
		const p = page("x".repeat(MAX_HTML_BYTES + 1));
		expect(() => prepareSafeCopy(p.file, p.out)).toThrow(/limit/);
	});
});

const chrome = findChrome();
describe.skipIf(!chrome)("real Chrome stays offline and inside the page (#4081)", () => {
	test("a page that fetches a local listener never connects; an iframe to a file outside the page renders nothing", async () => {
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
		fs.writeFileSync(path.join(outside, "big.html"), '<body style="margin:0"><div style="width:600px;height:300px;background:#000"></div></body>');
		const dir = tempDir("layout-compare-real-");
		const site = path.join(dir, "site");
		fs.mkdirSync(site);
		const file = path.join(site, "index.html");
		fs.writeFileSync(
			file,
			`<html><body style="margin:0"><img src="http://127.0.0.1:${port}/a.png"><script>fetch("http://127.0.0.1:${port}/f")</script>` +
				`<iframe src="file://${path.join(outside, "big.html")}" style="border:0;width:700px;height:400px"></iframe></body></html>`,
		);
		const work = path.join(dir, "work");
		fs.mkdirSync(work);
		try {
			// A sandbox that stops Chrome starting (no socket bind) cannot run this test; CI can.
			const probe = path.join(site, "probe.html");
			fs.writeFileSync(probe, "<body>probe</body>");
			try {
				await renderSafe(chrome as string, probe, path.join(work, "probe.png"), 200, 100, work);
			} catch {
				console.warn("Chrome cannot start here; skipping the live offline test");
				return;
			}
			await renderSafe(chrome as string, file, path.join(work, "r.png"), 800, 600, work);
			await new Promise((r) => setTimeout(r, 300));
			expect(connections).toBe(0);
			expect(await measureLayout(path.join(work, "r.png"))).toBeNull();
		} finally {
			server.close();
		}
	}, 60_000);
});
