/**
 * The policy context a `desktop_*` tool call is evaluated under.
 *
 * Every desktop tool is gated as the `desktop_use` action class, and the
 * rules in packages/permissions/default-policies.yaml key on the `action`
 * (and, for key presses, `keys`) field built here. Both callers - the agent's
 * ToolExecutor (packages/eight/tools.ts) and the daemon's hands channel
 * (packages/daemon/tools/hands.ts) - use this one map, so the two paths can
 * no longer gate the same tool under different names (#3213: the executor
 * checked `computer_use`, which has no rules, and fell through to allow).
 *
 * An unknown desktop tool maps to its own name, which no allow rule lists,
 * so the engine's desktop default (ask the person) applies.
 */
export const DESKTOP_POLICY_ACTION = "desktop_use";

export function desktopPolicyContext(
	tool: string,
	input: Record<string, unknown>,
): Record<string, unknown> {
	switch (tool) {
		case "desktop_screenshot":
			return { action: "screenshot" };
		case "desktop_click":
			return { action: "click" };
		case "desktop_type":
			return { action: "type" };
		case "desktop_press":
			return { action: "press", keys: input.keys };
		case "desktop_scroll":
			return { action: "scroll" };
		case "desktop_drag":
			return { action: "drag" };
		case "desktop_hover":
			return { action: "hover" };
		case "desktop_windows":
		case "desktop_list_apps":
			return { action: "window_list" };
		case "desktop_clipboard":
			return {
				action: input.action === "set" ? "clipboard_set" : "clipboard_get",
			};
		case "desktop_processes":
			return { action: "list_processes" };
		case "desktop_quit_app":
			return { action: "quit_app" };
		case "desktop_suggest_quit":
			return { action: "suggest_quit" };
		case "desktop_safe_list":
			return { action: "safe_list" };
		case "desktop_accessibility_tree":
			return { action: "screenshot" }; // read-only equivalent under default policy
		default:
			return { action: tool };
	}
}
