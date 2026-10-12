/**
 * The desktop approval card (8SO, #4057). Pure text so it is testable:
 * what will happen, where, the exact text for a `type`, and the screen
 * around the point. The card is shown to the person and nowhere else; what
 * gets logged is `desktopApprovalDetails`, which never carries typed text.
 */
import type { DesktopActApproval } from "./desktop-act";

export function desktopApprovalCard(req: DesktopActApproval, reason: string): string {
	const lines = [
		`${req.attempt > 1 ? "AGAIN, target moved: " : ""}${req.action.replace("_", " ")} ${req.target}`,
		`at screen point (${req.point.x}, ${req.point.y}), grounder confidence ${req.confidence}`,
	];
	if (req.keys) lines.push(`keys: ${req.keys}`);
	if (req.action === "type") lines.push(`will type exactly: ${JSON.stringify(req.text ?? "")}`);
	lines.push(reason);
	if (req.crop) lines.push(req.crop);
	return lines.join("\n");
}

/** The loggable summary: no typed text, no crop. */
export function desktopApprovalDetails(req: DesktopActApproval, reason: string): string {
	const { text: _text, crop: _crop, ...safe } = req;
	return `${reason} Tool: desktop_act ${JSON.stringify(safe)}`;
}

/** Strip typed text from desktop tool args before they are logged. */
export function redactDesktopArgs(args: Record<string, unknown>): Record<string, unknown> {
	if (typeof args.text !== "string") return args;
	const { text, ...rest } = args;
	return { ...rest, textLength: (text as string).length };
}
