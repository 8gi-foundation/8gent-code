// Scene model shared by the four diagram builders. One scene produces three
// artifacts: an .excalidraw file, an SVG (hand-drawn with roughjs) and the
// sources table rows. Every box and arrow must carry `src` (a repo path);
// build.mjs refuses to write a scene that has a box or arrow without one.

export const KIND = {
	entry: { stroke: "#1971c2", bg: "#d0ebff", dash: false },
	app: { stroke: "#2f9e44", bg: "#d3f9d8", dash: false },
	pkg: { stroke: "#e67700", bg: "#fff3bf", dash: false },
	daemon: { stroke: "#d9480f", bg: "#ffe8cc", dash: false },
	ext: { stroke: "#0b7285", bg: "#c5f6fa", dash: false },
	optin: { stroke: "#868e96", bg: "#f1f3f5", dash: true },
	out: { stroke: "#495057", bg: "#e9ecef", dash: false },
	gap: { stroke: "#e03131", bg: "#ffc9c9", dash: true, bold: true },
	unv: { stroke: "#e8590c", bg: "#fff9db", dash: true, bold: true },
	plain: { stroke: "#868e96", bg: "#ffffff", dash: false },
};

const CW = 0.56; // average glyph width in em for the hand font
const LH = 1.25;

export function textSize(lines, fs) {
	const w = Math.max(...lines.map((l) => l.length)) * fs * CW;
	return { w: Math.ceil(w), h: Math.ceil(lines.length * fs * LH) };
}

// Greedy word wrap to a width in px.
export function wrap(text, fs, maxW) {
	const maxChars = Math.max(8, Math.floor(maxW / (fs * CW)));
	const out = [];
	for (const para of String(text).split("\n")) {
		let line = "";
		for (const word of para.split(" ")) {
			if ((line + " " + word).trim().length > maxChars && line) {
				out.push(line);
				line = word;
			} else line = (line + " " + word).trim();
		}
		out.push(line);
	}
	return out;
}

export class Scene {
	constructor(name, title, subtitle) {
		this.name = name;
		this.title = title;
		this.subtitle = subtitle;
		this.boxes = new Map();
		this.frames = [];
		this.arrows = [];
		this.notes = [];
		this.order = [];
		this.n = 0;
	}
	id(prefix) {
		return `${prefix}${++this.n}`;
	}
	// A box with a title (bold-ish, larger) and body lines (smaller).
	box(id, o) {
		if (this.boxes.has(id)) throw new Error(`duplicate box ${id}`);
		if (!o.src) throw new Error(`box ${id} has no src path`);
		const tfs = o.tfs ?? 17;
		const bfs = o.bfs ?? 13;
		const maxW = (o.w ?? 300) - 20;
		const tl = wrap(o.title, tfs, maxW);
		const bl = (o.body ?? []).flatMap((b) => wrap(b, bfs, maxW));
		const h = o.h ?? Math.ceil(tl.length * tfs * LH + bl.length * bfs * LH + 22);
		const w =
			o.w ?? Math.ceil(Math.max(textSize(tl, tfs).w, bl.length ? textSize(bl, bfs).w : 0) + 24);
		const b = {
			id,
			x: o.x,
			y: o.y,
			w,
			h,
			tl,
			bl,
			tfs,
			bfs,
			kind: o.kind ?? "plain",
			src: o.src,
			tag: o.tag,
		};
		this.boxes.set(id, b);
		this.order.push(id);
		return b;
	}
	// Dashed group outline with a title. Not a traceable component, no src needed.
	frame(o) {
		const f = { ...o, kind: o.kind ?? "plain" };
		this.frames.push(f);
		return f;
	}
	// Lay boxes out in a grid starting at (x,y); returns bounding box.
	grid(x, y, cols, cellW, gapX, gapY, items, mk) {
		let row = 0;
		let maxBottom = y;
		const rowH = [];
		items.forEach((it, i) => {
			const col = i % cols;
			row = Math.floor(i / cols);
			const b = mk(it, x + col * (cellW + gapX), 0, cellW);
			(rowH[row] ??= []).push(b);
		});
		let cy = y;
		rowH.forEach((bs) => {
			const h = Math.max(...bs.map((b) => b.h));
			bs.forEach((b) => {
				b.y = cy;
				b.h = h;
			});
			cy += h + gapY;
			maxBottom = cy - gapY;
		});
		return { x, y, w: cols * cellW + (cols - 1) * gapX, h: maxBottom - y };
	}
	// Mark a box with a gap id so the red card in the gap column can be found by its tag.
	tag(id, gapId) {
		const b = this.boxes.get(id);
		if (!b) throw new Error(`tag: unknown box ${id}`);
		b.tl[b.tl.length - 1] += `  [${gapId}]`;
	}
	arrow(from, to, label, o = {}) {
		if (!o.src) throw new Error(`arrow ${from}->${to} (${label}) has no src path`);
		this.arrows.push({ from, to, label, ...o });
	}
	note(x, y, text, o = {}) {
		this.notes.push({ x, y, text, fs: o.fs ?? 15, color: o.color ?? "#343a40", w: o.w });
	}
	// Legend placed at (x,y).
	legend(x, y, kinds) {
		let cy = y;
		for (const [k, label] of kinds) {
			const id = `legend_${k}`;
			this.box(id, {
				x,
				y: cy,
				w: 340,
				h: 34,
				title: label,
				tfs: 14,
				kind: k,
				src: "docs/architecture/README.md",
				tag: "legend",
			});
			cy += 44;
		}
	}
}

// Rectangle edge point on the ray from the box center toward (tx,ty).
export function edgePoint(b, tx, ty, gap = 6) {
	const cx = b.x + b.w / 2;
	const cy = b.y + b.h / 2;
	const dx = tx - cx;
	const dy = ty - cy;
	if (dx === 0 && dy === 0) return [cx, cy];
	const sx = (b.w / 2 + gap) / Math.abs(dx || 1e-9);
	const sy = (b.h / 2 + gap) / Math.abs(dy || 1e-9);
	const s = Math.min(sx, sy);
	return [cx + dx * s, cy + dy * s];
}

export function resolveArrow(scene, a) {
	const f = scene.boxes.get(a.from);
	const t = scene.boxes.get(a.to);
	if (!f) throw new Error(`arrow from unknown box ${a.from}`);
	if (!t) throw new Error(`arrow to unknown box ${a.to}`);
	const tc = [t.x + t.w / 2, t.y + t.h / 2];
	const fc = [f.x + f.w / 2, f.y + f.h / 2];
	const p0 = edgePoint(f, tc[0], tc[1]);
	const p1 = edgePoint(t, fc[0], fc[1]);
	return { f, t, p0, p1 };
}
