/**
 * TUI approval channel.
 *
 * Bridge between PermissionManager (historically blocks on
 * stdin/readline) and any frontend that wants to render approvals
 * itself instead - in particular the V2 TUI's InlineApprovalPrompt.
 *
 * Lifecycle:
 *   1. Frontend boots and calls `registerTuiApprovalHandler(fn)` with
 *      a function that returns a Promise<TuiApprovalDecision>.
 *   2. PermissionManager.requestPermission hits the interactive prompt
 *      branch -> calls `requestTuiApproval(...)` which returns a
 *      Promise<boolean | null>.
 *   3. If the handler is null (headless, CI, legacy chrome), we return
 *      null and PermissionManager falls back to its existing
 *      stdin/readline behavior. Headless wins by default.
 *
 * Lives in packages/permissions because the consumer is here. Frontends
 * just register their handler at boot.
 */

/** "unfit": a `full` request did not fit on screen and was not shown; yes/no callers read it as no. */
export type TuiApprovalDecision = "approve" | "deny" | "edit" | "skip" | "unfit";

export interface TuiApprovalRequest {
	action: string;
	details: string;
	command?: string;
	/** Show `command` in full, never cut; else the frontend answers "unfit" (#3474). */
	full?: boolean;
}

export type TuiApprovalHandler = (
	request: TuiApprovalRequest,
) => Promise<TuiApprovalDecision>;

let handler: TuiApprovalHandler | null = null;

export function registerTuiApprovalHandler(fn: TuiApprovalHandler | null): void {
	handler = fn;
}

export function hasTuiApprovalHandler(): boolean {
	return handler != null;
}

/** The frontend's decision, or null when there is no handler or it failed. */
export async function requestTuiDecision(
	request: TuiApprovalRequest,
): Promise<TuiApprovalDecision | null> {
	if (!handler) return null;
	try {
		return await handler(request);
	} catch {
		return null;
	}
}

export async function requestTuiApproval(
	request: TuiApprovalRequest,
): Promise<boolean | null> {
	const decision = await requestTuiDecision(request);
	return decision === null ? null : decision === "approve";
}

/** Test-only: clear the registered handler. */
export function _resetTuiApprovalChannel(): void {
	handler = null;
}
