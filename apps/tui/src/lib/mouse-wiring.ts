/**
 * Wires the mouse layer to the HUD at startup (#3239): clicks and drags go
 * to the click targets, a selection copies with OSC 52, and the text under a
 * selection is read from Ink's last frame. Wheel events are left to
 * useMouseScroll.
 */

import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { handleMouse, setSelectionIO } from "./click-targets.js";
import { installMouse, onMouse } from "./mouse-input.js";

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI escapes
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** OSC 52: the terminal puts the text on the system clipboard. */
export function osc52(text: string): string {
	return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}

export function startMouse(): boolean {
	const inst = installMouse();
	if (!inst) return false;
	let lastFrame: () => string = () => "";
	// Ink keeps its last frame on the instance; the instances map is not in
	// its exports, so it is loaded by file. Without it, selection copies nothing.
	try {
		const req = createRequire(import.meta.url);
		const dir = path.dirname(req.resolve("ink"));
		void import(pathToFileURL(path.join(dir, "instances.js")).href).then((m) => {
			const instances = m.default as WeakMap<object, { lastOutput?: string }>;
			lastFrame = () => (instances.get(process.stdout)?.lastOutput ?? "").replace(ANSI, "");
		});
	} catch {
		/* no selection copy */
	}
	setSelectionIO(
		() => lastFrame(),
		(text) => {
			try {
				process.stdout.write(osc52(text));
			} catch {
				/* stdout closed */
			}
		},
	);
	onMouse((e) => {
		if (e.kind !== "wheel" && e.kind !== "move") handleMouse(e);
	});
	return true;
}
