// @ts-nocheck - a folder Pi extension (index.ts plus a relative helper).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stamp } from "./lib";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("stamp", {
		description: "Stamp text",
		handler: async (a, ctx) => ctx.ui.notify(stamp(a)),
	});
}
