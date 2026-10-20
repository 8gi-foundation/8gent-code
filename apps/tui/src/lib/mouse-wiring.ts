/**
 * Wires the mouse layer to the HUD at startup (#3239): clicks and drags go
 * to the click targets, a selection copies with OSC 52, and the text under a
 * selection is read from Ink's last frame. Wheel events are left to
 * useMouseScroll.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { handleMouse, onSelectionChange, setSelectionIO } from "./click-targets.js";
import { type CopyDeps, copyText } from "./copy-answer.js";
import { installMouse, onMouse } from "./mouse-input.js";
import { type SelRange, osc52, paintSelection } from "./text-selection.js";

export { osc52 };

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export interface SelectionWiring {
	/** The last frame Ink drew, styled. */
	raw: () => string;
	/** The same frame, ANSI stripped. */
	plain: () => string;
	out: { write: (s: string) => unknown };
	copyDeps?: Partial<Omit<CopyDeps, "write">>;
}

/**
 * Connect selection to a screen: the copier, the highlight painter and the
 * mouse events. Returns `repaint` (call after any foreign write, since a
 * redraw erases the highlight) and an `off`.
 */
export function wireSelection(w: SelectionWiring): { repaint: () => void; off: () => void } {
	setSelectionIO(w.plain, (text) =>
		copyText(text, { ...w.copyDeps, write: (seq) => w.out.write(seq) }),
	);
	let shown: SelRange | null = null;
	let wanted: SelRange | null = null;
	const paint = () => {
		const out = paintSelection(w.raw(), w.plain(), shown, wanted);
		shown = wanted;
		if (!out) return;
		try {
			w.out.write(out);
		} catch {
			/* stdout closed */
		}
	};
	const offSel = onSelectionChange((range) => {
		wanted = range;
		paint();
	});
	const offMouse = onMouse((e) => {
		if (e.kind !== "wheel" && e.kind !== "move") handleMouse(e);
	});
	return {
		repaint: () => {
			if (!wanted) return;
			shown = null;
			paint();
		},
		off: () => {
			offSel();
			offMouse();
		},
	};
}

export function startMouse(): boolean {
	const inst = installMouse();
	if (!inst) return false;
	let lastFrame: () => string = () => "";
	let lastRaw: () => string = () => "";
	// Ink keeps its last frame on the instance; the instances map is not in
	// its exports, so it is loaded by file. Without it, selection copies nothing.
	try {
		const req = createRequire(import.meta.url);
		const dir = path.dirname(req.resolve("ink"));
		void import(pathToFileURL(path.join(dir, "instances.js")).href).then((m) => {
			const instances = m.default as WeakMap<object, { lastOutput?: string }>;
			lastRaw = () => instances.get(process.stdout)?.lastOutput ?? "";
			lastFrame = () => lastRaw().replace(ANSI, "");
		});
	} catch {
		/* no selection copy */
	}
	const rawWrite = process.stdout.write.bind(process.stdout) as (...a: unknown[]) => boolean;
	let painting = false;
	const { repaint } = wireSelection({
		raw: () => lastRaw(),
		plain: () => lastFrame(),
		out: {
			write: (s) => {
				painting = true;
				try {
					return rawWrite(s);
				} finally {
					painting = false;
				}
			},
		},
	});
	// Ink's redraw erases the highlight: draw it again after each frame.
	let repaintQueued = false;
	process.stdout.write = ((...a: unknown[]) => {
		const ok = rawWrite(...a);
		if (!painting && !repaintQueued) {
			repaintQueued = true;
			setImmediate(() => {
				repaintQueued = false;
				repaint();
			});
		}
		return ok;
	}) as typeof process.stdout.write;
	return true;
}
