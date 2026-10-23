// Builds docs/architecture/*.excalidraw, *.svg, *.png and the sources tables.
//
//   ARCH_DEPS=/path/with/node_modules node docs/architecture/tools/build.mjs
//
// ARCH_DEPS must hold `roughjs` (and `@excalidraw/utils` + `jsdom` for the
// optional --validate pass). They are deliberately NOT repo dependencies: this
// is documentation tooling, so it adds nothing to package.json or bun.lock.
// PNG export uses `rsvg-convert` (librsvg) when it is on PATH.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KIND, Scene, resolveArrow, wrap } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..");
const deps = process.env.ARCH_DEPS;
if (!deps) throw new Error("set ARCH_DEPS to a directory whose node_modules has roughjs");
const req = createRequire(join(deps, "x.js"));
const rough = req("roughjs/bundled/rough.cjs.js");
const gen = rough.generator();

const FONT = "Marker Felt, Comic Sans MS, Segoe Print, cursive";
const hash = (s) => {
	let h = 2166136261;
	for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
	return (h >>> 0) % 2147483647;
};
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function bounds(sc) {
	let x0 = 0;
	let y0 = 0;
	let x1 = 0;
	let y1 = 0;
	const add = (x, y, w, h) => {
		x0 = Math.min(x0, x);
		y0 = Math.min(y0, y);
		x1 = Math.max(x1, x + w);
		y1 = Math.max(y1, y + h);
	};
	for (const b of sc.boxes.values()) add(b.x, b.y, b.w, b.h);
	for (const f of sc.frames) add(f.x, f.y, f.w, f.h);
	for (const n of sc.notes) add(n.x, n.y, n.w ?? 600, 60);
	return { x0: x0 - 60, y0: y0 - 160, x1: x1 + 60, y1: y1 + 60 };
}

// ---------------------------------------------------------------- excalidraw
function excalidraw(sc) {
	const els = [];
	let z = 0;
	const base = (id, type, x, y, w, h, extra = {}) => ({
		id,
		type,
		x,
		y,
		width: w,
		height: h,
		angle: 0,
		strokeColor: "#1e1e1e",
		backgroundColor: "transparent",
		fillStyle: "solid",
		strokeWidth: 2,
		strokeStyle: "solid",
		roughness: 1,
		opacity: 100,
		groupIds: [],
		frameId: null,
		roundness: null,
		seed: hash(id),
		version: 1,
		versionNonce: hash(id + "n"),
		isDeleted: false,
		boundElements: null,
		updated: 1760000000000 + z++,
		link: null,
		locked: false,
		...extra,
	});
	const text = (id, x, y, lines, fs, color, o = {}) => {
		const t = lines.join("\n");
		return base(
			id,
			"text",
			x,
			y,
			o.w ?? Math.ceil(Math.max(...lines.map((l) => l.length)) * fs * 0.56),
			Math.ceil(lines.length * fs * 1.25),
			{
				strokeColor: color,
				text: t,
				originalText: t,
				fontSize: fs,
				fontFamily: 1,
				textAlign: o.align ?? "left",
				verticalAlign: o.valign ?? "top",
				containerId: o.container ?? null,
				lineHeight: 1.25,
				autoResize: true,
				baseline: Math.round(fs * 0.9),
				groupIds: o.groups ?? [],
			},
		);
	};
	// title
	els.push(text("title", bounds(sc).x0 + 60, bounds(sc).y0 + 40, [sc.title], 40, "#1e1e1e"));
	els.push(
		text(
			"subtitle",
			bounds(sc).x0 + 60,
			bounds(sc).y0 + 95,
			wrap(sc.subtitle, 18, 2400),
			18,
			"#495057",
		),
	);
	sc.frames.forEach((f, i) => {
		const k = KIND[f.kind];
		els.push(
			base(`frame${i}`, "rectangle", f.x, f.y, f.w, f.h, {
				strokeColor: k.stroke,
				strokeStyle: "dashed",
				strokeWidth: 2,
				opacity: 80,
			}),
		);
		els.push(text(`frame${i}t`, f.x + 16, f.y + 10, [f.title], 22, k.stroke));
		if (f.sub)
			els.push(text(`frame${i}s`, f.x + 16, f.y + 40, wrap(f.sub, 14, f.w - 32), 14, "#495057"));
	});
	const rects = new Map();
	for (const id of sc.order) {
		const b = sc.boxes.get(id);
		const k = KIND[b.kind];
		const r = base(`box_${id}`, "rectangle", b.x, b.y, b.w, b.h, {
			strokeColor: k.stroke,
			backgroundColor: k.bg,
			strokeStyle: k.dash ? "dashed" : "solid",
			strokeWidth: k.bold ? 3 : 2,
			groupIds: [`g_${id}`],
			boundElements: [],
		});
		rects.set(id, r);
		els.push(r);
		let cy = b.y + 8;
		els.push(
			text(`box_${id}_t`, b.x + 10, cy, b.tl, b.tfs, "#1e1e1e", {
				groups: [`g_${id}`],
				w: b.w - 20,
			}),
		);
		cy += b.tl.length * b.tfs * 1.25 + 2;
		if (b.bl.length)
			els.push(
				text(`box_${id}_b`, b.x + 10, cy, b.bl, b.bfs, "#495057", {
					groups: [`g_${id}`],
					w: b.w - 20,
				}),
			);
	}
	sc.arrows.forEach((a, i) => {
		const { f, t, p0, p1 } = resolveArrow(sc, a);
		const id = `arrow${i}`;
		const color = a.color ?? (a.kind === "gap" ? "#e03131" : "#1e1e1e");
		const arr = base(id, "arrow", p0[0], p0[1], p1[0] - p0[0], p1[1] - p0[1], {
			strokeColor: color,
			strokeStyle: a.dashed ? "dashed" : "solid",
			points: [
				[0, 0],
				[p1[0] - p0[0], p1[1] - p0[1]],
			],
			lastCommittedPoint: null,
			startBinding: { elementId: `box_${a.from}`, focus: 0, gap: 6 },
			endBinding: { elementId: `box_${a.to}`, focus: 0, gap: 6 },
			startArrowhead: a.both ? "arrow" : null,
			endArrowhead: "arrow",
			elbowed: false,
			boundElements: [],
		});
		rects.get(a.from).boundElements.push({ id, type: "arrow" });
		rects.get(a.to).boundElements.push({ id, type: "arrow" });
		els.push(arr);
		if (a.label) {
			const lines = wrap(a.label, 13, 220);
			const tw = Math.ceil(Math.max(...lines.map((l) => l.length)) * 13 * 0.56);
			const lbl = text(
				`${id}_l`,
				(p0[0] + p1[0]) / 2 - tw / 2,
				(p0[1] + p1[1]) / 2 - lines.length * 8,
				lines,
				13,
				color,
				{ align: "center", valign: "middle", container: id },
			);
			arr.boundElements.push({ id: lbl.id, type: "text" });
			els.push(lbl);
		}
	});
	sc.notes.forEach((n, i) =>
		els.push(text(`note${i}`, n.x, n.y, wrap(n.text, n.fs, n.w ?? 600), n.fs, n.color)),
	);
	// z-order: frames, arrows, boxes, arrow labels. Lines pass behind box text, labels stay readable.
	const rank = (e) =>
		e.type === "arrow" ? 1 : /^arrow\d+_l$/.test(e.id) ? 3 : e.id.startsWith("box_") ? 2 : 0;
	els.sort((a, b) => rank(a) - rank(b));
	return {
		type: "excalidraw",
		version: 2,
		source: "docs/architecture/tools/build.mjs",
		elements: els,
		appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
		files: {},
	};
}

// ---------------------------------------------------------------------- svg
function svg(sc) {
	const B = bounds(sc);
	const W = B.x1 - B.x0;
	const H = B.y1 - B.y0;
	const out = [];
	const path = (drawable, fill) =>
		gen
			.toPaths(drawable)
			.map(
				(p) =>
					`<path d="${p.d}" stroke="${p.stroke}" stroke-width="${p.strokeWidth}" fill="${p.fill && p.fill !== "none" ? p.fill : "none"}"${drawable.options.strokeLineDash ? ` stroke-dasharray="${drawable.options.strokeLineDash.join(" ")}"` : ""} stroke-linecap="round" stroke-linejoin="round"/>`,
			)
			.join("");
	const textEl = (x, y, lines, fs, color, anchor = "start") =>
		`<text x="${x}" y="${y}" font-family="${FONT}" font-size="${fs}" fill="${color}" text-anchor="${anchor}">${lines.map((l, i) => `<tspan x="${x}" dy="${i === 0 ? fs : fs * 1.25}">${esc(l)}</tspan>`).join("")}</text>`;
	out.push(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${B.x0} ${B.y0} ${W} ${H}" width="${W}" height="${H}">`,
	);
	out.push(`<rect x="${B.x0}" y="${B.y0}" width="${W}" height="${H}" fill="#ffffff"/>`);
	out.push(textEl(B.x0 + 60, B.y0 + 40, [sc.title], 40, "#1e1e1e"));
	out.push(textEl(B.x0 + 60, B.y0 + 95, wrap(sc.subtitle, 18, 2400), 18, "#495057"));
	sc.frames.forEach((f, i) => {
		const k = KIND[f.kind];
		out.push(
			path(
				gen.rectangle(f.x, f.y, f.w, f.h, {
					roughness: 1,
					seed: hash(`frame${i}`),
					stroke: k.stroke,
					strokeWidth: 2,
					strokeLineDash: [10, 8],
				}),
			),
		);
		out.push(textEl(f.x + 16, f.y + 10, [f.title], 22, k.stroke));
		if (f.sub) out.push(textEl(f.x + 16, f.y + 40, wrap(f.sub, 14, f.w - 32), 14, "#495057"));
	});
	const labels = [];
	sc.arrows.forEach((a, i) => {
		const { p0, p1 } = resolveArrow(sc, a);
		const color = a.color ?? (a.kind === "gap" ? "#e03131" : "#1e1e1e");
		const o = { roughness: 1, seed: hash(`arrow${i}`), stroke: color, strokeWidth: 2 };
		if (a.dashed) o.strokeLineDash = [8, 6];
		out.push(path(gen.line(p0[0], p0[1], p1[0], p1[1], o)));
		const head = (from, to) => {
			const ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
			const pts = [-0.45, 0.45].map((d) => [
				to[0] - 16 * Math.cos(ang + d),
				to[1] - 16 * Math.sin(ang + d),
			]);
			pts.forEach((p) =>
				out.push(
					path(
						gen.line(to[0], to[1], p[0], p[1], {
							roughness: 0.6,
							seed: hash(`h${i}`),
							stroke: color,
							strokeWidth: 2,
						}),
					),
				),
			);
		};
		head(p0, p1);
		if (a.both) head(p1, p0);
		if (a.label)
			labels.push({
				lines: wrap(a.label, 13, 220),
				mx: (p0[0] + p1[0]) / 2,
				my: (p0[1] + p1[1]) / 2,
				color,
			});
	});
	for (const id of sc.order) {
		const b = sc.boxes.get(id);
		const k = KIND[b.kind];
		const o = {
			roughness: 1,
			seed: hash(`box_${id}`),
			stroke: k.stroke,
			strokeWidth: k.bold ? 3 : 2,
			fill: k.bg,
			fillStyle: "solid",
		};
		if (k.dash) o.strokeLineDash = [9, 6];
		out.push(path(gen.rectangle(b.x, b.y, b.w, b.h, o)));
		out.push(textEl(b.x + 10, b.y + 8, b.tl, b.tfs, "#1e1e1e"));
		if (b.bl.length)
			out.push(textEl(b.x + 10, b.y + 8 + b.tl.length * b.tfs * 1.25 + 2, b.bl, b.bfs, "#495057"));
	}
	for (const l of labels) {
		const tw = Math.ceil(Math.max(...l.lines.map((s) => s.length)) * 13 * 0.56) + 10;
		const th = l.lines.length * 13 * 1.25 + 6;
		out.push(
			`<rect x="${l.mx - tw / 2}" y="${l.my - th / 2}" width="${tw}" height="${th}" fill="#ffffff" fill-opacity="0.88" rx="4"/>`,
		);
		out.push(textEl(l.mx, l.my - th / 2 + 3, l.lines, 13, l.color, "middle"));
	}
	sc.notes.forEach((n) =>
		out.push(textEl(n.x, n.y, wrap(n.text, n.fs, n.w ?? 600), n.fs, n.color)),
	);
	out.push("</svg>");
	return out.join("\n");
}

// ------------------------------------------------------------- sources table
export function sourcesMarkdown(sc) {
	const rows = [];
	rows.push(`| Box | Kind | Source path |`, `|---|---|---|`);
	for (const id of sc.order) {
		const b = sc.boxes.get(id);
		if (b.tag === "legend") continue;
		rows.push(
			`| ${b.tl.join(" ").replace(/\|/g, "/")} | ${b.kind} | ${b.src.replace(/\|/g, "/")} |`,
		);
	}
	rows.push("", `| Arrow (from -> to) | What flows | Source path |`, `|---|---|---|`);
	for (const a of sc.arrows) {
		const f = sc.boxes.get(a.from).tl.join(" ");
		const t = sc.boxes.get(a.to).tl.join(" ");
		rows.push(
			`| ${f} -> ${t} | ${(a.label ?? "").replace(/\|/g, "/")} | ${a.src.replace(/\|/g, "/")} |`,
		);
	}
	return rows.join("\n");
}

const TSV = [];
export function buildScene(file, sc) {
	mkdirSync(outDir, { recursive: true });
	writeFileSync(join(outDir, `${file}.excalidraw`), JSON.stringify(excalidraw(sc), null, 1));
	const s = svg(sc);
	writeFileSync(join(outDir, `${file}.svg`), s);
	const r = spawnSync(
		"rsvg-convert",
		["-z", "1", "-o", join(outDir, `${file}.png`), join(outDir, `${file}.svg`)],
		{ encoding: "utf8" },
	);
	if (r.status !== 0) console.error(`PNG export skipped for ${file}: ${r.stderr || r.error}`);
	for (const id of sc.order) {
		const b = sc.boxes.get(id);
		if (b.tag !== "legend") TSV.push(["box", file, b.tl.join(" "), b.kind, b.src].join("\t"));
	}
	for (const a of sc.arrows)
		TSV.push(
			[
				"arrow",
				file,
				`${sc.boxes.get(a.from).tl.join(" ")} -> ${sc.boxes.get(a.to).tl.join(" ")}: ${a.label ?? ""}`,
				a.kind ?? "flow",
				a.src,
			].join("\t"),
		);
	return sourcesMarkdown(sc);
}

buildScene.TSV = TSV;
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const { default: main } = await import("./scenes.mjs");
	await main(buildScene);
}
