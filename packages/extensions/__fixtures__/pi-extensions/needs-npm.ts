// @ts-nocheck - a Pi extension with an npm dependency; 8gent never installs one.

import leftPad from "left-pad";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("pad", { handler: async (a, ctx) => ctx.ui.notify(leftPad(a, 5)) });
}
