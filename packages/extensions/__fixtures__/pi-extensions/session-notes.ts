// @ts-nocheck - a Pi extension using lifecycle and UI APIs 8gent accepts but does not run.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async () => {});
	pi.registerShortcut("ctrl+shift+n", { description: "Notes", handler: async () => {} });
	pi.registerCommand("jot", {
		description: "Show notes",
		handler: async (_a, ctx) => ctx.ui.notify("no notes"),
	});
}
