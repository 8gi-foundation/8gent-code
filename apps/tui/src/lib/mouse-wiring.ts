/**
 * Wires the mouse layer to the HUD at startup (#3239): clicks and drags go
 * to the click targets, a selection copies with OSC 52, and the text under a
 * selection is read from Ink's last frame. Wheel events are left to
 * useMouseScroll.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { copyText } from "./copy-answer.js";
import { handleMouse, onSelectionChange, setSelectionIO } from "./click-targets.js";
import { installMouse, onMouse } from "./mouse-input.js";
import { type SelRange, osc52, paintSelection } from "./text-selection.js";

export { osc52 };

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

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
	setSelectionIO(
		() => lastFrame(),
		(text) => {
			copyText(text, { write: (seq) => process.stdout.write(seq) });
		},
	);
	// The highlight is drawn straight onto the screen over Ink's frame, and
	// drawn again after every frame Ink writes, because a redraw erases it.
	let shown: SelRange | null = null;
	let wanted: SelRange | null = null;
	let painting = false;
	const paint = () => {
		const out = paintSelection(lastRaw(), lastFrame(), shown, wanted);
		shown = wanted;
		if (!out) return;
		painting = true;
		try {
			process.stdout.write(out);
		} catch {
			/* stdout closed */
		}
		painting = false;
	};
	onSelectionChange((range) => {
		wanted = range;
		paint();
	});
	const rawWrite = process.stdout.write.bind(process.stdout) as (...a: unknown[]) => boolean;
	let repaintQueued = false;
	process.stdout.write = ((...a: unknown[]) => {
		const ok = rawWrite(...a);
		if (!painting && wanted && !repaintQueued) {
			repaintQueued = true;
			setImmediate(() => {
				repaintQueued = false;
				shown = null;
				paint();
			});
		}
		return ok;
	}) as typeof process.stdout.write;
	onMouse((e) => {
		if (e.kind !== "wheel" && e.kind !== "move") handleMouse(e);
	});
	return true;
}
