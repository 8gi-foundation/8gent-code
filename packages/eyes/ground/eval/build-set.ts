/**
 * Build the labelled grounding set: real 8gent Browser screenshots of our own
 * pages (local test pages, the pilot's browser-op fixture site, real TUI
 * frames), each target's box measured by the browser itself (page.query
 * getBoundingClientRect), never drawn by hand.
 *
 *   bun packages/eyes/ground/eval/build-set.ts [outDir]
 *
 * Output: <outDir>/labels.json plus one PNG per screenshot. Default outDir is
 * ~/.8gent/ground-eval/set. Every tab the build opens is closed again.
 */
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { safeBunFlags } from "../../../core/bun-flags";
import { call, sleep } from "./browser.js";
import { PAGES } from "./pages.js";
import { tuiFrames } from "./tui-frames.js";

type Rect = { x: number; y: number; w: number; h: number };
interface El {
	index: number;
	tag: string;
	text: string;
	rect: Rect;
	visible: boolean;
}
export interface LabelTarget {
	instruction: string;
	/** [x1, y1, x2, y2] in screenshot pixels. */
	box: [number, number, number, number];
	/** Index into `elements` (8gent Browser's actionable set), or -1 if the target is not an actionable node. */
	elementIndex: number;
}
export interface LabelShot {
	id: string;
	png: string;
	source: "test-page" | "fixture-site" | "tui";
	viewport: { w: number; h: number };
	/** Screenshot pixels per CSS pixel. */
	scale: number;
	targets: LabelTarget[];
	elements: El[];
}

const out = process.argv[2] ?? join(homedir(), ".8gent", "ground-eval", "set");
mkdirSync(out, { recursive: true });
const shots: LabelShot[] = [];
const opened: string[] = [];

async function open(url: string): Promise<string> {
	const r = await call<{ id: string }>("tab.open", { url });
	opened.push(r.id);
	await sleep(1200);
	return r.id;
}

async function measure(
	tabId: string,
	id: string,
	source: LabelShot["source"],
	targets: { instruction: string; selector: string }[],
): Promise<void> {
	const root = await call<{ elements: El[] }>("page.query", { tabId, selector: "html" });
	const elements = (await call<{ elements: El[] }>("page.query", { tabId })).elements;
	const shot = await call<{ savedTo: string; width: number; height: number }>("page.screenshot", {
		tabId,
	});
	// Viewport width = the html element's box (no horizontal scroll on these pages).
	const vw = root.elements[0].rect.w;
	const scale = shot.width / vw;
	const viewport = { w: vw, h: Math.round(shot.height / scale) };
	const labelled: LabelTarget[] = [];
	for (const t of targets) {
		const q = await call<{ elements: El[] }>("page.query", { tabId, selector: t.selector });
		const el = q.elements[0];
		if (!el?.visible) throw new Error(`${id}: target ${t.selector} not visible`);
		const r = el.rect;
		const idx = elements.findIndex(
			(e) => e.rect.x === r.x && e.rect.y === r.y && e.rect.w === r.w && e.rect.h === r.h,
		);
		labelled.push({
			instruction: t.instruction,
			box: [r.x * scale, r.y * scale, (r.x + r.w) * scale, (r.y + r.h) * scale].map(
				Math.round,
			) as LabelTarget["box"],
			elementIndex: idx,
		});
	}
	const png = `${id}.png`;
	copyFileSync(shot.savedTo, join(out, png));
	shots.push({ id, png, source, viewport, scale, targets: labelled, elements });
	console.log(
		`${id}: ${shot.width}x${shot.height} scale ${scale.toFixed(2)}, ${labelled.length} targets, ${elements.length} elements`,
	);
}

/** A 1x copy of an existing shot: same targets, boxes halved. Tests a non-retina frame. */
async function oneX(srcId: string): Promise<void> {
	const s = shots.find((x) => x.id === srcId);
	if (!s) return;
	const f = 1 / s.scale;
	const id = `${srcId}-1x`;
	const sharp = (await import("sharp")).default;
	await sharp(join(out, s.png))
		.resize(Math.round(s.viewport.w), Math.round(s.viewport.h), { fit: "fill" })
		.png()
		.toFile(join(out, `${id}.png`));
	shots.push({
		...s,
		id,
		png: `${id}.png`,
		scale: 1,
		targets: s.targets.map((t) => ({
			...t,
			box: t.box.map((v) => Math.round(v * f)) as LabelTarget["box"],
		})),
	});
	console.log(`${id}: downscaled copy`);
}

const dataUrl = (html: string) => `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

try {
	for (const p of PAGES) await measure(await open(dataUrl(p.html)), p.id, "test-page", p.targets);
	for (const f of await tuiFrames())
		await measure(await open(dataUrl(f.html)), f.id, "tui", f.targets);

	// The pilot's own browser-op fixture site: real server, real login flow.
	const fixture = join(
		homedir(),
		".8gent",
		"rishi-pilot",
		"fixtures",
		"setup",
		"browser-op-server.ts",
	);
	if (existsSync(fixture)) {
		const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ground-fixture-"));
		const proc = Bun.spawn(["bun", ...safeBunFlags(), fixture, dir, "maeve", "orchard-42"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		for (let i = 0; i < 50 && !existsSync(join(dir, "port")); i++) await sleep(100);
		const port = readFileSync(join(dir, "port"), "utf8").trim();
		const tab = await open(`http://127.0.0.1:${port}/`);
		await measure(tab, "fixture-login", "fixture-site", [
			{ instruction: "the Username field", selector: "input[name=username]" },
			{ instruction: "the Password field", selector: "input[name=password]" },
			{ instruction: "the Sign in button", selector: "button[type=submit]" },
		]);
		await call("page.type", { tabId: tab, selector: "input[name=username]", text: "maeve" });
		await call("page.type", { tabId: tab, selector: "input[name=password]", text: "orchard-42" });
		await call("page.click", { tabId: tab, selector: "button[type=submit]" });
		await sleep(1500);
		await measure(tab, "fixture-settings", "fixture-site", [
			{ instruction: "the Weekly digest checkbox", selector: "input[name=digest]" },
			{ instruction: "the Save button", selector: "button[type=submit]" },
		]);
		proc.kill();
	}

	for (const id of ["contact-form", "file-table", "inbox", "fixture-login"]) await oneX(id);
	writeFileSync(join(out, "labels.json"), `${JSON.stringify(shots, null, 1)}\n`);
	console.log(
		`wrote ${shots.length} screenshots, ${shots.reduce((n, s) => n + s.targets.length, 0)} targets to ${out}`,
	);
} finally {
	for (const id of opened) await call("tab.close", { id }).catch(() => {});
}
