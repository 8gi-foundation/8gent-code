// @ts-nocheck - a Pi extension, typed against Pi's own package, which 8gent does not install.
// Written to Pi's documented API: docs/extensions.md "Create and load an extension".
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("greet", {
		description: "Show a greeting",
		handler: async (name, ctx) => {
			ctx.ui.notify(`Hello, ${name || "world"}! (in ${ctx.cwd})`, "info");
		},
	});
}
