// @ts-nocheck - a Pi extension with an npm dependency; 8gent never installs one.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import leftPad from "left-pad";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("pad", { handler: async (a, ctx) => ctx.ui.notify(leftPad(a, 5)) });
}
