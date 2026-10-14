// @ts-nocheck - a Pi extension, typed against Pi's own package, which 8gent does not install.
// Written to Pi's documented API: examples/extensions/permission-gate.ts (tool_call can block).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const dangerous = [/\brm\s+(-rf?|--recursive)/i, /\bsudo\b/i];
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const command = String(event.input.command);
		if (!dangerous.some((p) => p.test(command))) return undefined;
		if (!ctx.hasUI)
			return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
		const ok = await ctx.ui.confirm("Dangerous command", command);
		return ok ? undefined : { block: true, reason: "Blocked by user" };
	});
}
