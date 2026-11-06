/**
 * Web tools ask first (privacy lockdown). web_search sends the query and
 * web_fetch sends the URL off the device, so in every mode below Infinite they
 * need a yes from the person, and the prompt defaults to No. With no one to ask
 * (headless) they are refused unless EIGHT_HEADLESS_APPROVE=1 is set.
 */
import { requestTuiApproval } from "./tui-approval-channel";

interface WebAsker {
	isInfiniteMode(): boolean;
	requestPermission(
		action: string,
		details: string,
		command?: string,
		opts?: { defaultNo?: boolean },
	): Promise<boolean>;
}

/** Null when the call may run, else the refusal text handed back to the model. */
export async function webApprovalRefusal(
	pm: WebAsker,
	toolName: "web_search" | "web_fetch",
	target: string,
): Promise<string | null> {
	if (pm.isInfiniteMode()) return null;
	const what = toolName === "web_search" ? "Search the web for" : "Fetch the page";
	const details = `${what}: ${target.slice(0, 300)}. This leaves your device.`;
	const card = await requestTuiApproval({ action: "Web request", details });
	let approved = card === true;
	// A No on the card is final; only "no card shown" (null) falls through to the manager.
	if (card === null) {
		const interactive = !!process.stdin.isTTY && !process.env.EIGHT_HEADLESS;
		// Only an interactive prompt may default to No outright; headless goes through
		// the permission manager's opt-in check.
		approved = await pm.requestPermission("Web request", details, undefined, {
			defaultNo: interactive,
		});
	}
	return approved
		? null
		: `[PERMISSION DENIED] ${toolName} was not run: it sends data off the device and was not approved. Nothing was done. Do not retry this call; answer from what is local.`;
}
